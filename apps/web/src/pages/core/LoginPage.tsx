import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { BrandDivider, Button, Icon, Lotus, LotusMark, Modal, Svg, useToast } from '@/components/ui';
import { useSchoolBrand } from '@/lib/brand';
import { fmt } from '@/lib/format';

interface PublicConfig {
  campuses: { code: string; name: string; shortName: string; place: string }[];
  academicYear: string | null;
  settings: Record<string, unknown>;
  stats?: { students: number; staff: number; campuses: number };
  demoAccounts?: { email: string; fullName: string; title: string; role: string; roleName: string }[];
  environment: string;
}

const MASCOT = `<svg width="58" height="58" viewBox="0 0 64 64" role="img" aria-label="AI campus assistant">
<ellipse cx="32" cy="59" rx="16" ry="3.4" fill="#0D2B45" opacity=".16"/>
<rect x="19" y="33" width="26" height="22" rx="9" fill="#F2F6FA" stroke="#C5D6E4" stroke-width="1.5"/>
<rect x="27" y="41" width="10" height="9" rx="3" fill="#E1ECF4"/>
<rect x="11" y="36" width="8" height="15" rx="4" fill="#E7EFF6" stroke="#C5D6E4" stroke-width="1.2"/>
<rect x="45" y="36" width="8" height="15" rx="4" fill="#E7EFF6" stroke="#C5D6E4" stroke-width="1.2"/>
<rect x="15" y="12" width="34" height="24" rx="11" fill="#FBFDFF" stroke="#C5D6E4" stroke-width="1.6"/>
<rect x="19" y="17" width="26" height="14" rx="7" fill="#0D2B45"/>
<circle cx="27" cy="24" r="3.4" fill="#4FD1E8"/><circle cx="37" cy="24" r="3.4" fill="#4FD1E8"/>
<circle cx="28.2" cy="22.8" r="1.1" fill="#fff"/><circle cx="38.2" cy="22.8" r="1.1" fill="#fff"/>
<rect x="30.4" y="5" width="3.2" height="7" rx="1.6" fill="#B87008"/><circle cx="32" cy="4" r="3" fill="#E8B765"/>
<circle cx="32" cy="46" r="2.2" fill="#4FD1E8" opacity=".8"/></svg>`;

// What the platform connects, explained on the first spread of the book.
const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: 'graduation', title: 'Student success', text: 'Attendance, marks and early warnings in one view.' },
  { icon: 'heart', title: 'Connected parents', text: 'Fees, homework, transport and messages in one app.' },
  { icon: 'shieldCheck', title: 'Safer campus', text: 'Visitors, gate passes and live bus tracking.' },
  { icon: 'trending', title: 'Smarter operations', text: 'Finance, payroll and reports without spreadsheets.' },
];

// The five wireframe role tiles, in order.
const TILES: { role: string; label: string; icon: string }[] = [
  { role: 'principal', label: 'Management', icon: 'user' },
  { role: 'teacher', label: 'Teacher', icon: 'users' },
  { role: 'parent', label: 'Parent', icon: 'heart' },
  { role: 'office', label: 'Office', icon: 'building' },
  { role: 'staff', label: 'Staff', icon: 'idCard' },
];

/**
 * The sign-in page is a book. intro: the logo zooms out of the screen while a ring loads; cover: the closed book;
 * about: the cover opens on a spread that explains We School; signin: the Sign in corner turns the pages to the
 * spread with the sign-in form. On phones the book shows one page at a time.
 */
type BookState = 'intro' | 'cover' | 'about' | 'signin';

/** Pages turned between the "about" spread and the sign-in spread (the cover turns first, on its own). */
const PAGES = 4;
const INTRO_MS = 1500;
const COVER_MS = 650;
const TURN_GAP_MS = 150;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The open book's largest size in CSS pixels (two 520 × 680 pages); larger screens zoom it up to fill them. */
const SPREAD_W = 1040;
const SPREAD_H = 680;
const MAX_ZOOM = 2;

/** How much to enlarge the book on large screens (1 on laptops, tablets and phones). */
function useBookZoom(): number {
  const measure = () => {
    if (typeof window === 'undefined' || window.innerWidth < 900) return 1;
    const fit = Math.min((window.innerWidth - 96) / SPREAD_W, (window.innerHeight - 96) / SPREAD_H);
    return Math.max(1, Math.min(MAX_ZOOM, Math.round(fit * 100) / 100));
  };
  const [zoom, setZoom] = useState(measure);
  useEffect(() => {
    const onResize = () => setZoom(measure());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return zoom;
}

export default function LoginPage() {
  const { login } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [book, setBook] = useState<BookState>(() => (reducedMotion() ? 'about' : 'intro'));
  const [turning, setTurning] = useState<'forward' | 'back'>('forward');
  const idRef = useRef<HTMLInputElement>(null);
  const zoom = useBookZoom();

  const config = useQuery({ queryKey: ['public-config'], queryFn: () => api.get<PublicConfig>('/public/config'), staleTime: 5 * 60_000 });
  const { schoolName } = useSchoolBrand();
  const demo = config.data?.demoAccounts ?? [];
  const pickedAccount = demo.find((d) => d.role === picked) ?? null;
  // Counts only mean something on a school's own address; the shared We School page has none.
  const stats = config.data?.academicYear ? config.data?.stats : undefined;

  useEffect(() => {
    document.title = 'Sign in — We School';
  }, []);

  // intro → cover → about, on a timer; any key or click skips ahead.
  useEffect(() => {
    if (book !== 'intro' && book !== 'cover') return;
    const timer = window.setTimeout(() => setBook(book === 'intro' ? 'cover' : 'about'), book === 'intro' ? INTRO_MS : COVER_MS);
    const skip = () => setBook('about');
    window.addEventListener('keydown', skip);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', skip);
    };
  }, [book]);

  // The flat left page appears once the last leaf has landed (and disappears as soon as pages turn again).
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (book !== 'about' && book !== 'signin') return;
    const turned = book === 'about' && turning === 'forward' ? 1100 : 950 + (PAGES - 1) * TURN_GAP_MS;
    const timer = window.setTimeout(() => setSettled(true), reducedMotion() ? 0 : turned);
    return () => window.clearTimeout(timer);
  }, [book, turning]);

  const openSignIn = () => {
    setTurning('forward');
    setBook('signin');
    // The email field takes the focus once the pages have settled.
    window.setTimeout(() => idRef.current?.focus({ preventScroll: true }), reducedMotion() ? 0 : 900 + PAGES * TURN_GAP_MS);
  };
  const backToAbout = () => {
    setTurning('back');
    setBook('about');
  };

  const pick = (role: string, email?: string) => {
    const acc = email ? demo.find((d) => d.email === email) : demo.find((d) => d.role === role);
    setPicked(role);
    if (acc) setIdentifier(acc.email);
    setError(null);
    setMoreOpen(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setError('Enter your email or mobile number and your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await login(identifier.trim(), password);
      toast(`Welcome, ${user.fullName}`, 'success', 'check');
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : user.role.homeRoute, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const opened = book === 'about' || book === 'signin';
  /** The cover turns with the "about" spread; the other pages only for sign-in (back to front when closing). */
  const leaf = (i: number): { flipped: boolean; style: CSSProperties } => {
    const flipped = i === 0 ? opened : book === 'signin';
    const delay = i === 0 ? 0 : (turning === 'forward' ? i - 1 : PAGES - i) * TURN_GAP_MS;
    return { flipped, style: { '--z': `${PAGES + 1 - i}px`, '--delay': `${delay}ms` } as CSSProperties };
  };

  const help = (
    <div className="bookhelp__actions">
      <Button variant="primary" size="sm" icon="sparkle" onClick={() => setInfo('The AI Campus Assistant answers from approved school documents once you sign in.')}>Ask AI</Button>
      <Button size="sm" icon="phone" onClick={() => setInfo('Contact your school office: they can confirm your registered email or mobile number and reset your password.')}>Contact School</Button>
      <Button size="sm" icon="helpCircle" onClick={() => setInfo('Sign in with the email or mobile number registered with the school. Parents see only their own children; staff see the modules their role allows.')}>{t('Help')}</Button>
    </div>
  );
  const privacy = (
    <p className="bookprivacy"><Icon name="shieldCheck" size={14} />Your data is visible only to people whose role requires it.</p>
  );

  // Left pages are the backs of turned leaves. Browsers do not reliably pass clicks to the back of a 3D-turned
  // element, so once the turn has settled the same page is laid over it flat (book__flat) and takes the clicks.
  const aboutLeftPage = (
    <Paper side="left" n={1}>
      <div className="page__head">
        <span className="page__brand"><Lotus size={26} />We School</span>
        <LangPill />
      </div>
      <p className="hero__eyebrow">One platform for the whole school</p>
      <h1 className="book__title">Every student.<em>Every family. Connected.</em></h1>
      <p className="book__lede">Admissions, academics, parents, safety, finance, workforce and intelligence — connected around every student.</p>
      {stats && (
        <div className="bookstats">
          {[
            ['users', fmt.n(stats.students), 'Students'],
            ['graduation', fmt.n(stats.staff), 'Staff'],
            ['building', String(stats.campuses), 'Campuses'],
          ].map(([ico, v, l]) => (
            <span className="bookstat" key={l}>
              <Icon name={ico} size={18} />
              <span className="col"><span className="bookstat__value">{v}</span><span className="bookstat__label">{l}</span></span>
            </span>
          ))}
        </div>
      )}
      <p className="book__note">Each school has its own private space on We School: its own campuses, staff, students, parents and settings.</p>
    </Paper>
  );
  const helpLeftPage = (
    <Paper side="left" n={9}>
      <p className="page__kicker">Before you sign in</p>
      <ul className="booksteps">
        <li><Icon name="idCard" size={17} /><span><b>Staff</b> — use the email or mobile number registered with your school.</span></li>
        <li><Icon name="heart" size={17} /><span><b>Parents</b> — use the mobile number or email you gave the school; you see only your own children.</span></li>
        <li><Icon name="key" size={17} /><span><b>New account</b> — sign in with the temporary password you received, then choose your own.</span></li>
      </ul>
      <div className="bookhelp">
        <Svg html={MASCOT} />
        <div className="grow">
          <p className="bookhelp__title">Need help entering the campus?</p>
          <p className="bookhelp__text">Ask our AI Campus Assistant</p>
          {help}
        </div>
      </div>
      {privacy}
    </Paper>
  );

  return (
    <section className="home home--book" aria-label="We School — welcome and sign in">
      {book === 'intro' || book === 'cover' ? (
        <div className="bookintro" data-done={book === 'cover'} onClick={() => setBook('about')} aria-hidden="true">
          <div className="bookintro__mark" style={zoom > 1 ? { zoom } : undefined}>
            <svg className="bookintro__ring" viewBox="0 0 140 140"><circle cx="70" cy="70" r="64" /></svg>
            <img src="/logo-mark.svg" alt="" width={92} height={92} />
          </div>
          <p className="bookintro__name">We School</p>
        </div>
      ) : null}

      <div className="bookstage" onClick={book === 'intro' || book === 'cover' ? () => setBook('about') : undefined}>
        {/* --k enlarges the book on large screens: the 3D pages by size, their paper by zoom (sharp text). */}
        <div className="bookwrap" data-state={book} style={{ '--k': zoom } as CSSProperties}>
        <div className="book" data-state={book}>
          <div className="book__leftbase" aria-hidden="true" />
          <span className="book__spine" aria-hidden="true" />

          {/* The sign-in page lies under all the others; the leaves follow from the bottom of the stack to the cover. */}
          <div className="book__base" inert={book !== 'signin'}>
            <Paper side="right" n={10}>
              <div className="page__head">
                <button type="button" className="page__back" onClick={backToAbout}>
                  <Icon name="arrowLeft" size={15} />Back
                </button>
                <LangPill />
              </div>
              <form className="bookform" onSubmit={submit} noValidate>
                <div className="row between">
                  <div>
                    <p className="logincard__welcome">Welcome to</p>
                    <h2 className="logincard__title">We School</h2>
                    <p className="logincard__sub">Connected school platform</p>
                  </div>
                  <Lotus size={42} />
                </div>
                <BrandDivider />
                {/* Only when a school is known (its own address): the shared We School sign-in has no school yet. */}
                {config.data?.academicYear && (
                  <button type="button" className="ctxrow" onClick={() => setInfo('Campus and academic year are chosen after sign-in, from the header.')}>
                    <Icon name="building" size={17} />
                    <span className="ctxrow__text grow">Academic Year {config.data.academicYear} &nbsp;|&nbsp; <b>{schoolName}</b></span>
                    <Icon name="chevronDown" size={15} />
                  </button>
                )}

                <div className="col g-3 mt-4">
                  <div className="ifield">
                    <span className="ifield__ico"><Icon name="mail" size={17} /></span>
                    <input ref={idRef} className="input" type="text" name="username" autoComplete="username" aria-label="Email or mobile number"
                      placeholder="Email or mobile number" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
                  </div>
                  <div className="ifield">
                    <span className="ifield__ico"><Icon name="lock" size={17} /></span>
                    <input className="input" type={showPw ? 'text' : 'password'} name="password" autoComplete="current-password" aria-label="Password"
                      placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                    <button type="button" className="iconbtn ifield__eye" aria-label={showPw ? 'Hide password' : 'Show password'} onClick={() => setShowPw((s) => !s)}>
                      <Icon name="eye" size={17} />
                    </button>
                  </div>
                  <div className="row between wrap g-2">
                    <label className="check"><input type="checkbox" defaultChecked /> Remember me on this device</label>
                    <button type="button" className="t-sm" style={{ color: 'var(--magenta)' }}
                      onClick={() => setInfo('Password reset: contact the school office, who can verify your identity and issue a reset. Self-service reset activates once an email/SMS provider is configured.')}>
                      Forgot password?
                    </button>
                  </div>
                  {error && (
                    <div className="banner banner--critical login-error" role="alert">
                      <Icon name="alert" size={17} />
                      <div className="grow">{error}</div>
                    </div>
                  )}
                  <Button type="submit" variant="primary" block iconRight="arrowRight" loading={busy} className="logincard__btn">
                    Sign in to Campus
                  </Button>
                </div>

                {demo.length > 0 && (
                  <>
                    <div className="orline mt-5">Or continue as</div>
                    <div className="roletiles mt-3">
                      {TILES.filter((tile) => demo.some((d) => d.role === tile.role)).map((tile) => {
                        const acc = demo.find((d) => d.role === tile.role)!;
                        return (
                          <button type="button" key={tile.role} className="roletile" data-role={tile.role} aria-pressed={picked === tile.role}
                            title={`${acc.fullName} · ${acc.title}`} onClick={() => pick(tile.role)}>
                            <span className="roletile__ico"><Icon name={tile.icon} size={16} /></span>
                            <span className="roletile__label">{tile.label}</span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="t-micro t-muted t-center mt-3">
                      {pickedAccount ? (
                        <>Signing in as <strong>{pickedAccount.fullName}</strong> · {pickedAccount.title}</>
                      ) : (
                        <>Choose a demo account, then enter the demo password.</>
                      )}
                      {' · '}
                      <button type="button" className="t-micro" style={{ color: 'var(--magenta)', fontWeight: 600 }} onClick={() => setMoreOpen(true)}>More accounts</button>
                    </p>
                    <p className="demo-hint">Development build: demo accounts use the password set in <code>SEED_DEMO_PASSWORD</code>.</p>
                  </>
                )}
              </form>
              {/* On phones the help page is not shown, so its essentials sit under the form. */}
              <div className="only-single bookhelp bookhelp--compact">
                <p className="bookhelp__title">Need help entering the campus?</p>
                {help}
                {privacy}
              </div>
            </Paper>
          </div>

          {/* Leaf 4: its back is the left page of the sign-in spread (help before signing in). */}
          <div className="leaf" data-flipped={leaf(4).flipped} style={leaf(4).style}>
            <div className="leaf__face leaf__front" aria-hidden="true"><BlankPage side="right" n={8} /></div>
            <div className="leaf__face leaf__back" inert aria-hidden="true">{helpLeftPage}</div>
          </div>

          {/* Leaves 2–3: plain pages that turn on the way to the sign-in spread. */}
          {[3, 2].map((i) => (
            <div className="leaf" key={i} data-flipped={leaf(i).flipped} style={leaf(i).style} aria-hidden="true">
              <div className="leaf__face leaf__front"><BlankPage side="right" n={i * 2} /></div>
              <div className="leaf__face leaf__back"><BlankPage side="left" n={i * 2 + 1} /></div>
            </div>
          ))}

          {/* Leaf 1: what's inside (right page of the "about" spread), with the Sign in corner. */}
          <div className="leaf" data-flipped={leaf(1).flipped} style={leaf(1).style}>
            <div className="leaf__face leaf__front" inert={book !== 'about'}>
              <Paper side="right" n={2} corner={
                <button type="button" className="pagecorner" onClick={openSignIn}>
                  <span className="pagecorner__label">Sign in<Icon name="arrowRight" size={16} /></span>
                  <span className="pagecorner__fold" aria-hidden="true" />
                </button>
              }>
                <div className="only-single">
                  <div className="page__head">
                    <span className="page__brand"><Lotus size={26} />We School</span>
                    <LangPill />
                  </div>
                  <p className="hero__eyebrow">One platform for the whole school</p>
                  <p className="book__title book__title--small">Every student.<em>Every family. Connected.</em></p>
                </div>
                <p className="page__kicker">What's inside</p>
                <ul className="booklist">
                  {FEATURES.map((f) => (
                    <li className="booklist__item" key={f.title}>
                      <span className="booklist__ico"><Icon name={f.icon} size={18} /></span>
                      <span className="col">
                        <span className="booklist__title">{f.title}</span>
                        <span className="booklist__text">{f.text}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="book__note">One sign-in for everyone: school leaders, teachers, office staff, parents and students each see what their role needs.</p>
              </Paper>
            </div>
            <div className="leaf__face leaf__back" aria-hidden="true"><BlankPage side="left" n={3} /></div>
          </div>

          {/* Leaf 0: the cover (front) and the inside of the cover (back, the left page of the "about" spread). */}
          <div className="leaf leaf--cover" data-flipped={leaf(0).flipped} style={leaf(0).style}>
            <div className="leaf__face leaf__front" inert={book !== 'intro' && book !== 'cover'}>
              <div className="cover">
                <div className="cover__center">
                  <Lotus size={96} />
                  <p className="cover__title">We School</p>
                  <p className="cover__tag">School platform</p>
                  <span className="cover__rule" />
                  <p className="cover__motto">Every student. Every family. Connected.</p>
                </div>
                <p className="cover__foot">Admissions · Academics · Parents · Safety · Finance · Workforce</p>
              </div>
            </div>
            <div className="leaf__face leaf__back" inert aria-hidden="true">{aboutLeftPage}</div>
          </div>
        </div>
        <div className="book__flat" data-show={settled} inert={!settled}>
          {settled && book === 'about' ? aboutLeftPage : settled && book === 'signin' ? helpLeftPage : null}
        </div>
        </div>
      </div>

      <Modal open={!!info} onClose={() => setInfo(null)} title="We School" foot={<Button variant="primary" onClick={() => setInfo(null)}>Understood</Button>}>
        <p className="t-sm">{info}</p>
      </Modal>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="Demo accounts" sub="Sample accounts for every role. Development builds only." size="wide"
        foot={<Button onClick={() => setMoreOpen(false)}>Close</Button>}>
        <div className="col g-2">
          {demo.map((d) => (
            <button key={d.email} className="optioncard" onClick={() => pick(d.role, d.email)}>
              <span className="avatar">{fmt.initials(d.fullName)}</span>
              <span className="col grow" style={{ minWidth: 0 }}>
                <span className="t-sm t-bold">{d.fullName} <span className="badge badge--info" style={{ marginLeft: 6 }}>{d.roleName}</span></span>
                <span className="t-xs t-muted t-clip">{d.title} · {d.email}</span>
              </span>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
        </div>
      </Modal>
    </section>
  );
}

/** One page of the book: paper, its content and a page number at the foot (and, on one page, the Sign in corner). */
function Paper({ side, n, children, corner }: { side: 'left' | 'right'; n: number; children: ReactNode; corner?: ReactNode }) {
  return (
    <div className={`paper paper--${side}${corner ? ' paper--corner' : ''}`}>
      <div className="paper__body">{children}</div>
      <span className="paper__num" aria-hidden="true">{n}</span>
      {corner}
    </div>
  );
}

/** A page that only turns past: faint lines and the mark. */
function BlankPage({ side, n }: { side: 'left' | 'right'; n: number }) {
  return (
    <div className={`paper paper--${side} paper--blank`}>
      <LotusMark className="paper__mark" />
      <span className="paper__num">{n}</span>
    </div>
  );
}

function LangPill() {
  const { langs, lang, setLang } = useI18n();
  return (
    <div className="langpill langpill--paper">
      {langs.map((l) => (
        <button type="button" key={l.id} aria-pressed={lang === l.id} onClick={() => setLang(l.id)}>{l.label}</button>
      ))}
    </div>
  );
}
