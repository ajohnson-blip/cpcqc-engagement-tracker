/**
 * CPCQC wordmark — the official logo image (mother/baby curl + "cpcqc"
 * lowercase wordmark, both in CPCQC purple).
 *
 * Source asset: /public/cpcqc-logo.png (433×272, aspect ~1.59). The Next.js
 * Image component handles intrinsic sizing + retina; we pick a rendered
 * height per `size` and let width follow the aspect ratio.
 *
 * The `colorClassName` prop is kept for backwards compatibility with callers
 * that previously tinted the CSS-rendered version, but it's a no-op now: the
 * PNG embeds its own purple. If we ever need a white-on-purple variant for a
 * dark hero, swap in a second asset rather than masking via CSS.
 */
import Image from 'next/image';
import clsx from 'clsx';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  /** @deprecated kept for API compat; the PNG embeds its own color. */
  colorClassName?: string;
}

// Rendered heights in px. Width follows the source aspect ratio automatically.
// Tuned so `sm` reads similarly to the old wordmark height in the staff/portal
// headers, and `lg` reads as a hero on the login / interest / set-password pages.
const HEIGHT_MAP = {
  sm: 36,
  md: 60,
  lg: 120,
} as const;

const SOURCE_WIDTH = 433;
const SOURCE_HEIGHT = 272;
const ASPECT = SOURCE_WIDTH / SOURCE_HEIGHT;

export function Logo({ className, size = 'md' }: LogoProps) {
  const height = HEIGHT_MAP[size];
  const width = Math.round(height * ASPECT);
  return (
    <span className={clsx('inline-flex items-center', className)}>
      <Image
        src="/cpcqc-logo.png"
        alt="CPCQC"
        width={width}
        height={height}
        priority={size === 'lg'}
      />
      <span className="sr-only">Colorado Perinatal Care Quality Collaborative</span>
    </span>
  );
}
