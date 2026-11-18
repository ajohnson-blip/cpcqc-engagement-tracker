/**
 * Who owes an enrollment form, per initiative, and who has filed one.
 *
 * A hospital owes a form when CPCQC accepted it for that initiative on its
 * interest form, when it is continuing TtT, or when staff sent it the form.
 * The last source exists for hospitals with no interest form to accept: without
 * it, a hospital CPCQC enrolls directly would file a form the chase list calls
 * unexpected, and would never show as outstanding if it didn't.
 *
 * Staff can take a hospital off an initiative's list (`withdrawn`), e.g. when
 * it switches initiatives before submitting. Until it files that form anyway,
 * that outranks every source above: it is neither counted nor chased.
 *
 * Pure, so it is testable without a database (the `@/` alias does not resolve
 * under vitest).
 */

export interface CoverageSource<C extends string> {
  codes: readonly C[];
  /** Submitted forms, verified or not. */
  filed: Array<{ hospitalId: string; initiativeCode: string }>;
  /** Interest-form decisions. Null means undecided. */
  accepted: Array<{ hospitalId: string; decidedInitiatives: string[] | null }>;
  /** Hospitals in a TtT cohort for the program year. */
  tttContinuing: string[];
  /** Forms staff sent from the enrollment-forms screen. */
  sent: Array<{ hospitalId: string; initiativeCode: string }>;
  /** Hospitals staff took off an initiative's list. */
  withdrawn?: Array<{ hospitalId: string; initiativeCode: string }>;
  nameOf: (hospitalId: string) => string;
}

export interface Coverage<C extends string> {
  initiativeCode: C;
  expected: Array<{ id: string; name: string }>;
  submittedCount: number;
  outstanding: Array<{ id: string; name: string }>;
  unexpectedCount: number;
  /** Taken off this initiative's list by staff, and not filed. */
  withdrawn: Array<{ id: string; name: string }>;
}

export function computeCoverage<C extends string>(src: CoverageSource<C>): Coverage<C>[] {
  const named = (id: string) => ({ id, name: src.nameOf(id) });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

  return src.codes.map((code) => {
    const expectedIds = new Set<string>(code === 'TTT' ? src.tttContinuing : []);
    for (const row of src.accepted) {
      if (row.decidedInitiatives?.includes(code)) expectedIds.add(row.hospitalId);
    }
    for (const s of src.sent) {
      if (s.initiativeCode === code) expectedIds.add(s.hospitalId);
    }
    const filedIds = new Set(
      src.filed.filter((f) => f.initiativeCode === code).map((f) => f.hospitalId),
    );
    // A hospital that files the form anyway is enrolling after all, so its
    // removal no longer applies: it counts like any other filed form.
    const withdrawnIds = new Set(
      (src.withdrawn ?? [])
        .filter((w) => w.initiativeCode === code && !filedIds.has(w.hospitalId))
        .map((w) => w.hospitalId),
    );
    for (const id of withdrawnIds) expectedIds.delete(id);
    return {
      initiativeCode: code,
      expected: [...expectedIds].map(named).sort(byName),
      submittedCount: [...filedIds].filter((id) => expectedIds.has(id)).length,
      outstanding: [...expectedIds].filter((id) => !filedIds.has(id)).map(named).sort(byName),
      unexpectedCount: [...filedIds].filter((id) => !expectedIds.has(id)).length,
      withdrawn: [...withdrawnIds].map(named).sort(byName),
    };
  });
}
