import clsx from 'clsx';
import type {
  RequirementBenchmark,
  RequirementResult,
  RequirementStatus,
} from '@/lib/types';

const BAR_COLOR: Record<RequirementStatus, string> = {
  met: 'bg-cpcqc-teal-dark',
  on_track: 'bg-cpcqc-purple',
  at_risk: 'bg-cpcqc-orange-dark',
  not_met: 'bg-cpcqc-pink-dark',
};

const ICON_BG: Record<RequirementStatus, string> = {
  met: 'bg-cpcqc-teal-dark/15 text-cpcqc-teal-dark',
  on_track: 'bg-cpcqc-purple/15 text-cpcqc-purple',
  at_risk: 'bg-cpcqc-orange-dark/15 text-cpcqc-orange-dark',
  not_met: 'bg-cpcqc-pink-dark/15 text-cpcqc-pink-dark',
};

interface ComplianceTileProps {
  label: string;
  result: RequirementResult;
  /** Boolean-style requirements (like Annual Enrollment) hide the X/Y count. */
  boolean?: boolean;
  /** Cohort benchmark for this requirement; renders a "vs peers" footer. */
  benchmark?: RequirementBenchmark | null;
}

export function ComplianceTile({ label, result, boolean, benchmark }: ComplianceTileProps) {
  const pct = Math.min(100, Math.round((result.current / Math.max(result.required, 1)) * 100));
  return (
    <div className="flex flex-col rounded-xl bg-white p-4 shadow-sm ring-1 ring-cpcqc-purple-dark/5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
          {label}
        </span>
        <span
          className={clsx(
            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
            ICON_BG[result.status],
          )}
        >
          {STATUS_LABEL[result.status]}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        {boolean ? (
          <span className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
            {result.status === 'met' ? 'Yes' : result.status === 'not_met' ? 'No' : 'Pending'}
          </span>
        ) : (
          <>
            <span className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
              {result.current}
            </span>
            <span className="text-sm text-cpcqc-purple-dark/70">/ {result.required} required</span>
          </>
        )}
      </div>
      {!boolean && (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-cpcqc-purple-dark/10">
          <div className={clsx('h-full transition-all', BAR_COLOR[result.status])} style={{ width: `${pct}%` }} />
        </div>
      )}
      {result.reason && (
        <p className="mt-2 text-xs text-cpcqc-purple-dark/70">{result.reason}</p>
      )}
      {benchmark && benchmark.peersTotal > 0 && (
        <BenchmarkFooter result={result} benchmark={benchmark} boolean={!!boolean} />
      )}
    </div>
  );
}

function BenchmarkFooter({
  result,
  benchmark,
  boolean,
}: {
  result: RequirementResult;
  benchmark: RequirementBenchmark;
  boolean: boolean;
}) {
  const { peerMedian, peersMet, peersTotal, myPercentile } = benchmark;
  // For boolean requirements (Enrollment), median isn't meaningful — just show peers-met.
  const detail = boolean
    ? `${peersMet} of ${peersTotal} peers complete`
    : `Cohort median ${peerMedian} · ${peersMet} of ${peersTotal} peers met`;

  const rank = myPercentile;
  const rankLabel =
    rank >= 75 ? 'Top quartile' : rank >= 50 ? 'Above median' : rank >= 25 ? 'Below median' : 'Bottom quartile';
  const rankColor =
    rank >= 75
      ? 'text-cpcqc-teal-dark'
      : rank >= 50
        ? 'text-cpcqc-purple'
        : rank >= 25
          ? 'text-cpcqc-orange-dark'
          : 'text-cpcqc-pink-dark';

  return (
    <div className="mt-3 border-t border-cpcqc-purple-dark/10 pt-2 text-xs text-cpcqc-purple-dark/70">
      <div className="flex items-center justify-between gap-2">
        <span>{detail}</span>
        <span className={clsx('font-bold uppercase tracking-wide', rankColor)}>{rankLabel}</span>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<RequirementStatus, string> = {
  met: 'Met',
  on_track: 'On track',
  at_risk: 'At risk',
  not_met: 'Not met',
};
