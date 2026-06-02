import clsx from 'clsx';
import type { RequirementResult, RequirementStatus } from '@/lib/types';

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
}

export function ComplianceTile({ label, result, boolean }: ComplianceTileProps) {
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
    </div>
  );
}

const STATUS_LABEL: Record<RequirementStatus, string> = {
  met: 'Met',
  on_track: 'On track',
  at_risk: 'At risk',
  not_met: 'Not met',
};
