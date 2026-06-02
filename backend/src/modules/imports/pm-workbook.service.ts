/**
 * PM-engagement-data importer — the reusable service.
 *
 * Reads a PM workbook (produced by `build_pm_data_entry.py`) and maps each row
 * into the matching TaskInstance update:
 *
 *   - Enrollment Forms    → TaskInstance with task_type=enrollment_form,
 *                           period=YYYY-annual. Side effects: enrollment
 *                           status flips eligible_to_enroll → enrolled,
 *                           hospital_staff_members upserted.
 *   - Meeting Attendance  → meeting_attendance, period=YYYY-Qx (derived from
 *                           meeting date). Annual Forum credits ALL the
 *                           hospital's active enrollments.
 *   - QI Advising         → qi_advising, period=YYYY-Qx.
 *   - Data Submissions    → data_submission, period=row period (e.g. 2026-01,
 *                           2026-Q1).
 *   - HRA Completions     → readiness_assessment, period=row period.
 *
 * Idempotent: re-running updates the same TaskInstances; duplicate rows are
 * safe. No deletes — to undo a row, edit the TaskInstance directly in the UI.
 *
 * Called by:
 *   - scripts/import-pm-engagement-data.ts (CLI wrapper)
 *   - POST /staff/imports/pm-workbook (admin upload endpoint)
 */
import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { quarterOf } from '@/utils/period.js';
import { effectiveHraQuarters, hraScheduleOverrideFor } from '@/modules/compliance/hra.js';
import { computeCurrentStageForEnrollment } from '@/modules/stages/stage-resolver.js';

export interface PmImportResult {
  dryRun: boolean;
  counts: { applied: number; skipped: number };
  errors: Array<{ sheet: string; rowNumber: number; reason: string }>;
  stagesChanged: number;
  /** Enrollment IDs that had at least one row applied — useful for the caller. */
  touchedEnrollmentIds: string[];
  /** Sheet names that were expected but not present in the workbook. */
  missingSheets: string[];
}

// ---------- Cell helpers ----------

/**
 * Recursively unwrap an ExcelJS cell value to a plain string. Handles strings,
 * numbers, dates, rich-text runs ({ richText: [{ text, ... }] }), hyperlinks
 * ({ text, hyperlink }), formula results ({ result, ... }), AND the nested
 * shape produced when a hyperlink's display text is itself rich-text
 * (e.g. mailto: cells in the PM workbooks).
 */
function extractText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj['richText'])) {
      return (obj['richText'] as Array<{ text?: unknown }>)
        .map((r) => extractText(r.text))
        .join('');
    }
    if ('text' in obj) return extractText(obj['text']);
    if ('result' in obj) return extractText(obj['result']);
  }
  return String(v);
}

function cellString(cell: ExcelJS.Cell): string {
  return extractText(cell.value).trim();
}

function isExampleRow(notes: string): boolean {
  return /example row/i.test(notes);
}

function normalizeDate(s: string): string | null {
  if (!s) return null;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // M/D/YYYY or MM/DD/YYYY
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const [, mo, d, y] = m;
    return `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  // Excel might also produce "YYYY-MM-DDTHH:MM:SS" or similar
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1]!;
  return null;
}

function quarterOfDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCFullYear()}-Q${quarterOf(d)}`;
}

// ---------- Lookups ----------

interface Lookups {
  initiativesByCode: Map<string, string>;
  hospitalsByName: Map<string, string>;
}

async function loadLookups(): Promise<Lookups> {
  const inits = await db.select().from(schema.initiatives);
  const hosps = await db.select().from(schema.hospitals);
  return {
    initiativesByCode: new Map(inits.map((i) => [i.code, i.id])),
    hospitalsByName: new Map(hosps.map((h) => [h.name.toLowerCase(), h.id])),
  };
}

async function findActiveEnrollment(
  hospitalId: string,
  initiativeId: string,
  track: 'active' | 'sustainability',
  year: number,
): Promise<typeof schema.enrollments.$inferSelect | null> {
  // Find cohorts of this initiative+track whose start_date..end_date covers `year`.
  const cohorts = await db
    .select()
    .from(schema.cohorts)
    .where(and(eq(schema.cohorts.initiativeId, initiativeId), eq(schema.cohorts.track, track)));
  const matching = cohorts.filter((c) => {
    const start = new Date(c.startDate).getUTCFullYear();
    const end = new Date(c.endDate).getUTCFullYear();
    return year >= start && year <= end;
  });
  if (matching.length === 0) return null;
  // Find enrollment for this hospital in any matching cohort
  for (const c of matching) {
    const e = await db.query.enrollments.findFirst({
      where: and(
        eq(schema.enrollments.hospitalId, hospitalId),
        eq(schema.enrollments.cohortId, c.id),
      ),
    });
    if (e) return e;
  }
  return null;
}

async function findTaskInstance(
  enrollmentId: string,
  taskType: typeof schema.taskTemplates.$inferSelect.taskType,
  period: string,
): Promise<typeof schema.taskInstances.$inferSelect | null> {
  const rows = await db
    .select({ ti: schema.taskInstances })
    .from(schema.taskInstances)
    .innerJoin(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
    )
    .where(
      and(
        eq(schema.taskInstances.enrollmentId, enrollmentId),
        eq(schema.taskInstances.period, period),
        eq(schema.taskTemplates.taskType, taskType),
      ),
    )
    .limit(1);
  return rows[0]?.ti ?? null;
}

async function updateTaskInstance(
  ti: typeof schema.taskInstances.$inferSelect,
  patch: {
    status?: 'complete' | 'current_activities' | 'needs_revision';
    outcome?: 'on_time' | 'late' | 'attended' | 'missed' | null;
    completedOn?: string | null;
    payload?: Record<string, unknown>;
    attachmentUrl?: string | null;
    staffNote?: string | null;
  },
  actorNote: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(schema.taskInstances)
    .set({
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.outcome !== undefined && { outcome: patch.outcome }),
      ...(patch.completedOn !== undefined && { completedOn: patch.completedOn }),
      ...(patch.payload !== undefined && { payload: patch.payload }),
      ...(patch.attachmentUrl !== undefined && { attachmentUrl: patch.attachmentUrl }),
      ...(patch.staffNote !== undefined && { staffNote: patch.staffNote }),
      updatedBy: 'pm-data-importer',
      updatedAt: now,
    })
    .where(eq(schema.taskInstances.id, ti.id));

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: null,
    actorRole: 'system_import',
    action: 'task.import',
    entityType: 'task_instance',
    entityId: ti.id,
    diff: { from: { status: ti.status }, to: { status: patch.status ?? ti.status } },
    note: actorNote,
  });
}

async function upsertHospitalStaffMember(
  hospitalId: string,
  initiativeId: string,
  name: string,
  role: string | null,
  email: string | null = null,
): Promise<void> {
  const existing = await db
    .select()
    .from(schema.hospitalStaffMembers)
    .where(
      and(
        eq(schema.hospitalStaffMembers.hospitalId, hospitalId),
        eq(schema.hospitalStaffMembers.initiativeId, initiativeId),
        sql`lower(${schema.hospitalStaffMembers.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (role && existing[0]!.role !== role) patch['role'] = role;
    if (email && existing[0]!.email !== email) patch['email'] = email;
    if (Object.keys(patch).length > 1) {
      await db
        .update(schema.hospitalStaffMembers)
        .set(patch)
        .where(eq(schema.hospitalStaffMembers.id, existing[0]!.id));
    }
    return;
  }
  await db.insert(schema.hospitalStaffMembers).values({
    id: uuid(),
    hospitalId,
    initiativeId,
    name,
    role,
    email,
  });
}

// ---------- Per-sheet processors ----------

interface RowError {
  sheet: string;
  rowNumber: number;
  reason: string;
}

interface Counts {
  applied: number;
  skipped: number;
}

interface ProcessContext {
  lookups: Lookups;
  errors: RowError[];
  counts: Counts;
  dryRun: boolean;
  /** Enrollment IDs that had at least one row applied; used for the
   *  post-import stage-advancement pass. */
  touchedEnrollments: Set<string>;
}

const VALID_INITIATIVES = new Set(['TTT', 'SPARK', 'SOAR', 'NEST']);
const VALID_TRACKS = new Set<'active' | 'sustainability'>(['active', 'sustainability']);

function readRows(
  sheet: ExcelJS.Worksheet,
  headerRow = 1,
): Array<{ rowNumber: number; cells: string[] }> {
  const rows: Array<{ rowNumber: number; cells: string[] }> = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellString(cell);
    });
    // Skip entirely empty rows
    if (cells.every((c) => !c)) return;
    rows.push({ rowNumber, cells });
  });
  return rows;
}

/**
 * Map of "Header Cell Text" → 0-based column index for the cells[] array. Lets
 * processors look up fields by header name instead of by hard-coded position,
 * which is what we need because the two PM workbooks (TTT vs. SOAR/SPARK/NEST)
 * use different Enrollment Forms column layouts.
 */
function buildHeaderMap(sheet: ExcelJS.Worksheet, headerRow = 1): Map<string, number> {
  const map = new Map<string, number>();
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const v = cellString(cell);
    if (v) map.set(v, col - 1);
  });
  return map;
}

function readCellByHeader(
  cells: string[],
  headerMap: Map<string, number>,
  header: string,
): string | undefined {
  const idx = headerMap.get(header);
  if (idx === undefined) return undefined;
  return cells[idx] || undefined;
}

/**
 * Auto-detect which row is the header on PM-workbook data sheets. Some sheets
 * (HRA Completions, Meeting Attendance, Data Submissions) ship with a row-1
 * instruction banner from time to time — and the next workbook release will
 * drop it again. Rather than flipping the header constant by hand, look for
 * the first row in the top three that contains the `requiredColumn` cell.
 */
function detectHeaderRow(
  sheet: ExcelJS.Worksheet,
  requiredColumn = 'Hospital',
): number {
  for (let r = 1; r <= 3; r++) {
    const row = sheet.getRow(r);
    let found = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cellString(cell) === requiredColumn) found = true;
    });
    if (found) return r;
  }
  return 1;
}

function validateBasics(
  ctx: ProcessContext,
  sheet: string,
  rowNumber: number,
  initiative: string,
  track: string,
  hospital: string,
): { initiativeId: string; track: 'active' | 'sustainability'; hospitalId: string } | null {
  if (!VALID_INITIATIVES.has(initiative)) {
    ctx.errors.push({ sheet, rowNumber, reason: `Unknown initiative "${initiative}"` });
    return null;
  }
  if (!VALID_TRACKS.has(track as 'active' | 'sustainability')) {
    ctx.errors.push({ sheet, rowNumber, reason: `Unknown track "${track}"` });
    return null;
  }
  const initiativeId = ctx.lookups.initiativesByCode.get(initiative);
  if (!initiativeId) {
    ctx.errors.push({
      sheet,
      rowNumber,
      reason: `Initiative "${initiative}" not in database — run db:seed first`,
    });
    return null;
  }
  const hospitalId = ctx.lookups.hospitalsByName.get(hospital.toLowerCase());
  if (!hospitalId) {
    ctx.errors.push({
      sheet,
      rowNumber,
      reason: `Hospital "${hospital}" not in database — names must match the Hospital Roster sheet exactly`,
    });
    return null;
  }
  return { initiativeId, track: track as 'active' | 'sustainability', hospitalId };
}

/**
 * Per-workbook champion-slot definitions. Each slot describes one possible
 * staff-roster entry on the Enrollment Forms sheet. We use header-driven lookup
 * so a single processor handles both PM workbook layouts:
 *  - TTT workbook (14 cols): Clinical Lead, QI Champion, Primary Contact
 *  - SOAR/SPARK/NEST workbook (19 cols): L&D, Data, Provider + 2 Other Champions
 *
 * Only slots whose nameHeader is present in the actual workbook's row-1 header
 * are considered; other slots silently skip. New roles can be added by listing
 * another entry here — no positional-destructuring update needed.
 */
interface ChampionSlotDef {
  nameHeader: string;
  emailHeader?: string;
  /** For Other Champion slots — read the role string from this header's cell. */
  roleHeader?: string;
  /** For named slots — fixed role string. */
  fixedRole?: string;
  /** Key under task_instances.payload. */
  payloadKey: string;
}

const ENROLLMENT_CHAMPION_SLOTS: ChampionSlotDef[] = [
  // TTT workbook layout
  { nameHeader: 'Clinical Lead Name', emailHeader: 'Clinical Lead Email', fixedRole: 'Clinical Lead', payloadKey: 'clinicalLead' },
  { nameHeader: 'QI Champion Name', emailHeader: 'QI Champion Email', fixedRole: 'QI Champion', payloadKey: 'qiChampion' },
  { nameHeader: 'Primary Contact Name', emailHeader: 'Primary Contact Email', fixedRole: 'Primary Contact', payloadKey: 'primaryContact' },
  // SOAR/SPARK/NEST workbook layout
  { nameHeader: 'L&D Champion Name', emailHeader: 'L&D Champion Email', fixedRole: 'L&D Champion', payloadKey: 'ldChampion' },
  { nameHeader: 'Data Champion Name', emailHeader: 'Data Champion Email', fixedRole: 'Data Champion', payloadKey: 'dataChampion' },
  { nameHeader: 'Provider Champion Name', emailHeader: 'Provider Champion Email', fixedRole: 'Provider Champion', payloadKey: 'providerChampion' },
  { nameHeader: 'Other Champion #1 Name', emailHeader: 'Other Champion #1 Email', roleHeader: 'Other Champion #1 Role', payloadKey: 'otherChampion1' },
  { nameHeader: 'Other Champion #2 Name', emailHeader: 'Other Champion #2 Email', roleHeader: 'Other Champion #2 Role', payloadKey: 'otherChampion2' },
];

async function processEnrollmentForms(ctx: ProcessContext, sheet: ExcelJS.Worksheet) {
  const SHEET = 'Enrollment Forms';
  // Look up every field by header name so the same processor works for both
  // the TTT (Clinical Lead / QI Champion / Primary Contact) and the
  // SOAR/SPARK/NEST (L&D / Data / Provider / Other Champion ×2) layouts.
  const headerMap = buildHeaderMap(sheet);
  for (const { rowNumber, cells } of readRows(sheet)) {
    const get = (h: string) => readCellByHeader(cells, headerMap, h);
    const hospital = get('Hospital');
    const initiative = get('Initiative');
    const track = get('Track');
    const programYearStr = get('Program Year');
    const submittedDateRaw = get('Submitted Date');
    const ehrSystem = get('EHR System');
    const implementationSite = get('Implementation Site');
    const notes = get('Notes');

    if (isExampleRow(notes ?? '')) continue;
    const basics = validateBasics(ctx, SHEET, rowNumber, initiative ?? '', track ?? '', hospital ?? '');
    if (!basics) continue;
    const year = parseInt(programYearStr ?? '', 10);
    if (!year || year < 2025 || year > 2100) {
      ctx.errors.push({ sheet: SHEET, rowNumber, reason: `Invalid Program Year "${programYearStr}"` });
      continue;
    }
    const enrollment = await findActiveEnrollment(basics.hospitalId, basics.initiativeId, basics.track, year);
    if (!enrollment) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `No enrollment found for hospital × ${initiative}/${track} × year ${year}. Approve the Interest Form first or check cohort dates.`,
      });
      continue;
    }
    const period = `${year}-annual`;
    const ti = await findTaskInstance(enrollment.id, 'enrollment_form', period);
    if (!ti) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `No enrollment_form TaskInstance for period ${period}. Did you run db:import-templates?`,
      });
      continue;
    }
    const submittedDate = normalizeDate(submittedDateRaw ?? '');

    // Gather champions: walk every defined slot and pick up the ones the
    // workbook actually has a column for and a non-empty name in this row.
    interface Champion { name: string; role: string | null; email: string | null; payloadKey: string }
    const champions: Champion[] = [];
    for (const slot of ENROLLMENT_CHAMPION_SLOTS) {
      if (!headerMap.has(slot.nameHeader)) continue;
      const name = readCellByHeader(cells, headerMap, slot.nameHeader);
      if (!name) continue;
      let email = slot.emailHeader ? readCellByHeader(cells, headerMap, slot.emailHeader) ?? null : null;
      let role =
        slot.fixedRole ?? (slot.roleHeader ? readCellByHeader(cells, headerMap, slot.roleHeader) ?? null : null);
      // Defensive: when a PM enters the email into an Other Champion's Role
      // column and leaves Email blank, recover the email rather than store it
      // as the role. Only fires for cell-sourced roles (fixed-role slots like
      // Clinical Lead have role pre-set and are unaffected).
      if (slot.roleHeader && !email && role && role.includes('@')) {
        email = role;
        role = null;
      }
      champions.push({ name, role, email, payloadKey: slot.payloadKey });
    }

    const payload: Record<string, unknown> = {};
    if (implementationSite) payload['implementationSite'] = implementationSite;
    if (ehrSystem) payload['ehrSystem'] = ehrSystem;
    for (const c of champions) {
      payload[c.payloadKey] = {
        name: c.name,
        ...(c.role ? { role: c.role } : {}),
        ...(c.email ? { email: c.email } : {}),
      };
    }
    if (notes && !isExampleRow(notes)) payload['notes'] = notes;

    if (ctx.dryRun) {
      ctx.counts.applied += 1;
      continue;
    }

    await updateTaskInstance(
      ti,
      {
        status: 'complete',
        completedOn: submittedDate ?? new Date().toISOString().slice(0, 10),
        payload,
        staffNote: notes && !isExampleRow(notes) ? notes : null,
      },
      `Backfilled from PM workbook (Enrollment Forms row ${rowNumber})`,
    );
    ctx.touchedEnrollments.add(enrollment.id);

    // Side effect: enrollment becomes active.
    if (enrollment.status === 'eligible_to_enroll') {
      await db
        .update(schema.enrollments)
        .set({ status: 'enrolled', updatedAt: new Date() })
        .where(eq(schema.enrollments.id, enrollment.id));
    }
    // Upsert hospital staff roster from whichever champions this workbook supplied.
    for (const c of champions) {
      await upsertHospitalStaffMember(
        basics.hospitalId,
        basics.initiativeId,
        c.name,
        c.role,
        c.email,
      );
    }
    ctx.counts.applied += 1;
  }
}

async function processMeetingAttendance(ctx: ProcessContext, sheet: ExcelJS.Worksheet) {
  const SHEET = 'Meeting Attendance';
  // Autodetect header row — workbook releases sometimes prepend an instruction
  // banner (row 1 = banner, row 2 = header); other releases ship just the
  // header on row 1.
  for (const { rowNumber, cells } of readRows(sheet, detectHeaderRow(sheet))) {
    // Columns (6): Hospital, Initiative, Track, Meeting Month (YYYY-MM),
    // Meeting Type, Notes.
    const [hospital, initiative, track, meetingMonthRaw, meetingType, notes] = cells;
    if (isExampleRow(notes ?? '')) continue;
    const meetingMonth = (meetingMonthRaw ?? '').trim();
    // Accept either YYYY-MM (e.g., "2026-02") or YYYY-MM-DD (e.g., "2026-02-12").
    // Excel cells formatted as dates serialize to ISO YYYY-MM-DD via cellString();
    // some PMs also typed first-of-month dates as a convenience. Both are valid.
    const dateMatch = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(meetingMonth);
    if (!dateMatch) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `Invalid Meeting Month "${meetingMonthRaw}" — use YYYY-MM (e.g., 2026-02) or YYYY-MM-DD.`,
      });
      continue;
    }
    const year = parseInt(dateMatch[1]!, 10);
    const monthStr = dateMatch[2]!;
    const monthNum = parseInt(monthStr, 10);
    // Derive both periods. Active cohorts use monthly templates ("2026-01");
    // SOAR sustainability still uses quarterly ("2026-Q1").
    const qNum = Math.ceil(monthNum / 3);
    const monthlyPeriod = `${year}-${monthStr}`;
    const quarterlyPeriod = `${year}-Q${qNum}`;
    // If a full date was supplied, use it as the meetingDate. Otherwise, use
    // end-of-month as the canonical completedOn (the importer treats this as
    // the recorded date of the attendance event).
    let meetingDate: string;
    if (dateMatch[3]) {
      meetingDate = `${year}-${monthStr}-${dateMatch[3]}`;
    } else {
      const monthEndDays: Record<number, number> = { 1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 };
      meetingDate = `${year}-${monthStr}-${String(monthEndDays[monthNum] ?? 28).padStart(2, '0')}`;
    }

    const isAnnualForum = (meetingType ?? '').toLowerCase() === 'annual forum';

    const hospitalId = ctx.lookups.hospitalsByName.get((hospital ?? '').toLowerCase());
    if (!hospitalId) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `Hospital "${hospital}" not in database`,
      });
      continue;
    }

    // For Annual Forum: credit every active enrollment the hospital has.
    // For Monthly Cohort: credit just the matching (initiative, track) enrollment.
    const targetEnrollments: Array<typeof schema.enrollments.$inferSelect> = [];
    if (isAnnualForum) {
      const allEnrollments = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.hospitalId, hospitalId));
      for (const e of allEnrollments) {
        if (e.status === 'withdrawn') continue;
        targetEnrollments.push(e);
      }
      if (targetEnrollments.length === 0) {
        ctx.errors.push({
          sheet: SHEET,
          rowNumber,
          reason: `Hospital has no active enrollments to credit annual forum to`,
        });
        continue;
      }
    } else {
      const basics = validateBasics(ctx, SHEET, rowNumber, initiative ?? '', track ?? '', hospital ?? '');
      if (!basics) continue;
      const enrollment = await findActiveEnrollment(basics.hospitalId, basics.initiativeId, basics.track, year);
      if (!enrollment) {
        ctx.errors.push({
          sheet: SHEET,
          rowNumber,
          reason: `No enrollment for hospital × ${initiative}/${track} × year ${year}`,
        });
        continue;
      }
      targetEnrollments.push(enrollment);
    }

    for (const enrollment of targetEnrollments) {
      // Active cohorts use monthly templates; sustainability still uses quarterly.
      const cohortForTrack = await db.query.cohorts.findFirst({
        where: eq(schema.cohorts.id, enrollment.cohortId),
      });
      const period = cohortForTrack?.track === 'sustainability' ? quarterlyPeriod : monthlyPeriod;

      const ti = await findTaskInstance(enrollment.id, 'meeting_attendance', period);
      if (!ti) {
        ctx.errors.push({
          sheet: SHEET,
          rowNumber,
          reason: `No meeting_attendance TaskInstance for ${enrollment.id} period ${period}`,
        });
        continue;
      }

      // Monthly active model: one task per month, status='complete' + outcome='attended'
      // when the hospital attended any meeting that month. Sustainability still uses
      // the legacy "attendances array" structure since multiple per quarter are possible.
      const isMonthly = cohortForTrack?.track !== 'sustainability';
      let newPayload: Record<string, unknown>;
      if (isMonthly) {
        newPayload = {
          meetingDate,
          type: meetingType || 'Monthly Cohort',
          ...(notes ? { notes } : {}),
          source: 'pm-backfill',
        };
      } else {
        const existingPayload = (ti.payload as Record<string, unknown> | null) ?? {};
        const previousAttendances = Array.isArray(existingPayload['attendances'])
          ? (existingPayload['attendances'] as unknown[])
          : [];
        newPayload = {
          ...existingPayload,
          attendances: [
            ...previousAttendances,
            {
              meetingDate,
              type: meetingType || 'Monthly Cohort',
              ...(notes ? { notes } : {}),
              source: 'pm-backfill',
            },
          ],
        };
      }

      if (ctx.dryRun) {
        ctx.counts.applied += 1;
        continue;
      }
      await updateTaskInstance(
        ti,
        {
          status: 'complete',
          outcome: isMonthly ? 'attended' : undefined,
          completedOn: meetingDate,
          payload: newPayload,
        },
        `Backfilled from PM workbook (Meeting Attendance row ${rowNumber}${isAnnualForum ? ', annual forum cross-credit' : ''})`,
      );
      ctx.touchedEnrollments.add(enrollment.id);
      ctx.counts.applied += 1;
    }
  }
}

async function processQiAdvising(ctx: ProcessContext, sheet: ExcelJS.Worksheet) {
  const SHEET = 'QI Advising';
  for (const { rowNumber, cells } of readRows(sheet)) {
    const [hospital, initiative, track, sessionDateRaw, quarterRaw, advisor, attendeesRaw, notes] = cells;
    if (isExampleRow(notes ?? '')) continue;
    const sessionDate = normalizeDate(sessionDateRaw ?? '');
    if (!sessionDate) {
      ctx.errors.push({ sheet: SHEET, rowNumber, reason: `Invalid session date "${sessionDateRaw}"` });
      continue;
    }
    const basics = validateBasics(ctx, SHEET, rowNumber, initiative ?? '', track ?? '', hospital ?? '');
    if (!basics) continue;
    const year = new Date(sessionDate + 'T00:00:00Z').getUTCFullYear();
    const enrollment = await findActiveEnrollment(basics.hospitalId, basics.initiativeId, basics.track, year);
    if (!enrollment) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `No enrollment for ${hospital} × ${initiative}/${track}`,
      });
      continue;
    }
    const period =
      quarterRaw && /^\d{4}-Q[1-4]$/.test(quarterRaw) ? quarterRaw : quarterOfDate(sessionDate);
    const ti = await findTaskInstance(enrollment.id, 'qi_advising', period);
    if (!ti) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `No qi_advising TaskInstance for period ${period}`,
      });
      continue;
    }
    const attendees = (attendeesRaw ?? '')
      .split(/[;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const payload: Record<string, unknown> = { sessionDate, advisorName: advisor };
    if (attendees.length) payload['attendees'] = attendees;
    if (notes) payload['notes'] = notes;

    if (ctx.dryRun) {
      ctx.counts.applied += 1;
      continue;
    }
    await updateTaskInstance(
      ti,
      { status: 'complete', completedOn: sessionDate, payload },
      `Backfilled from PM workbook (QI Advising row ${rowNumber})`,
    );
    ctx.touchedEnrollments.add(enrollment.id);
    ctx.counts.applied += 1;
  }
}

async function processDataSubmissions(ctx: ProcessContext, sheet: ExcelJS.Worksheet) {
  // Data is captured in REDCap, so the workbook only tracks that the survey
  // was submitted for the given period — no attachment URL is collected here.
  // Header row is autodetected because workbook releases vary on whether a
  // row-1 instruction banner is included.
  const SHEET = 'Data Submissions';
  for (const { rowNumber, cells } of readRows(sheet, detectHeaderRow(sheet))) {
    const [hospital, initiative, track, periodRaw, submittedDateRaw, statusRaw, notes] = cells;
    if (isExampleRow(notes ?? '')) continue;
    if (!periodRaw) {
      ctx.errors.push({ sheet: SHEET, rowNumber, reason: `Missing period` });
      continue;
    }
    const basics = validateBasics(ctx, SHEET, rowNumber, initiative ?? '', track ?? '', hospital ?? '');
    if (!basics) continue;
    // Normalize period: accept YYYY-MM, YYYY-Qx, or YYYY-MM-DD (Excel dates).
    // TaskInstance periods are stored as YYYY-MM (monthly cadence) or YYYY-Qx
    // (quarterly cadence) — a YYYY-MM-DD from an Excel date cell needs to be
    // collapsed to its containing month.
    let period: string;
    const dateMatch = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(periodRaw);
    const quarterMatch = /^(\d{4})-Q[1-4]$/.exec(periodRaw);
    if (dateMatch) {
      period = `${dateMatch[1]}-${dateMatch[2]}`;
    } else if (quarterMatch) {
      period = periodRaw;
    } else {
      ctx.errors.push({ sheet: SHEET, rowNumber, reason: `Period "${periodRaw}" malformed` });
      continue;
    }
    // Year = the period's leading 4 digits
    const yearMatch = /^(\d{4})-/.exec(period);
    if (!yearMatch) {
      ctx.errors.push({ sheet: SHEET, rowNumber, reason: `Period "${period}" malformed` });
      continue;
    }
    const year = parseInt(yearMatch[1]!, 10);
    const enrollment = await findActiveEnrollment(basics.hospitalId, basics.initiativeId, basics.track, year);
    if (!enrollment) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `No enrollment for ${hospital} × ${initiative}/${track} × ${year}`,
      });
      continue;
    }
    const ti = await findTaskInstance(enrollment.id, 'data_submission', period);
    if (!ti) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `No data_submission TaskInstance for period ${period} (does the template exist for this cadence?)`,
      });
      continue;
    }
    // PM workbook uses the simpler "complete" / "incomplete" vocabulary.
    // Map "incomplete" → "current_activities" (the in-progress state) so
    // compliance treats it as not-yet-met without flagging revision-needed.
    // Also accept the schema's native values for backward compatibility.
    const raw = (statusRaw ?? '').trim().toLowerCase();
    let status: 'complete' | 'current_activities' | 'needs_revision';
    if (raw === 'complete') status = 'complete';
    else if (raw === 'incomplete' || raw === 'current_activities') status = 'current_activities';
    else if (raw === 'needs_revision') status = 'needs_revision';
    else status = 'complete'; // default: assume a row exists because something was submitted
    const submittedDate = normalizeDate(submittedDateRaw ?? '');
    const payload: Record<string, unknown> = { periodCovered: period, source: 'REDCap' };
    if (notes) payload['notes'] = notes;

    if (ctx.dryRun) {
      ctx.counts.applied += 1;
      continue;
    }
    await updateTaskInstance(
      ti,
      {
        status,
        completedOn: status === 'complete' ? submittedDate ?? new Date().toISOString().slice(0, 10) : null,
        payload,
        attachmentUrl: null,
      },
      `Backfilled from PM workbook (Data Submissions row ${rowNumber})`,
    );
    ctx.touchedEnrollments.add(enrollment.id);
    ctx.counts.applied += 1;
  }
}

async function processHraCompletions(ctx: ProcessContext, sheet: ExcelJS.Worksheet) {
  // HRA responses are captured in REDCap; the workbook only tracks completion.
  // Header row is autodetected because some workbook releases include a row-1
  // instruction banner ("SOAR sustainability hospitals only ...") and others
  // ship the header on row 1 with no banner.
  const SHEET = 'HRA Completions';
  for (const { rowNumber, cells } of readRows(sheet, detectHeaderRow(sheet))) {
    const [hospital, initiative, track, periodRaw, completedDateRaw, notes] = cells;
    if (isExampleRow(notes ?? '')) continue;
    if (!periodRaw) {
      ctx.errors.push({ sheet: SHEET, rowNumber, reason: `Missing period` });
      continue;
    }
    // SPARK 2026's first HRA is due in Q2, not the standard Q1 (see the
    // program_years.hra_schedule override). A PM occasionally enters that HRA
    // under Q1 by mistake — remap to the first scheduled HRA quarter so it
    // matches the generated TaskInstance.
    let period = periodRaw ?? '';
    if (initiative === 'SPARK' && track === 'active') {
      const [firstHraQuarter] = effectiveHraQuarters(hraScheduleOverrideFor('SPARK', 2026));
      if (period === '2026-Q1') {
        period = `2026-${firstHraQuarter}`;
      }
    }
    // HRAs now exist on all tracks: SOAR sustainability (Q1+Q4) was the original;
    // every initiative/track has two HRAs (default Q1+Q4); SPARK active is Q2+Q4
    // in 2026. Rely on the TaskInstance lookup below to flag unknown combinations.
    const basics = validateBasics(ctx, SHEET, rowNumber, initiative ?? '', track ?? '', hospital ?? '');
    if (!basics) continue;
    const yearMatch = /^(\d{4})-/.exec(period);
    if (!yearMatch) {
      ctx.errors.push({ sheet: SHEET, rowNumber, reason: `Period "${period}" malformed` });
      continue;
    }
    const year = parseInt(yearMatch[1]!, 10);
    const enrollment = await findActiveEnrollment(basics.hospitalId, basics.initiativeId, basics.track, year);
    if (!enrollment) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `No ${track} enrollment for ${hospital} × ${initiative}`,
      });
      continue;
    }
    const ti = await findTaskInstance(enrollment.id, 'readiness_assessment', period);
    if (!ti) {
      ctx.errors.push({
        sheet: SHEET,
        rowNumber,
        reason: `No readiness_assessment TaskInstance for period ${period}`,
      });
      continue;
    }
    const completedDate = normalizeDate(completedDateRaw ?? '');
    const payload: Record<string, unknown> = { period, source: 'REDCap' };
    if (notes) payload['notes'] = notes;

    if (ctx.dryRun) {
      ctx.counts.applied += 1;
      continue;
    }
    await updateTaskInstance(
      ti,
      {
        status: 'complete',
        completedOn: completedDate ?? new Date().toISOString().slice(0, 10),
        payload,
        attachmentUrl: null,
      },
      `Backfilled from PM workbook (HRA Completions row ${rowNumber})`,
    );
    ctx.touchedEnrollments.add(enrollment.id);
    ctx.counts.applied += 1;
  }
}

// ---------- Stage sync ----------

/**
 * After the bulk import, sync every touched enrollment's `current_stage_id`
 * to whatever the calendar says it should be (gated by enrollment-form
 * completion). Uses the shared stage-resolver — see
 * src/modules/stages/stage-resolver.ts. Date-driven: a hospital with a
 * completed Enrollment Form in May 2026 lands at Implementation Q2,
 * regardless of how much Q1 work was backfilled.
 */
async function syncStagesFor(
  enrollmentIds: Iterable<string>,
  dryRun: boolean,
): Promise<{ changed: number }> {
  let changed = 0;
  const now = new Date();
  for (const enrollmentId of enrollmentIds) {
    const enrollment = await db.query.enrollments.findFirst({
      where: eq(schema.enrollments.id, enrollmentId),
    });
    if (!enrollment) continue;

    const resolved = await computeCurrentStageForEnrollment(enrollmentId, now);
    if (!resolved || resolved.stageId === enrollment.currentStageId) continue;
    changed += 1;
    if (dryRun) continue;

    await db
      .update(schema.enrollments)
      .set({ currentStageId: resolved.stageId, updatedAt: new Date() })
      .where(eq(schema.enrollments.id, enrollmentId));
    await db.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId: null,
      actorRole: 'system_import',
      action: 'enrollment.stage_changed',
      entityType: 'enrollment',
      entityId: enrollmentId,
      diff: { to: { currentStageId: resolved.stageId } },
      note: `Synced after import (date-driven): → "${resolved.stageName}", EF complete: ${resolved.enrollmentFormComplete}`,
    });
  }
  return { changed };
}

// ---------- Public entry point ----------

/**
 * Drive a PM workbook through every sheet processor and return a structured
 * result. Pure data in / data out — no console I/O, no process.exit, no DB
 * connection management (the caller owns the pool's lifetime).
 *
 * Throws only if loadLookups fails or there are zero initiative rows (which
 * means seed never ran). Per-row failures are collected into result.errors.
 */
export async function importPmWorkbook(
  workbook: ExcelJS.Workbook,
  opts: { dryRun: boolean },
): Promise<PmImportResult> {
  const lookups = await loadLookups();
  if (lookups.initiativesByCode.size === 0) {
    throw new Error('No initiatives in database. Run `npm run db:seed` first.');
  }

  const ctx: ProcessContext = {
    lookups,
    errors: [],
    counts: { applied: 0, skipped: 0 },
    dryRun: opts.dryRun,
    touchedEnrollments: new Set<string>(),
  };

  const handlers: Array<[string, (ctx: ProcessContext, ws: ExcelJS.Worksheet) => Promise<void>]> = [
    ['Enrollment Forms', processEnrollmentForms],
    ['Meeting Attendance', processMeetingAttendance],
    ['QI Advising', processQiAdvising],
    ['Data Submissions', processDataSubmissions],
    ['HRA Completions', processHraCompletions],
  ];

  const missingSheets: string[] = [];
  for (const [sheetName, handler] of handlers) {
    const ws = workbook.getWorksheet(sheetName);
    if (!ws) {
      missingSheets.push(sheetName);
      continue;
    }
    await handler(ctx, ws);
  }

  // Post-pass: sync each touched enrollment's stage to the calendar.
  // Date-driven, gated only by Enrollment Form completion. See
  // src/modules/stages/stage-resolver.ts.
  let stagesChanged = 0;
  if (ctx.touchedEnrollments.size > 0) {
    const result = await syncStagesFor(ctx.touchedEnrollments, opts.dryRun);
    stagesChanged = result.changed;
  }

  return {
    dryRun: opts.dryRun,
    counts: ctx.counts,
    errors: ctx.errors,
    stagesChanged,
    touchedEnrollmentIds: Array.from(ctx.touchedEnrollments),
    missingSheets,
  };
}
