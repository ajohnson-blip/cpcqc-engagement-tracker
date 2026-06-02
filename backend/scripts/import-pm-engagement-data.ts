/**
 * Import PM-supplied engagement data for Jan–April 2026 (or any window).
 *
 * Reads the workbook produced by `build_pm_data_entry.py` (default location:
 * ../pm_engagement_data_jan_apr_2026.xlsx) and maps each row into the matching
 * TaskInstance update:
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
 * Usage:
 *   npm run db:import-pm-data
 *   npm run db:import-pm-data -- --dry-run
 *   npm run db:import-pm-data -- --file=/abs/path/to/file.xlsx
 */
import 'dotenv/config';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { quarterOf } from '../src/utils/period.js';
import { effectiveHraQuarters, hraScheduleOverrideFor } from '../src/modules/compliance/hra.js';
import { computeCurrentStageForEnrollment } from '../src/modules/stages/stage-resolver.js';

// ---------- CLI ----------

interface Args {
  file: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Record<string, string | boolean> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') out['dry-run'] = true;
    else {
      const m = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (m) out[m[1]!] = m[2]!;
    }
  }
  const defaultPath = path.resolve(
    process.cwd(),
    process.cwd().endsWith('/backend') ? '..' : '.',
    'pm_engagement_data_jan_apr_2026.xlsx',
  );
  return {
    file: typeof out['file'] === 'string' ? out['file'] : defaultPath,
    dryRun: out['dry-run'] === true,
  };
}

// ---------- Cell helpers ----------

function cellString(cell: ExcelJS.Cell): string {
  if (cell.value == null) return '';
  if (typeof cell.value === 'string') return cell.value.trim();
  if (typeof cell.value === 'number') return String(cell.value);
  if (cell.value instanceof Date) {
    // Render as ISO date (no time)
    return cell.value.toISOString().slice(0, 10);
  }
  if (typeof cell.value === 'object' && 'text' in cell.value) {
    return String((cell.value as { text: unknown }).text).trim();
  }
  if (typeof cell.value === 'object' && 'result' in (cell.value as object)) {
    return String((cell.value as { result: unknown }).result ?? '').trim();
  }
  return String(cell.value).trim();
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

async function processEnrollmentForms(ctx: ProcessContext, sheet: ExcelJS.Worksheet) {
  const SHEET = 'Enrollment Forms';
  for (const { rowNumber, cells } of readRows(sheet)) {
    // Columns (19) — no Submitted Date this year:
    //   Hospital, Initiative, Track, Program Year,
    //   L&D Champion Name, L&D Champion Email,
    //   Data Champion Name, Data Champion Email,
    //   Provider Champion Name, Provider Champion Email,
    //   Other Champion #1 Name, Role, Email,
    //   Other Champion #2 Name, Role, Email,
    //   EHR System, Implementation Site, Notes
    const [
      hospital,
      initiative,
      track,
      programYearStr,
      ldChampionName,
      ldChampionEmail,
      dataChampionName,
      dataChampionEmail,
      providerChampionName,
      providerChampionEmail,
      other1Name,
      other1Role,
      other1Email,
      other2Name,
      other2Role,
      other2Email,
      ehrSystem,
      implementationSite,
      notes,
    ] = cells;
    const submittedDateRaw = ''; // No column in 2026 workbook — treat as today.
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

    const championPayload = (name?: string, email?: string) =>
      name ? { name, ...(email ? { email } : {}) } : undefined;
    const otherChampionPayload = (name?: string, role?: string, email?: string) =>
      name
        ? { name, ...(role ? { role } : {}), ...(email ? { email } : {}) }
        : undefined;

    const payload: Record<string, unknown> = {};
    if (implementationSite) payload['implementationSite'] = implementationSite;
    if (ehrSystem) payload['ehrSystem'] = ehrSystem;
    const ld = championPayload(ldChampionName, ldChampionEmail);
    if (ld) payload['ldChampion'] = ld;
    const dc = championPayload(dataChampionName, dataChampionEmail);
    if (dc) payload['dataChampion'] = dc;
    const pc = championPayload(providerChampionName, providerChampionEmail);
    if (pc) payload['providerChampion'] = pc;
    const o1 = otherChampionPayload(other1Name, other1Role, other1Email);
    if (o1) payload['otherChampion1'] = o1;
    const o2 = otherChampionPayload(other2Name, other2Role, other2Email);
    if (o2) payload['otherChampion2'] = o2;
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
    // Upsert hospital staff roster from the five champion slots.
    const champions: Array<[string | undefined, string, string | undefined]> = [
      [ldChampionName, 'L&D Champion', ldChampionEmail],
      [dataChampionName, 'Data Champion', dataChampionEmail],
      [providerChampionName, 'Provider Champion', providerChampionEmail],
      [other1Name, other1Role || 'Other Champion #1', other1Email],
      [other2Name, other2Role || 'Other Champion #2', other2Email],
    ];
    for (const [name, role, email] of champions) {
      if (!name) continue;
      await upsertHospitalStaffMember(
        basics.hospitalId,
        basics.initiativeId,
        name,
        role,
        email || null,
      );
    }
    ctx.counts.applied += 1;
  }
}

async function processMeetingAttendance(ctx: ProcessContext, sheet: ExcelJS.Worksheet) {
  const SHEET = 'Meeting Attendance';
  // Sheet has a row-1 instruction banner; real header is on row 2.
  for (const { rowNumber, cells } of readRows(sheet, 2)) {
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
  // Sheet has a row-1 banner about Jan-Apr backfill defaults; header is row 2.
  const SHEET = 'Data Submissions';
  for (const { rowNumber, cells } of readRows(sheet, 2)) {
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
  // Sheet has a row-1 banner about Q1/Q4 + optional date; header is row 2.
  const SHEET = 'HRA Completions';
  for (const { rowNumber, cells } of readRows(sheet, 2)) {
    const [hospital, initiative, track, periodRaw, completedDateRaw, notes] = cells;
    if (isExampleRow(notes ?? '')) continue;
    if (!periodRaw) {
      ctx.errors.push({ sheet: SHEET, rowNumber, reason: `Missing period` });
      continue;
    }
    // SPARK 2026's first HRA is due in Q3, not the standard Q1 (see the
    // program_years.hra_schedule override). A PM occasionally enters that HRA
    // under an earlier quarter by mistake — remap any pre-Q3 SPARK 2026 entry to
    // the first scheduled HRA quarter so it matches the generated TaskInstance.
    let period = periodRaw ?? '';
    if (initiative === 'SPARK' && track === 'active') {
      const [firstHraQuarter] = effectiveHraQuarters(hraScheduleOverrideFor('SPARK', 2026));
      if (period === '2026-Q1' || period === '2026-Q2') {
        period = `2026-${firstHraQuarter}`;
      }
    }
    // HRAs now exist on all tracks: SOAR sustainability (Q1+Q4) was the original;
    // every initiative/track has two HRAs (default Q1+Q4); SPARK active is Q3+Q4
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

// ---------- Main ----------

async function main() {
  const args = parseArgs();
  // eslint-disable-next-line no-console
  console.log(`Reading ${args.file}${args.dryRun ? ' (dry run)' : ''}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.file);

  const lookups = await loadLookups();
  if (lookups.initiativesByCode.size === 0) {
    // eslint-disable-next-line no-console
    console.error('No initiatives in database. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const ctx: ProcessContext = {
    lookups,
    errors: [],
    counts: { applied: 0, skipped: 0 },
    dryRun: args.dryRun,
    touchedEnrollments: new Set<string>(),
  };

  const handlers: Array<[string, (ctx: ProcessContext, ws: ExcelJS.Worksheet) => Promise<void>]> = [
    ['Enrollment Forms', processEnrollmentForms],
    ['Meeting Attendance', processMeetingAttendance],
    ['QI Advising', processQiAdvising],
    ['Data Submissions', processDataSubmissions],
    ['HRA Completions', processHraCompletions],
  ];

  for (const [sheetName, handler] of handlers) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) {
      // eslint-disable-next-line no-console
      console.warn(`Sheet "${sheetName}" not found — skipping.`);
      continue;
    }
    // eslint-disable-next-line no-console
    console.log(`Processing ${sheetName}…`);
    await handler(ctx, ws);
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${args.dryRun ? 'Would have' : 'Did'} apply ${ctx.counts.applied} row update${
      ctx.counts.applied === 1 ? '' : 's'
    }.`,
  );

  // Post-pass: sync each touched enrollment's stage to the calendar.
  // Date-driven, gated only by Enrollment Form completion. See
  // src/modules/stages/stage-resolver.ts.
  if (ctx.touchedEnrollments.size > 0) {
    const { changed } = await syncStagesFor(ctx.touchedEnrollments, args.dryRun);
    // eslint-disable-next-line no-console
    console.log(
      `${args.dryRun ? 'Would change' : 'Changed'} ${changed} enrollment stage${changed === 1 ? '' : 's'} to match the calendar.`,
    );
  }

  if (ctx.errors.length) {
    // eslint-disable-next-line no-console
    console.error(`\nErrors (${ctx.errors.length}):`);
    for (const e of ctx.errors.slice(0, 40)) {
      // eslint-disable-next-line no-console
      console.error(`  [${e.sheet} row ${e.rowNumber}] ${e.reason}`);
    }
    if (ctx.errors.length > 40) {
      // eslint-disable-next-line no-console
      console.error(`  … and ${ctx.errors.length - 40} more.`);
    }
    process.exit(1);
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
