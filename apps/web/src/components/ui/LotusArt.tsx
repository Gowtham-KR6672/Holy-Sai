/**
 * The We School mark as decoration: the "W" with its gold dot, drawn in the brand magenta,
 * over an open-book line. Used for the decorations across the application (always hidden from
 * screen readers). The component names are kept from the earlier artwork so existing screens compile.
 */
import { useId } from 'react';

/** The "W" on a 200 × 150 canvas (same geometry as public/logo-mark.svg, scaled). */
const W_PATH = 'M50.6 42.5 L75.3 99.7 L100 58.1 L124.7 99.7 L149.4 42.5';
/** Two page edges meeting at the spine. */
const BOOK_PATH = 'M36 122 Q 68 110, 100 128 Q 132 110, 164 122';

export function LotusArt({ className, waves = true, title }: { className?: string; waves?: boolean; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 200 150" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <linearGradient id={`wm${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#B30042" />
          <stop offset=".55" stopColor="#990033" />
          <stop offset="1" stopColor="#4A0A22" />
        </linearGradient>
        <linearGradient id={`wg${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFDB6E" />
          <stop offset="1" stopColor="#E3B04B" />
        </linearGradient>
        <linearGradient id={`wb${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#990033" stopOpacity="0" />
          <stop offset=".5" stopColor="#990033" />
          <stop offset="1" stopColor="#990033" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform={waves ? undefined : 'translate(0 16)'}>
        <path d={W_PATH} fill="none" stroke={`url(#wm${id})`} strokeWidth="15.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="100" cy="23" r="13" fill={`url(#wg${id})`} />
      </g>
      {waves && <path d={BOOK_PATH} fill="none" stroke={`url(#wb${id})`} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** Decorative mark placed by its class name (position and opacity come from the stylesheet). */
export function LotusMark({ className, waves }: { className?: string; waves?: boolean }) {
  return <span className={className} aria-hidden="true"><LotusArt waves={waves} /></span>;
}

/** Brand divider: a line, a small mark, a line. */
export function LotusDivider({ className }: { className?: string }) {
  return (
    <span className={`lotusdivider${className ? ` ${className}` : ''}`} aria-hidden="true">
      <i /><LotusArt waves={false} /><i />
    </span>
  );
}
