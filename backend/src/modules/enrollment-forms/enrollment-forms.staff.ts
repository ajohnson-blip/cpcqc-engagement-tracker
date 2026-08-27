/**
 * Staff-side read model for enrollment forms.
 *
 * The public service (enrollment-forms.service.ts) is about one hospital
 * filing one form. This is about the question CPCQC actually asks between
 * Nov 15 and Dec 1: who was supposed to enroll, who has, and who hasn't yet.
 *
 * "Supposed to" is derived, not stored. For SPARK/SOAR/NEST it is the set of
 * hospitals accepted for that initiative on their interest form; for TTT it is
 * the hospitals already in a TtT cohort, since continuation is statutory and
 * nobody accepts them into it. That derivation is the whole point of the
 * screen — an outstanding list assembled by hand from two other tabs is how
 * hospitals get missed in the last week of the window.
 *
 * Read-only by design. Staff do not edit a hospital's enrollment: it is the
 * record that satisfies the statute, and editing it on the hospital's behalf
 * would erase the distinction between what CPCQC was told and what CPCQC
 * decided. Corrections go back through the hospital's own edit link.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import type { AuthContext } from '@/middleware/auth.js';
import { ENROLLABLE, type Champion, type InitiativeCode } from './enrollment-forms.service.js';

function assertStaff(ctx: AuthContext): void {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') {
    throw new HttpError(403, 'Staff only.');
  }
}

export interface StaffEnrollmentForm {
  id: string;
  programYear: number;
  hospital: { id: string; name: string };
  initiativeCode: InitiativeCode;
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  ehr: string | null;
  ehrOther: string | null;
  champions: Champion[];
  tttContinuationAttested: boolean;
  submittedVia: 'portal' | 'public';
  /** Null until the submitter clicks the emailed link. */
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One initiative's picture: who owes a form, who has filed one. */
export interface EnrollmentCoverage {
  initiativeCode: InitiativeCode;
  /** Hospitals accepted for this initiative (TTT: hospitals continuing it). */
  expected: Array<{ id: string; name: string }>;
  /** Expected hospitals with a submitted form, verified or not. */
  submittedCount: number;
  /** Expected hospitals with nothing filed — the chase list. */
  outstanding: Array<{ id: string; name: string }>;
  /**
   * Forms from hospitals not on the expected list. Not an error: a hospital
   * can be accepted after the interest deadline, or a PM can wave one through.
   * Surfaced so the count never silently disagrees with the table below it.
   */
  unexpectedCount: number;
}

export interface StaffEnrollmentOverview {
  programYear: number;
  window: { opensAt: string | null; closesAt: string | null };
  forms: StaffEnrollmentForm[];
  coverage: EnrollmentCoverage[];
}

function shape(
  row: typeof schema.enrollmentForms.$inferSelect,
  hospitalName: string,
): StaffEnrollmentForm {
  return {
    id: row.id,
    programYear: row.programYear,
    hospital: { id: row.hospitalId, name: hospitalName },
    initiativeCode: row.initiativeCode as InitiativeCode,
    submitterName: row.submitterName,
    submitterRole: row.submitterRole,
    submitterEmail: row.submitterEmail,
    ehr: row.ehr,
    ehrOther: row.ehrOther,
    champions: (row.champions ?? []) as Champion[],
    tttContinuationAttested: row.tttContinuationAttested,
    submittedVia: row.submittedVia === 'portal' ? 'portal' : 'public',
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Hospitals already in a TtT cohort for the prior year.
 *
 * TtT runs two-year cohorts, so its enrollment form is an attestation of
 * continuation rather than a request to join. Those hospitals owe a form
 * without ever having been "accepted" for one.
 */
async function tttContinuingHospitalIds(programYear: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ hospitalId: schema.enrollments.hospitalId })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.cohorts.initiativeId))
    .innerJoin(schema.programYears, eq(schema.programYears.enrollmentId, schema.enrollments.id))
    .where(
      and(
        eq(schema.initiatives.code, 'TTT'),
        eq(schema.enrollments.status, 'enrolled'),
        eq(schema.programYears.year, programYear - 1),
      ),
    );
  return rows.map((r) => r.hospitalId);
}

export async function getStaffEnrollmentOverview(
  programYear: number,
  ctx: AuthContext,
): Promise<StaffEnrollmentOverview> {
  assertStaff(ctx);

  const [formRows, interestRows, window, tttIds] = await Promise.all([
    db
      .select()
      .from(schema.enrollmentForms)
      .where(eq(schema.enrollmentForms.programYear, programYear)),
    db
      .select({
        hospitalId: schema.annualInterestForms.hospitalId,
        decidedInitiatives: schema.annualInterestForms.decidedInitiatives,
      })
      .from(schema.annualInterestForms)
      .where(eq(schema.annualInterestForms.programYear, programYear)),
    db.query.enrollmentWindows.findFirst({
      where: eq(schema.enrollmentWindows.programYear, programYear),
    }),
    tttContinuingHospitalIds(programYear),
  ]);

  // One lookup for every hospital either side of the comparison, so an
  // outstanding hospital that has filed nothing still has a name to show.
  const hospitalIds = Array.from(
    new Set([
      ...formRows.map((f) => f.hospitalId),
      ...interestRows.map((r) => r.hospitalId),
      ...tttIds,
    ]),
  );
  const hospitals = hospitalIds.length
    ? await db
        .select({ id: schema.hospitals.id, name: schema.hospitals.name })
        .from(schema.hospitals)
        .where(inArray(schema.hospitals.id, hospitalIds))
    : [];
  const nameById = new Map(hospitals.map((h) => [h.id, h.name]));
  const named = (id: string) => ({ id, name: nameById.get(id) ?? 'Unknown hospital' });

  const forms = formRows
    .map((r) => shape(r, nameById.get(r.hospitalId) ?? 'Unknown hospital'))
    .sort(
      (a, b) =>
        a.hospital.name.localeCompare(b.hospital.name) ||
        a.initiativeCode.localeCompare(b.initiativeCode),
    );

  const acceptedByInitiative = new Map<string, Set<string>>();
  for (const row of interestRows) {
    for (const code of (row.decidedInitiatives ?? []) as string[]) {
      if (!acceptedByInitiative.has(code)) acceptedByInitiative.set(code, new Set());
      acceptedByInitiative.get(code)!.add(row.hospitalId);
    }
  }

  const coverage: EnrollmentCoverage[] = ENROLLABLE.map((code) => {
    const expectedIds =
      code === 'TTT' ? new Set(tttIds) : (acceptedByInitiative.get(code) ?? new Set<string>());
    const filedIds = new Set(
      forms.filter((f) => f.initiativeCode === code).map((f) => f.hospital.id),
    );
    const outstanding = [...expectedIds].filter((id) => !filedIds.has(id)).map(named);
    outstanding.sort((a, b) => a.name.localeCompare(b.name));
    const expected = [...expectedIds].map(named);
    expected.sort((a, b) => a.name.localeCompare(b.name));
    return {
      initiativeCode: code,
      expected,
      submittedCount: [...filedIds].filter((id) => expectedIds.has(id)).length,
      outstanding,
      unexpectedCount: [...filedIds].filter((id) => !expectedIds.has(id)).length,
    };
  });

  return {
    programYear,
    window: {
      opensAt: window?.enrollmentOpensAt ?? null,
      closesAt: window?.enrollmentClosesAt ?? null,
    },
    forms,
    coverage,
  };
}
