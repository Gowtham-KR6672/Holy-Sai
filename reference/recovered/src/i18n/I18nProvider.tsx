import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { i18n } from '@/lib/legacy-i18n';

/** English / தமிழ் / हिन्दी — dictionaries ported from the wireframe. */
interface I18n {
  lang: string;
  langs: { id: string; label: string; short: string }[];
  setLang: (id: string) => void;
  t: (key: string) => string;
  label: string;
  short: string;
}

const Ctx = createContext<I18n | null>(null);

function initial() {
  try {
    const l = localStorage.getItem('hs.lang');
    if (l) i18n.set(l);
  } catch {
    /* ignore */
  }
  return i18n.lang as string;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState(initial);
  const setLang = useCallback((id: string) => {
    i18n.set(id);
    setLangState(i18n.lang);
    document.documentElement.lang = id;
    try {
      localStorage.setItem('hs.lang', id);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo<I18n>(() => ({
    lang,
    langs: i18n.langs.map((l: { id: string; label: string; short: string }) => ({ id: l.id, label: l.label, short: l.short })),
    setLang,
    // `lang` is a dependency so consumers re-render when it changes
    t: (key: string) => (lang ? i18n.t(key) : key),
    label: i18n.label(),
    short: i18n.short(),
  }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n must be used inside I18nProvider');
  return v;
}
