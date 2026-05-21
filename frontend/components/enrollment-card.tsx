import Link from 'next/link';
import { Mail } from 'lucide-react';
import { ComplianceTile } from './compliance-tile';
import { RequirementStatusPill } from './status-pill';
import type { InitiativeTeam, MyEnrollment } from '@/lib/types';

export function EnrollmentCard({ enrollment }: { enrollment: MyEnrollment }) {
  const initiative = enrollment.initiative;
  const compliance = enrollment.currentProgramYear;

  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <div className="h-1.5 w-full bg-cpcqc-pink" />

      <div className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              {initiative?.emoji && <span aria-hidden className="text-2xl">{initiative.emoji}</span>}
              <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
                {initiative?.name ?? 'Unknown initiative'}
              </h2>
            </div>
            <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
              {enrollment.cohort?.label}
              {enrollment.cohort?.track === 'sustainability' && (
                <span className="ml-2 inline-flex items-center rounded-full bg-cpcqc-teal/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-teal-dark">
                  Sustainability
                </span>
              )}
            </p>
            {enrollment.currentStage && (
              <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
                Current stage:{' '}
                <span className="font-semibold text-cpcqc-purple-dark">
                  {enrollment.currentStage.name}
                </span>
              </p>
            )}
          </div>
          {compliance && (
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-cpcqc-purple-dark/60">
                Program year {compliance.programYear}
              </p>
              <div className="mt-1">
                <RequirementStatusPill status={compliance.result.overall} />
              </div>
            </div>
          )}
        </div>

        {compliance ? (
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ComplianceTile
              label="Enrollment"
              result={compliance.result.enrollment}
              boolean
              // Enrollment is a yes/no — surface "X of Y peers complete" via the meetings
              // benchmark's peersTotal field would be misleading; instead reuse the same
              // benchmark numerics if available.
              benchmark={enrollment.cohortBenchmark?.meetings ?? null}
            />
            <ComplianceTile
              label="Meetings"
              result={compliance.result.meetings}
              benchmark={enrollment.cohortBenchmark?.meetings ?? null}
            />
            <ComplianceTile
              label="QI Advising"
              result={compliance.result.advising}
              benchmark={enrollment.cohortBenchmark?.advising ?? null}
            />
            <ComplianceTile
              label="Data Submissions"
              result={compliance.result.dataSubmissions}
              benchmark={enrollment.cohortBenchmark?.dataSubmissions ?? null}
            />
            {compliance.result.assessments && (
              <ComplianceTile
                label="Readiness Assessments"
                result={compliance.result.assessments}
                benchmark={enrollment.cohortBenchmark?.assessments ?? null}
              />
            )}
          </div>
        ) : (
          <p className="mt-5 rounded-lg bg-cpcqc-cream-dark/40 p-4 text-sm text-cpcqc-purple-dark/70">
            No program year data yet for this enrollment.
          </p>
        )}

        {enrollment.team && (enrollment.team.programManagers.length > 0 || enrollment.team.qiAdvisors.length > 0) && (
          <TeamContactRow team={enrollment.team} />
        )}

        <div className="mt-5 flex justify-end">
          <Link
            href={`/portal/enrollments/${enrollment.enrollmentId}`}
            className="rounded-full border border-cpcqc-purple/30 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple transition hover:bg-cpcqc-purple hover:text-white"
          >
            View tasks →
          </Link>
        </div>
      </div>
    </div>
  );
}

function TeamContactRow({ team }: { team: InitiativeTeam }) {
  return (
    <div className="mt-5 rounded-xl bg-cpcqc-cream-dark/40 p-4">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
        Your CPCQC contacts for {team.initiativeCode}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {team.programManagers.length > 0 && (
          <ContactBlock label="Program Manager" members={team.programManagers} />
        )}
        {team.qiAdvisors.length > 0 && (
          <ContactBlock label="QI Advisor" members={team.qiAdvisors} />
        )}
      </div>
    </div>
  );
}

function ContactBlock({
  label,
  members,
}: {
  label: string;
  members: InitiativeTeam['programManagers'];
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">{label}</p>
      {members.map((m) => (
        <p key={m.userId} className="mt-0.5 text-sm">
          <span className="font-semibold text-cpcqc-purple-dark">{m.fullName}</span>{' '}
          <a
            href={`mailto:${m.email}`}
            className="ml-1 inline-flex items-center gap-0.5 text-cpcqc-purple hover:underline"
          >
            <Mail size={12} aria-hidden />
            <span className="text-xs">email</span>
          </a>
        </p>
      ))}
    </div>
  );
}
