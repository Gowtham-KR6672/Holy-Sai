// Translations keyed by the English text, as in the original build: a missing entry falls back to English.
// Each module adds its own file under ./modules so modules can be built in parallel without conflicts.
import { ta as taBase } from './ta';
import { hi as hiBase } from './hi';
import { MODULE_TRANSLATIONS } from './modules';

export type LanguageId = 'en' | 'ta' | 'hi';

export interface LanguageDef {
  id: LanguageId;
  label: string;
  short: string;
  /** Locale used for dates and numbers. */
  locale: string;
}

export const LANGUAGES: LanguageDef[] = [
  { id: 'en', label: 'English', short: 'EN', locale: 'en-IN' },
  { id: 'ta', label: 'தமிழ்', short: 'த', locale: 'ta-IN' },
  { id: 'hi', label: 'हिन्दी', short: 'हि', locale: 'hi-IN' },
];

export type Dictionary = Record<string, string>;

function merge(base: Dictionary, lang: 'ta' | 'hi'): Dictionary {
  return Object.assign({}, base, ...MODULE_TRANSLATIONS.map((m) => m[lang] ?? {}));
}

export const DICTIONARIES: Record<LanguageId, Dictionary> = {
  en: {},
  ta: merge(taBase, 'ta'),
  hi: merge(hiBase, 'hi'),
};

/** Translates English text; `{name}` placeholders are filled from vars. */
export function translate(lang: LanguageId, text: string, vars?: Record<string, string | number>): string {
  const out = DICTIONARIES[lang]?.[text] ?? text;
  if (!vars) return out;
  return out.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

export function isLanguageId(v: unknown): v is LanguageId {
  return v === 'en' || v === 'ta' || v === 'hi';
}
