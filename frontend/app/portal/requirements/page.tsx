import { ClipboardCheck, Users, FileText, CalendarCheck, Database } from 'lucide-react';

export const metadata = {
  title: 'Required Annual Engagement Metrics — CPCQC',
};

const METRICS = [
  {
    icon: ClipboardCheck,
    title: 'Enrollment',
    body: 'Hospitals must sign a Data Use Agreement (DUA) with CPCQC and enroll in an active QI initiative annually.',
  },
  {
    icon: Users,
    title: 'Coaching',
    body: 'Attend at least one virtual or in-person QI coaching session per quarter (4 sessions annually).',
  },
  {
    icon: FileText,
    title: 'Survey completion',
    body: 'Submit at least two practice-related surveys (known as Hospital Readiness Assessments) per year for the chosen QI initiative.',
  },
  {
    icon: CalendarCheck,
    title: 'Meeting participation',
    body: 'Ensure at least one team representative attends at least 9 CPCQC-led meetings annually (including monthly initiative meetings or an in-person forum).',
  },
  {
    icon: Database,
    title: 'Data submission',
    body: 'Submit initiative-specific data, disaggregated by race, ethnicity, and payer, for at least 75% of reporting periods (monthly or quarterly, depending on the initiative).',
  },
] as const;

export default function RequirementsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          Required Annual Engagement Metrics
        </h1>
      </header>

      {/* Statutory context */}
      <section className="mb-6 rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <p className="text-cpcqc-purple-dark/80">
          <span className="font-semibold text-cpcqc-purple-dark">
            C.R.S. § 25-52-106.5(4)(b)
          </span>{' '}
          states that Colorado birthing hospitals should participate annually in at least one
          maternal or infant health quality improvement initiative with CPCQC by December 15,
          2025. CPCQC&rsquo;s initiatives run as annual cohorts which begin in January each year,
          with the exception of Turning the Tide, which is a 2-year cohort.
        </p>
        <p className="mt-3 text-cpcqc-purple-dark/80">
          CPCQC measures hospital engagement in quality improvement using five metrics modeled
          after the National Network of Perinatal Quality Collaboratives framework for
          engagement:
        </p>
      </section>

      {/* The five metrics */}
      <section className="mb-6 space-y-3">
        {METRICS.map((m, i) => {
          const Icon = m.icon;
          return (
            <div
              key={m.title}
              className="flex gap-4 rounded-2xl bg-white p-5 shadow-card ring-1 ring-cpcqc-purple-dark/5"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cpcqc-purple/10 font-rounded text-lg font-extrabold text-cpcqc-purple">
                {i + 1}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Icon size={16} className="shrink-0 text-cpcqc-purple" aria-hidden />
                  <h2 className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">
                    {m.title}
                  </h2>
                </div>
                <p className="mt-1 text-sm text-cpcqc-purple-dark/80">{m.body}</p>
              </div>
            </div>
          );
        })}
      </section>

      {/* Sustainability Track */}
      <section className="rounded-2xl bg-cpcqc-teal-dark/10 p-6 ring-1 ring-cpcqc-teal-dark/20">
        <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
          Sustainability Track
        </h2>
        <p className="mt-2 text-sm text-cpcqc-purple-dark/80">
          Hospitals that meet all engagement and initiative-specific clinical performance
          metrics may be eligible to enroll in an initiative&rsquo;s Sustainability Track for up
          to one year. Designed to support long-term maintenance of quality improvement gains,
          the Sustainability Track provides continued access to CPCQC resources, expertise, and
          support while reducing participation requirements.
        </p>
        <p className="mt-2 text-sm text-cpcqc-purple-dark/80">
          Compared with Active Track hospitals, Sustainability Track participants have fewer
          required meetings, quality improvement advising sessions, and data submission
          requirements, while still meeting Colorado statutory engagement requirements.
        </p>
      </section>
    </div>
  );
}
