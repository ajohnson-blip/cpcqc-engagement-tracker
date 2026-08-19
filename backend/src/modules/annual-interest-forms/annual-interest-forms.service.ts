/**
 * Annual interest forms — step 1 of CPCQC's 2-step annual enrollment flow.
 *
 * Hospitals submit a single ranked preference form per program year; CPCQC
 * reviews in aggregate to set cohort size and mix, then sends the detailed
 * initiative-specific Enrollment Forms to accepted hospitals.
 *
 * One row per (programYear, hospitalId) via a unique index, so editable
 * resubmission within the open window is a natural UPDATE.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import { resolveActiveHospitalId, type AuthContext } from '@/middleware/auth.js';
import { env } from '@/config/env.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';

// ---------- Types + zod schemas ----------

export const RANKABLE_INITIATIVE_CODES = ['SPARK', 'SOAR', 'NEST'] as const;
export type RankableInitiativeCode = (typeof RANKABLE_INITIATIVE_CODES)[number];

const rankedInitiativeSchema = z.object({
  code: z.enum(RANKABLE_INITIATIVE_CODES),
  rank: z.number().int().min(1).max(RANKABLE_INITIATIVE_CODES.length),
});

export const submitInterestFormBodySchema = z.object({
  programYear: z.number().int().min(2026).max(2100),
  // 0 valid for TTT-continuation hospitals submitting "no additional initiatives requested."
  intendedInitiativeCount: z.number().int().min(0).max(2),
  // Length is per-hospital (a SOAR-sustainability hospital ranks 2, not 3),
  // so the exact set + permutation is validated in the service against the
  // hospital's eligible codes rather than pinned here.
  rankedInitiatives: z
    .array(rankedInitiativeSchema)
    .min(1)
    .max(RANKABLE_INITIATIVE_CODES.length),
  reasoning: z.record(z.string().min(1).max(2000)).refine(
    (obj) => Object.keys(obj).length <= RANKABLE_INITIATIVE_CODES.length,
    'Too many reasoning entries',
  ),
  // Submitter snapshot — captured at submit so historical records survive
  // a user delete or a role change.
  submitterName: z.string().trim().min(1).max(200),
  submitterRole: z.string().trim().min(1).max(200),
  submitterEmail: z.string().trim().email().max(254),
  // Active hospital for regional users (validated against their accessible
  // set). Omitted → the user's primary hospital.
  hospitalId: z.string().uuid().optional(),
});
export type SubmitInterestFormBody = z.infer<typeof submitInterestFormBodySchema>;

export const staffUpdateInterestFormBodySchema = z
  .object({
    staffNote: z.string().max(5000).nullable().optional(),
    status: z
      .enum(['submitted', 'under_review', 'accepted', 'declined'])
      .optional(),
    decidedInitiatives: z
      .array(z.enum(RANKABLE_INITIATIVE_CODES))
      .max(RANKABLE_INITIATIVE_CODES.length)
      .nullable()
      .optional(),
  })
  .refine(
    (obj) => Object.keys(obj).length > 0,
    'At least one field is required',
  );
export type StaffUpdateInterestFormBody = z.infer<
  typeof staffUpdateInterestFormBodySchema
>;

// ---------- Window helpers ----------

interface EnrollmentWindow {
  programYear: number;
  opensAt: string; // YYYY-MM-DD
  closesAt: string; // YYYY-MM-DD
}

export async function getEnrollmentWindow(
  programYear: number,
): Promise<EnrollmentWindow | null> {
  const row = await db.query.enrollmentWindows.findFirst({
    where: eq(schema.enrollmentWindows.programYear, programYear),
  });
  if (!row) return null;
  return {
    programYear: row.programYear,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
  };
}

/**
 * UTC-comparison of today vs the window's [opens, closes] dates (inclusive
 * on both ends). We use UTC because the dates in the DB are bare DATE values
 * with no time zone — comparing "today in Denver" vs "Oct 15" gets fuzzy at
 * midnight if we mix zones.
 */
export function isWindowOpen(
  window: EnrollmentWindow,
  asOf: Date = new Date(),
): boolean {
  const todayIso = asOf.toISOString().slice(0, 10);
  return todayIso >= window.opensAt && todayIso <= window.closesAt;
}

/**
 * Trinary window state. The frontend needs to distinguish "not yet open"
 * from "closed (past)" so the copy on the form + banner reads sensibly.
 * Returning just `isOpen: boolean` conflated those two — the form ended up
 * showing "closed on Oct 15" months before the window had opened.
 */
export type WindowState = 'before' | 'open' | 'after';
export function windowStateFor(
  window: EnrollmentWindow,
  asOf: Date = new Date(),
): WindowState {
  const todayIso = asOf.toISOString().slice(0, 10);
  if (todayIso < window.opensAt) return 'before';
  if (todayIso > window.closesAt) return 'after';
  return 'open';
}

// ---------- Eligibility ----------

/**
 * Is the hospital completing a SOAR sustainability year for `year`?
 * Sustainability is capped at one year by law (C.R.S. § 25-52-106.5), so
 * these hospitals cannot re-rank SOAR for the next year — after year-end
 * CPCQC either graduates them (metrics met) or reverts them to SOAR active
 * (metrics not met). That determination is CPCQC's and happens after the
 * 2026 program year closes, so the interest form can't resolve it; it just
 * removes SOAR from these hospitals' ranking options.
 */
async function isInSoarSustainability(
  hospitalId: string,
  year: number,
): Promise<boolean> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(
      schema.initiatives,
      eq(schema.initiatives.id, schema.cohorts.initiativeId),
    )
    .innerJoin(
      schema.programYears,
      eq(schema.programYears.enrollmentId, schema.enrollments.id),
    )
    .where(
      and(
        eq(schema.enrollments.hospitalId, hospitalId),
        eq(schema.initiatives.code, 'SOAR'),
        eq(schema.cohorts.track, 'sustainability'),
        eq(schema.enrollments.status, 'enrolled'),
        eq(schema.programYears.year, year),
      ),
    );
  return (rows[0]?.count ?? 0) > 0;
}

/**
 * The rankable initiatives a specific hospital may choose for `programYear`.
 * Starts from the global pool and removes any the hospital is locked out of —
 * currently just SOAR for hospitals completing a SOAR sustainability year in
 * (programYear - 1). The frontend computes the same set from /me/enrollments
 * for the form UI; this server-side copy is what submission is validated
 * against so the two can't drift.
 */
export async function eligibleRankableCodes(
  hospitalId: string,
  programYear: number,
): Promise<RankableInitiativeCode[]> {
  const inSoarSustain = await isInSoarSustainability(hospitalId, programYear - 1);
  return RANKABLE_INITIATIVE_CODES.filter(
    (c) => !(c === 'SOAR' && inSoarSustain),
  );
}

// ---------- Submit / upsert (hospital) ----------

/**
 * Upserts the hospital's interest form for the given program year. The
 * unique (programYear, hospitalId) index means resubmissions within the
 * window UPDATE in place, supporting the "editable until closes_at"
 * design without a status workflow.
 *
 * Authorization: caller must be a hospital_user / hospital_admin for the
 * hospital identified in `ctx`. The hospital is taken from auth, NOT the
 * request body, so a hospital user can't submit on behalf of another
 * hospital by tampering with the wire format.
 */
export async function submitAnnualInterestForm(
  body: unknown,
  ctx: AuthContext,
): Promise<{ form: InterestFormShape; wasUpdate: boolean }> {
  const parsed = submitInterestFormBodySchema.parse(body);

  if (ctx.role !== 'hospital_user' && ctx.role !== 'hospital_admin') {
    throw new HttpError(403, 'Only hospital users can submit interest forms.');
  }
  // Regional users submit for whichever hospital is active in the switcher;
  // resolveActiveHospitalId validates it's one they can access.
  const targetHospitalId = resolveActiveHospitalId(ctx, parsed.hospitalId);

  // Window check — submissions are rejected outside the open window. CPCQC
  // staff can still PATCH metadata (staff_note, status) post-close via the
  // staff routes; this guard only governs hospital submission.
  const window = await getEnrollmentWindow(parsed.programYear);
  if (!window) {
    throw new HttpError(
      400,
      `No enrollment window configured for ${parsed.programYear}.`,
    );
  }
  if (!isWindowOpen(window)) {
    throw new HttpError(
      400,
      `The ${parsed.programYear} interest window is not currently open.`,
    );
  }

  // The hospital must rank exactly its eligible set (global pool minus any
  // initiative it's locked out of, e.g. SOAR for a SOAR-sustainability
  // hospital). Computed server-side so a tampered request can't rank an
  // ineligible initiative.
  const eligible = await eligibleRankableCodes(targetHospitalId, parsed.programYear);
  const submittedCodes = parsed.rankedInitiatives.map((r) => r.code).sort();
  const eligibleSorted = [...eligible].sort();
  const sameSet =
    submittedCodes.length === eligibleSorted.length &&
    submittedCodes.every((c, i) => c === eligibleSorted[i]);
  if (!sameSet) {
    throw new HttpError(
      400,
      `rankedInitiatives must rank exactly your eligible initiative(s): ${eligibleSorted.join(', ')}.`,
    );
  }

  // Ranks must be a complete 1..N permutation over the eligible count.
  const ranks = parsed.rankedInitiatives.map((r) => r.rank).sort((a, b) => a - b);
  const expected = eligible.map((_, i) => i + 1);
  if (
    ranks.length !== expected.length ||
    !ranks.every((r, i) => r === expected[i])
  ) {
    throw new HttpError(
      400,
      'rankedInitiatives must use each rank from 1 to N exactly once.',
    );
  }

  // Reasoning required for whichever initiatives are ranked #1 and (when a
  // second exists) #2. A hospital with only one eligible initiative supplies
  // a single "why".
  const topByRank = new Map<number, string>();
  for (const r of parsed.rankedInitiatives) topByRank.set(r.rank, r.code);
  const topCode = topByRank.get(1);
  if (!topCode || !parsed.reasoning[topCode]?.trim()) {
    throw new HttpError(400, `Reasoning required for top choice (${topCode}).`);
  }
  const secondCode = topByRank.get(2);
  if (secondCode && !parsed.reasoning[secondCode]?.trim()) {
    throw new HttpError(
      400,
      `Reasoning required for second choice (${secondCode}).`,
    );
  }

  // Upsert by (programYear, hospitalId). Returning + onConflictDoUpdate keeps
  // it in a single round-trip.
  const now = new Date();
  const insert = {
    id: uuid(),
    programYear: parsed.programYear,
    hospitalId: targetHospitalId,
    submitterUserId: ctx.userId ?? null,
    submitterName: parsed.submitterName,
    submitterRole: parsed.submitterRole,
    submitterEmail: parsed.submitterEmail,
    intendedInitiativeCount: parsed.intendedInitiativeCount,
    rankedInitiatives: parsed.rankedInitiatives,
    reasoning: parsed.reasoning,
    createdAt: now,
    updatedAt: now,
  };

  // Drizzle's onConflictDoUpdate over a multi-column unique index needs the
  // target list; everything else is updated to the new values. status,
  // staff_note, decided_* are intentionally preserved across resubmits since
  // they describe CPCQC's view of the hospital, not the specific submission.
  const inserted = await db
    .insert(schema.annualInterestForms)
    .values(insert)
    .onConflictDoUpdate({
      target: [
        schema.annualInterestForms.programYear,
        schema.annualInterestForms.hospitalId,
      ],
      set: {
        submitterUserId: insert.submitterUserId,
        submitterName: insert.submitterName,
        submitterRole: insert.submitterRole,
        submitterEmail: insert.submitterEmail,
        intendedInitiativeCount: insert.intendedInitiativeCount,
        rankedInitiatives: insert.rankedInitiatives,
        reasoning: insert.reasoning,
        updatedAt: now,
      },
    })
    .returning();
  const row = inserted[0]!;
  const wasUpdate = row.createdAt.getTime() !== now.getTime();

  const shaped = await shapeRow(row.id);
  if (!shaped) throw new HttpError(500, 'Failed to fetch shaped row');

  // Fire-and-forget notification emails. Failures log but don't fail the
  // submit — the row is already saved.
  void sendSubmissionEmails(shaped, wasUpdate).catch(() => {
    // sendEmail already records to notifications + logs; nothing to do here.
  });

  return { form: shaped, wasUpdate };
}

// ---------- Get for current hospital (hospital portal) ----------

export async function getInterestFormForHospital(
  programYear: number,
  ctx: AuthContext,
  requestedHospitalId?: string,
): Promise<InterestFormShape | null> {
  if (ctx.hospitalIds.length === 0) return null;
  const hospitalId = resolveActiveHospitalId(ctx, requestedHospitalId);
  const row = await db.query.annualInterestForms.findFirst({
    where: and(
      eq(schema.annualInterestForms.programYear, programYear),
      eq(schema.annualInterestForms.hospitalId, hospitalId),
    ),
  });
  if (!row) return null;
  return await shapeRow(row.id);
}

// ---------- Staff list ----------

export interface StaffListFilters {
  programYear?: number;
  status?:
    | 'submitted'
    | 'under_review'
    | 'accepted'
    | 'declined';
}

export async function listInterestFormsForStaff(
  filters: StaffListFilters,
  ctx: AuthContext,
): Promise<InterestFormShape[]> {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') {
    throw new HttpError(403, 'Staff only.');
  }
  const where = [];
  if (filters.programYear !== undefined) {
    where.push(eq(schema.annualInterestForms.programYear, filters.programYear));
  }
  if (filters.status !== undefined) {
    where.push(eq(schema.annualInterestForms.status, filters.status));
  }
  const rows = await db
    .select()
    .from(schema.annualInterestForms)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(schema.annualInterestForms.updatedAt));
  const shapedAll: InterestFormShape[] = [];
  for (const r of rows) {
    const shaped = await shapeRow(r.id);
    if (shaped) shapedAll.push(shaped);
  }
  return shapedAll;
}

// ---------- Staff update (note, status, decided cohorts) ----------

export async function staffUpdateInterestForm(
  id: string,
  body: unknown,
  ctx: AuthContext,
): Promise<InterestFormShape> {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') {
    throw new HttpError(403, 'Staff only.');
  }
  const parsed = staffUpdateInterestFormBodySchema.parse(body);

  const existing = await db.query.annualInterestForms.findFirst({
    where: eq(schema.annualInterestForms.id, id),
  });
  if (!existing) throw new HttpError(404, 'Interest form not found');

  const now = new Date();
  // Use !== undefined so explicit null clears (same pattern as task notes).
  const update: Partial<typeof schema.annualInterestForms.$inferInsert> = {
    updatedAt: now,
  };
  if (parsed.staffNote !== undefined) update.staffNote = parsed.staffNote;
  if (parsed.status !== undefined) {
    update.status = parsed.status;
    // Stamp decision metadata when transitioning to accepted/declined.
    if (parsed.status === 'accepted' || parsed.status === 'declined') {
      update.decidedAt = now;
      update.decidedBy = ctx.userId ?? null;
    } else if (parsed.status === 'submitted' || parsed.status === 'under_review') {
      // Re-opening a decision clears the decision metadata so a later
      // accept/decline gets the new timestamp.
      update.decidedAt = null;
      update.decidedBy = null;
    }
  }
  if (parsed.decidedInitiatives !== undefined) {
    update.decidedInitiatives = parsed.decidedInitiatives;
  }

  await db
    .update(schema.annualInterestForms)
    .set(update)
    .where(eq(schema.annualInterestForms.id, id));

  const shaped = await shapeRow(id);
  if (!shaped) throw new HttpError(500, 'Failed to fetch shaped row');

  // Notify the hospital only on a genuine transition INTO accepted — not on
  // edits to an already-accepted form (e.g. tweaking decided cohorts), which
  // would re-send a near-duplicate email.
  if (parsed.status === 'accepted' && existing.status !== 'accepted') {
    void sendAcceptanceEmail(shaped).catch(() => {});
  }
  return shaped;
}

// ---------- Bulk accept ----------

const bulkAcceptBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  decidedInitiatives: z.array(z.enum(RANKABLE_INITIATIVE_CODES)).min(1).max(3),
});

/**
 * Accept many submissions into the same set of cohorts in one action — the
 * cohort-planning-meeting workflow ("assign these 12 hospitals to SPARK").
 * Overwrites each form's decided cohorts with the provided set, flips status
 * to accepted, and emails each hospital that wasn't already accepted.
 *
 * Overwrite (not merge) semantics keep this predictable: PMs group hospitals
 * by their final cohort assignment and run the action once per group. A
 * hospital getting SPARK+NEST goes in the [SPARK, NEST] batch.
 */
export async function bulkAcceptInterestForms(
  body: unknown,
  ctx: AuthContext,
): Promise<{ accepted: InterestFormShape[] }> {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') {
    throw new HttpError(403, 'Staff only.');
  }
  const parsed = bulkAcceptBodySchema.parse(body);

  // Snapshot prior statuses so we only email genuine transitions into accepted.
  const before = await db
    .select({
      id: schema.annualInterestForms.id,
      status: schema.annualInterestForms.status,
    })
    .from(schema.annualInterestForms)
    .where(inArray(schema.annualInterestForms.id, parsed.ids));
  const priorStatusById = new Map(before.map((r) => [r.id, r.status]));

  const now = new Date();
  await db
    .update(schema.annualInterestForms)
    .set({
      status: 'accepted',
      decidedInitiatives: parsed.decidedInitiatives,
      decidedAt: now,
      decidedBy: ctx.userId ?? null,
      updatedAt: now,
    })
    .where(inArray(schema.annualInterestForms.id, parsed.ids));

  const accepted: InterestFormShape[] = [];
  for (const id of parsed.ids) {
    const shaped = await shapeRow(id);
    if (!shaped) continue;
    accepted.push(shaped);
    if (priorStatusById.get(id) !== 'accepted') {
      void sendAcceptanceEmail(shaped).catch(() => {});
    }
  }
  return { accepted };
}

// ---------- Aggregate for Cohort Planning view ----------

export interface CohortPlanningAggregate {
  programYear: number;
  totalSubmissions: number;
  // Two semantically distinct buckets — the cohort context is independent
  // of submissions (size of the auto-continuation pool, etc.) while the
  // submission funnel is "what have hospitals told us so far?". Conflating
  // them was confusing pre-window: "Currently in TTT: 0" read as
  // "no TTT cohort exists" instead of "no submissions yet".
  cohortContext: {
    // Hospitals currently enrolled in TTT for (programYear - 1). These all
    // auto-continue into TTT (programYear), counts toward each one's
    // 2-initiative cap, and gets a TTT Enrollment Form sent on close date.
    tttContinuationCount: number;
    // Hospitals completing a SOAR sustainability year in (programYear - 1).
    // After year-end metrics, CPCQC graduates them or reverts them to SOAR
    // active. SOAR is removed from their ranking; they're pending review.
    soarSustainabilityCount: number;
  };
  // Everything below this line is derived from submissions; tiles read as
  // "of submissions so far…".
  intent: { 0: number; 1: number; 2: number };
  perInitiative: Array<{
    code: RankableInitiativeCode;
    rankCounts: Record<1 | 2 | 3, number>;
    totalInterested: number; // ranked anywhere (count for this code in any submission)
  }>;
  currentlyTTTSubmissionCount: number;
}

export async function getCohortPlanningAggregate(
  programYear: number,
  ctx: AuthContext,
): Promise<CohortPlanningAggregate> {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') {
    throw new HttpError(403, 'Staff only.');
  }

  const rows = await db
    .select()
    .from(schema.annualInterestForms)
    .where(eq(schema.annualInterestForms.programYear, programYear));

  // intent counts: { 0: N, 1: N, 2: N }
  const intent = { 0: 0, 1: 0, 2: 0 };
  for (const r of rows) {
    const c = r.intendedInitiativeCount;
    if (c === 0 || c === 1 || c === 2) intent[c] += 1;
  }

  // Per-initiative rank breakdown.
  const perInitiative: CohortPlanningAggregate['perInitiative'] = RANKABLE_INITIATIVE_CODES.map(
    (code) => ({
      code,
      rankCounts: { 1: 0, 2: 0, 3: 0 },
      totalInterested: 0,
    }),
  );
  for (const r of rows) {
    const ranked = (r.rankedInitiatives ?? []) as Array<{
      code: RankableInitiativeCode;
      rank: 1 | 2 | 3;
    }>;
    for (const entry of ranked) {
      const bucket = perInitiative.find((p) => p.code === entry.code);
      if (!bucket) continue;
      bucket.totalInterested += 1;
      if (entry.rank === 1 || entry.rank === 2 || entry.rank === 3) {
        bucket.rankCounts[entry.rank] += 1;
      }
    }
  }

  // Absolute TTT continuation count — every hospital currently enrolled in
  // TTT for (programYear - 1). This is cohort-planning context: independent
  // of whether anyone's submitted an interest form yet. PMs want to see
  // "we have 12 TTT continuations coming" from day one of the window.
  const tttContinuationRows = await db
    .select({ hospitalId: schema.enrollments.hospitalId })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(
      schema.initiatives,
      eq(schema.initiatives.id, schema.cohorts.initiativeId),
    )
    .innerJoin(
      schema.programYears,
      eq(schema.programYears.enrollmentId, schema.enrollments.id),
    )
    .where(
      and(
        eq(schema.initiatives.code, 'TTT'),
        eq(schema.enrollments.status, 'enrolled'),
        eq(schema.programYears.year, programYear - 1),
      ),
    );
  const tttContinuationHospitalSet = new Set(
    tttContinuationRows.map((r) => r.hospitalId),
  );
  const tttContinuationCount = tttContinuationHospitalSet.size;

  // Absolute SOAR-sustainability count — every hospital in a SOAR
  // sustainability cohort for (programYear - 1). Pending the post-year-end
  // graduate-vs-revert determination. Independent of submissions.
  const soarSustainRows = await db
    .select({ hospitalId: schema.enrollments.hospitalId })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(
      schema.initiatives,
      eq(schema.initiatives.id, schema.cohorts.initiativeId),
    )
    .innerJoin(
      schema.programYears,
      eq(schema.programYears.enrollmentId, schema.enrollments.id),
    )
    .where(
      and(
        eq(schema.initiatives.code, 'SOAR'),
        eq(schema.cohorts.track, 'sustainability'),
        eq(schema.enrollments.status, 'enrolled'),
        eq(schema.programYears.year, programYear - 1),
      ),
    );
  const soarSustainabilityCount = new Set(
    soarSustainRows.map((r) => r.hospitalId),
  ).size;

  // Submission-funnel slice: of the hospitals who submitted, how many are
  // in TTT? Useful for the "how many of our submissions are auto-continuers
  // vs net new" question; complements (doesn't replace) the absolute count.
  const currentlyTTTSubmissionCount = rows.filter((r) =>
    tttContinuationHospitalSet.has(r.hospitalId),
  ).length;

  return {
    programYear,
    totalSubmissions: rows.length,
    cohortContext: { tttContinuationCount, soarSustainabilityCount },
    intent,
    perInitiative,
    currentlyTTTSubmissionCount,
  };
}

// ---------- Shaped row + helpers ----------

export interface InterestFormShape {
  id: string;
  programYear: number;
  hospital: { id: string; name: string };
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  intendedInitiativeCount: number;
  rankedInitiatives: Array<{ code: RankableInitiativeCode; rank: number }>;
  reasoning: Record<string, string>;
  status: 'submitted' | 'under_review' | 'accepted' | 'declined';
  staffNote: string | null;
  decidedInitiatives: RankableInitiativeCode[] | null;
  decidedAt: string | null;
  flags: {
    currentlyEnrolledInTTT: boolean;
    // Completing a SOAR sustainability year in (programYear-1) — SOAR was
    // removed from their ranking; CPCQC reviews 2026 metrics after year-end
    // to graduate them or revert them to SOAR active.
    currentlyInSoarSustainability: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

async function shapeRow(id: string): Promise<InterestFormShape | null> {
  const row = await db.query.annualInterestForms.findFirst({
    where: eq(schema.annualInterestForms.id, id),
  });
  if (!row) return null;
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, row.hospitalId),
  });

  // Flag: is this hospital currently enrolled in TTT for (programYear - 1)?
  // Used by the staff triage UI to surface "⚠ currently in TTT — auto-continuation."
  const tttEnrolled = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(
      schema.initiatives,
      eq(schema.initiatives.id, schema.cohorts.initiativeId),
    )
    .innerJoin(
      schema.programYears,
      eq(schema.programYears.enrollmentId, schema.enrollments.id),
    )
    .where(
      and(
        eq(schema.enrollments.hospitalId, row.hospitalId),
        eq(schema.initiatives.code, 'TTT'),
        eq(schema.enrollments.status, 'enrolled'),
        eq(schema.programYears.year, row.programYear - 1),
      ),
    );

  const inSoarSustainability = await isInSoarSustainability(
    row.hospitalId,
    row.programYear - 1,
  );

  return {
    id: row.id,
    programYear: row.programYear,
    hospital: { id: row.hospitalId, name: hospital?.name ?? 'Unknown hospital' },
    submitterName: row.submitterName,
    submitterRole: row.submitterRole,
    submitterEmail: row.submitterEmail,
    intendedInitiativeCount: row.intendedInitiativeCount,
    rankedInitiatives: (row.rankedInitiatives ?? []) as Array<{
      code: RankableInitiativeCode;
      rank: number;
    }>,
    reasoning: (row.reasoning ?? {}) as Record<string, string>,
    status: row.status,
    staffNote: row.staffNote,
    decidedInitiatives: (row.decidedInitiatives ?? null) as
      | RankableInitiativeCode[]
      | null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    flags: {
      currentlyEnrolledInTTT: (tttEnrolled[0]?.count ?? 0) > 0,
      currentlyInSoarSustainability: inSoarSustainability,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------- Emails ----------

async function sendSubmissionEmails(form: InterestFormShape, wasUpdate: boolean) {
  // Confirmation to the submitter with the full submission so they have a
  // record without needing to sign back in. Plain-text formatted for now;
  // can swap to an HTML template later without changing the call site.
  const verb = wasUpdate ? 'updated' : 'received';
  const summary = formatSubmissionSummary(form);
  await sendEmail({
    toEmail: form.submitterEmail,
    subject: `CPCQC ${form.programYear} Interest Form — ${verb}`,
    kind: 'annual_interest.confirmation',
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    body:
      `Hi ${form.submitterName},\n\n` +
      `Your CPCQC Quality Improvement Initiative Interest form has been received and will be reviewed by CPCQC staff.\n\n` +
      `${wasUpdate ? `This replaces your earlier submission for ${form.hospital.name}.` : `Submitted for ${form.hospital.name}.`} ` +
      `A CPCQC program manager will follow up with the detailed initiative-specific Enrollment Forms for the cohorts you're accepted into.\n\n` +
      `Your submission:\n${summary}\n\n` +
      `You can update your submission until the window closes by signing in to the tracker and visiting the 2027 Interest page.\n\n` +
      `Questions? qi@cpcqc.org`,
  });

  // CPCQC staff notification. Same payload, plus the hospital name so the
  // PMs see who submitted at a glance.
  await sendEmail({
    toEmail: 'qi@cpcqc.org',
    subject: `[${form.programYear} Interest] ${form.hospital.name} ${verb} their submission`,
    kind: 'annual_interest.staff_notification',
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    body:
      `${form.hospital.name} (${form.submitterName}, ${form.submitterRole}) just ${verb} their ${form.programYear} interest form.\n\n` +
      `${summary}\n\n` +
      `Review at /staff/interest-forms`,
  });
}

/**
 * Acceptance notification to the hospital — fired on transition into accepted
 * (single or bulk). #3-Light: this tells the hospital their outcome and what
 * comes next; it does NOT auto-create enrollments (that's the deferred
 * heavier phase, gated on 2027 cohorts existing).
 */
async function sendAcceptanceEmail(form: InterestFormShape): Promise<void> {
  const cohorts = form.decidedInitiatives ?? [];
  const cohortLine =
    cohorts.length > 0
      ? `into the following initiative(s) for ${form.programYear}: ${cohorts.join(', ')}`
      : `for ${form.programYear}`;
  await sendEmail({
    toEmail: form.submitterEmail,
    subject: `CPCQC ${form.programYear} — ${form.hospital.name} has been accepted`,
    kind: 'annual_interest.accepted',
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    body:
      `Hi ${form.submitterName},\n\n` +
      `Good news — ${form.hospital.name} has been accepted ${cohortLine}.\n\n` +
      `What's next: CPCQC will follow up with the detailed, initiative-specific ` +
      `Enrollment Form(s) for each accepted initiative, along with onboarding ` +
      `details and key dates.\n\n` +
      `Questions? qi@cpcqc.org`,
  });
}

function formatSubmissionSummary(form: InterestFormShape): string {
  const ranked = [...form.rankedInitiatives]
    .sort((a, b) => a.rank - b.rank)
    .map((r) => {
      const reason = form.reasoning[r.code];
      const reasonLine = reason ? `\n    Why: ${reason}` : '';
      return `  ${r.rank}. ${r.code}${reasonLine}`;
    })
    .join('\n');
  // intent=0 only happens for TTT-continuation hospitals saying "I'm
  // continuing TTT, adding nothing else." Phrase it as an acknowledgement
  // rather than the awkward "0 additional initiative(s)".
  const intentLine =
    form.intendedInitiativeCount === 0
      ? `  Intent: continuing your existing enrollment(s) for ${form.programYear} — no additional initiatives requested`
      : `  Intent: ${form.intendedInitiativeCount} additional initiative(s) for ${form.programYear}`;
  return `${intentLine}\n  Rankings:\n${ranked}`;
}
