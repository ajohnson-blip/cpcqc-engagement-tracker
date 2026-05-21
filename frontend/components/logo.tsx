/**
 * CSS recreation of the CPCQC wordmark — the "cpcqc" lowercase wordmark with a
 * small wave/curl element above. Swap for the official SVG asset when available.
 */
import clsx from 'clsx';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  colorClassName?: string; // override text color
}

const SIZE_MAP = {
  sm: 'text-xl',
  md: 'text-3xl',
  lg: 'text-5xl',
} as const;

export function Logo({ className, size = 'md', colorClassName = 'text-cpcqc-purple' }: LogoProps) {
  return (
    <div className={clsx('inline-flex flex-col items-start leading-none', className)}>
      <span
        aria-hidden="true"
        className={clsx('mb-0.5 font-script text-[0.7em] tracking-wide', colorClassName, SIZE_MAP[size])}
      >
        ~
      </span>
      <span
        className={clsx('font-rounded font-extrabold tracking-tight', colorClassName, SIZE_MAP[size])}
      >
        cpcqc
      </span>
      <span className="sr-only">CPCQC — Colorado Perinatal Care Quality Collaborative</span>
    </div>
  );
}
