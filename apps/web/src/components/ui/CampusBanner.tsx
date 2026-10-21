import { loc } from '@/lib/format';
import type { ReactNode } from 'react';
import { Icon } from './primitives';
import { LotusMark } from './LotusArt';

const today = () =>
  new Intl.DateTimeFormat(loc('en-IN'), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date());

/** Time-of-day greeting in school time (IST). */
export function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  return hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
}

/**
 * Dashboard welcome: greeting, summary, date and actions on the left (with a
 * gold accent line); soft brand shapes on the right.
 */
export function CampusBanner({ title, sub, actions, children, date = true, bleed = true, wave = true }: {
  title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; date?: boolean;
  /** Kept for existing callers; the banner always sits inside the page gutter. */
  bleed?: boolean;
  /** Waving-hand emoji after a greeting. */
  wave?: boolean;
  /** Kept for existing callers; the banner no longer shows a quote. */
  quote?: boolean;
}) {
  return (
    <section className={bleed ? 'campusbanner campusbanner--bleed' : 'campusbanner'} aria-label="Welcome">
      <figure className="campusbanner__photo campusbanner__art" aria-hidden="true">
        <BannerArt />
      </figure>
      <LotusMark className="campusbanner__lotus" />
      <div className="campusbanner__body">
        <div className="campusbanner__text">
          <h1 className="campusbanner__title">{title}{wave && <span className="campusbanner__wave" aria-hidden="true">👋</span>}</h1>
          {sub && <p className="campusbanner__sub">{sub}</p>}
          {date && <span className="campusbanner__date"><Icon name="calendar" size={15} />{today()}</span>}
          {children}
          {actions && <div className="campusbanner__actions">{actions}</div>}
        </div>
      </div>
    </section>
  );
}

/** Neutral decoration for the banner's right side: overlapping brand circles and a dot grid. */
function BannerArt() {
  const dots = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 9; c++) dots.push(<circle key={`${r}-${c}`} cx={262 + c * 18} cy={46 + r * 18} r="2" />);
  return (
    <svg viewBox="0 0 600 200" preserveAspectRatio="xMaxYMid slice">
      <circle cx="520" cy="28" r="150" fill="var(--brand)" opacity=".07" />
      <circle cx="610" cy="206" r="118" fill="var(--accent)" opacity=".28" />
      <circle cx="404" cy="214" r="74" fill="var(--brand)" opacity=".05" />
      <circle cx="452" cy="58" r="10" fill="var(--accent)" opacity=".7" />
      <g fill="var(--brand)" opacity=".16">{dots}</g>
    </svg>
  );
}
