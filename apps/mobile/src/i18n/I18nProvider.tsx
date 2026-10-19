import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isLanguageId, LANGUAGES, translate, type LanguageDef, type LanguageId } from '@holysai/shared';
import { prefs } from '@/lib/storage';
import { setFormatLocale } from '@/lib/format';

const KEY = 'hs.lang';

export type Weight = 'regular' | 'medium' | 'semibold' | 'bold';

/** Font family per language: Montserrat for English, Noto Sans Tamil / Devanagari for Tamil and Hindi. */
const FONTS: Record<LanguageId, Record<Weight, string>> = {
  en: { regular: 'Montserrat_400Regular', medium: 'Montserrat_500Medium', semibold: 'Montserrat_600SemiBold', bold: 'Montserrat_700Bold' },
  ta: { regular: 'NotoSansTamil_400Regular', medium: 'NotoSansTamil_500Medium', semibold: 'NotoSansTamil_600SemiBold', bold: 'NotoSansTamil_700Bold' },
  hi: { regular: 'NotoSansDevanagari_400Regular', medium: 'NotoSansDevanagari_500Medium', semibold: 'NotoSansDevanagari_600SemiBold', bold: 'NotoSansDevanagari_700Bold' },
};

export interface I18n {
  lang: LanguageId;
  langs: LanguageDef[];
  locale: string;
  setLang: (id: LanguageId) => void;
  /** Translates English text through the shared dictionaries; `{name}` placeholders are filled from vars. */
  t: (text: string, vars?: Record<string, string | number>) => string;
  font: (weight?: Weight) => string;
  ready: boolean;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LanguageId>('en');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    prefs.get(KEY).then((v) => {
      if (!alive) return;
      if (isLanguageId(v)) {
        setLangState(v);
        setFormatLocale(v);
      }
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setLang = useCallback((id: LanguageId) => {
    setLangState(id);
    setFormatLocale(id);
    void prefs.set(KEY, id);
  }, []);

  const value = useMemo<I18n>(() => {
    const def = LANGUAGES.find((l) => l.id === lang) ?? LANGUAGES[0];
    return {
      lang,
      langs: LANGUAGES,
      locale: def.locale,
      setLang,
      t: (text, vars) => translate(lang, text, vars),
      font: (weight = 'regular') => FONTS[lang][weight],
      ready,
    };
  }, [lang, setLang, ready]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n must be used inside I18nProvider');
  return v;
}
