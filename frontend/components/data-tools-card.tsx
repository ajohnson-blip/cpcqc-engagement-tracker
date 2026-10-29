/**
 * Portal Overview card linking the other CPCQC systems hospitals sign in to
 * (lib/data-tools.ts). Renders nothing until at least one has a URL.
 */

import { ExternalLink } from 'lucide-react';
import { LIVE_DATA_TOOLS } from '@/lib/data-tools';

export function DataToolsCard() {
  if (LIVE_DATA_TOOLS.length === 0) return null;
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
      <p className="mt-0.5 text-sm text-cpcqc-purple-dark/70">
        Each of these has its own login, separate from this tracker.
      </p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {LIVE_DATA_TOOLS.map((t) => (
          <li
            key={t.key}
            className="rounded-xl border border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/20 p-4"
          >
            <a
              href={t.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-rounded text-base font-extrabold text-cpcqc-purple hover:underline"
            >
              {t.name} <ExternalLink size={14} aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <p className="mt-1 text-sm text-cpcqc-purple-dark/80">{t.purpose}</p>
            <p className="mt-1 text-xs text-cpcqc-purple-dark/60">{t.access}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
