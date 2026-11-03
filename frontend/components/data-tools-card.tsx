/**
 * Portal Overview card linking the other CPCQC systems hospitals sign in to
 * (lib/data-tools.ts), and the cpcqc.org resources page for each initiative
 * the hospital is enrolled in. Renders nothing when there is neither.
 */

import { ExternalLink } from 'lucide-react';
import { INITIATIVE_RESOURCES, LIVE_DATA_TOOLS } from '@/lib/data-tools';
import type { MyEnrollment } from '@/lib/types';

const TILE = 'rounded-xl border border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/20 p-4';
const LINK =
  'inline-flex items-center gap-1.5 font-rounded font-extrabold text-cpcqc-purple hover:underline';

function NewTab() {
  return (
    <>
      <ExternalLink size={14} aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </>
  );
}

export function DataToolsCard({ enrollments }: { enrollments: MyEnrollment[] | null }) {
  const enrolled = new Map(
    (enrollments ?? [])
      .filter((e) => e.status === 'enrolled' && e.initiative)
      .map((e) => [e.initiative!.code, e.initiative!]),
  );
  const resources = INITIATIVE_RESOURCES.filter((r) => enrolled.has(r.code));
  if (LIVE_DATA_TOOLS.length === 0 && resources.length === 0) return null;
  return (
    <section
      aria-labelledby="data-tools-heading"
      className="mb-6 rounded-2xl bg-white p-5 shadow-card ring-1 ring-cpcqc-purple-dark/5"
    >
      <h2
        id="data-tools-heading"
        className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark"
      >
        Other CPCQC tools
      </h2>
      {LIVE_DATA_TOOLS.length > 0 && (
        <p className="mt-0.5 text-sm text-cpcqc-purple-dark/70">
          The data tools each have their own login, separate from this tracker.
        </p>
      )}
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {LIVE_DATA_TOOLS.map((t) => (
          <li key={t.key} className={TILE}>
            <a href={t.url} target="_blank" rel="noopener noreferrer" className={`${LINK} text-base`}>
              {t.name} <NewTab />
            </a>
            <p className="mt-1 text-sm text-cpcqc-purple-dark/80">{t.purpose}</p>
            <p className="mt-1 text-xs text-cpcqc-purple-dark/60">{t.access}</p>
          </li>
        ))}
        {resources.length > 0 && (
          <li className={TILE}>
            <p className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">
              Initiative resources
            </p>
            <p className="mt-1 text-sm text-cpcqc-purple-dark/80">
              Toolkits and other resources on cpcqc.org for your{' '}
              {resources.length === 1 ? 'initiative' : 'initiatives'}.
            </p>
            <ul className="mt-2 space-y-1">
              {resources.map((r) => (
                <li key={r.code}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className={`${LINK} text-sm`}>
                    {enrolled.get(r.code)?.emoji && (
                      <span aria-hidden>{enrolled.get(r.code)!.emoji}</span>
                    )}
                    {r.label} resources <NewTab />
                  </a>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </section>
  );
}
