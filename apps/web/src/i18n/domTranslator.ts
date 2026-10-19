/**
 * Whole-page translation (new in the rebuild).
 *
 * The original translated only navigation and a few labels. Every page must now switch to Tamil or Hindi,
 * so instead of rewriting each recovered page, visible English text is replaced at display time:
 * text nodes and the placeholder / title / aria-label / alt attributes are looked up in the language
 * dictionary (exact strings first, then templates such as "{0} students"), and restored when the user
 * switches back to English. React keeps working because only the text value of existing nodes changes;
 * when React writes new English text, the observer translates it again.
 *
 * Dictionaries: src/i18n/dict/<lang>.json = { texts: { english: translation }, patterns: { "{0} students": "{0} மாணவர்கள்" } }.
 * They are produced from src/i18n/strings.json (see tools/i18n-extract.mjs). Anything without a translation stays in English.
 * Mark content that must never be translated with translate="no" or the class "notranslate".
 */

type Dict = { texts: Record<string, string>; patterns: Record<string, string> };

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'NOSCRIPT', 'svg', 'SVG']);

let dict: Dict | null = null;
let lang = 'en';
let compiled: { re: RegExp; to: string }[] = [];
const memo = new Map<string, string | null>();
/** Original English text of nodes we changed, and the translation we wrote. */
const textOriginal = new WeakMap<Text, { en: string; out: string }>();
const touchedTexts = new Set<WeakRef<Text>>();
const attrOriginal = new WeakMap<Element, Record<string, { en: string; out: string }>>();
const touchedEls = new Set<WeakRef<Element>>();
let observer: MutationObserver | null = null;
let pending = new Set<Node>();
let scheduled = false;

const loaders: Record<string, () => Promise<{ default: Dict }>> = {
  ta: () => import('./dict/ta.json') as Promise<{ default: Dict }>,
  hi: () => import('./dict/hi.json') as Promise<{ default: Dict }>,
};

const esc = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

function compile(d: Dict) {
  compiled = Object.entries(d.patterns)
    .filter(([, to]) => !!to)
    .map(([from, to]) => {
      const source = '^' + esc(from).replace(/\\\{(\d+)\\\}|\{(\d+)\}/g, '(.*?)') + '$';
      return { re: new RegExp(source, 's'), to, weight: from.replace(/\{\d+\}/g, '').length };
    })
    .sort((a, b) => b.weight - a.weight)
    .map(({ re, to }) => ({ re, to }));
}

/** Translates one string (whitespace-normalised) or returns null when there is no translation. */
export function translateText(raw: string): string | null {
  if (!dict) return null;
  const key = raw.replace(/\s+/g, ' ').trim();
  if (!key || !/[A-Za-z]/.test(key)) return null;
  if (memo.has(key)) return memo.get(key)!;
  let out: string | null = dict.texts[key] ?? null;
  if (out == null) {
    for (const p of compiled) {
      const m = p.re.exec(key);
      if (m) {
        out = p.to.replace(/\{(\d+)\}/g, (_, i: string) => {
          const v = m[Number(i) + 1] ?? '';
          return dict!.texts[v.trim()] ?? v;
        });
        break;
      }
    }
  }
  memo.set(key, out);
  return out;
}

function skip(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName)) return true;
    if (e.getAttribute('translate') === 'no' || e.classList?.contains('notranslate') || (e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

function translateTextNode(node: Text) {
  const value = node.nodeValue ?? '';
  const prev = textOriginal.get(node);
  // If React replaced our translation with new text, that new text is the English original.
  const en = prev && value === prev.out ? prev.en : value;
  if (lang === 'en') {
    if (prev && value === prev.out) node.nodeValue = prev.en;
    textOriginal.delete(node);
    return;
  }
  if (skip(node.parentElement)) return;
  const tr = translateText(en);
  if (tr == null) {
    // Development aid: window.__i18nMissing lists on-screen text with no translation yet (e.g. labels sent by the API).
    if (import.meta.env.DEV && /[A-Za-z]{3,}/.test(en)) ((window as unknown as { __i18nMissing?: Set<string> }).__i18nMissing ??= new Set()).add(en.replace(/\s+/g, ' ').trim());
    if (prev && value === prev.out) node.nodeValue = prev.en;
    textOriginal.delete(node);
    return;
  }
  const lead = en.match(/^\s*/)?.[0] ?? '';
  const trail = en.match(/\s*$/)?.[0] ?? '';
  const out = lead + tr + trail;
  if (value !== out) node.nodeValue = out;
  if (!prev) touchedTexts.add(new WeakRef(node));
  textOriginal.set(node, { en, out });
}

function translateAttrs(el: Element) {
  if (skip(el)) return;
  let rec = attrOriginal.get(el);
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const value = el.getAttribute(a) ?? '';
    const prev = rec?.[a];
    const en = prev && value === prev.out ? prev.en : value;
    if (lang === 'en') {
      if (prev && value === prev.out) el.setAttribute(a, prev.en);
      if (rec) delete rec[a];
      continue;
    }
    const tr = translateText(en);
    if (tr == null) continue;
    if (value !== tr) el.setAttribute(a, tr);
    if (!rec) {
      rec = {};
      attrOriginal.set(el, rec);
      touchedEls.add(new WeakRef(el));
    }
    rec[a] = { en, out: tr };
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const el = root as Element;
  if (el.nodeType === Node.ELEMENT_NODE) {
    if (SKIP_TAGS.has(el.tagName)) return;
    translateAttrs(el);
  }
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateTextNode(n as Text);
    else translateAttrs(n as Element);
  }
}

function flush() {
  scheduled = false;
  const nodes = pending;
  pending = new Set();
  observer?.disconnect();
  try {
    for (const n of nodes) if (n.isConnected) walk(n);
  } finally {
    observer?.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  }
}

function queue(n: Node) {
  pending.add(n);
  scheduled = true;
}

function restoreAll() {
  for (const ref of touchedTexts) {
    const n = ref.deref();
    if (!n) continue;
    const rec = textOriginal.get(n);
    if (rec && n.nodeValue === rec.out) n.nodeValue = rec.en;
    textOriginal.delete(n);
  }
  touchedTexts.clear();
  for (const ref of touchedEls) {
    const el = ref.deref();
    if (!el) continue;
    const rec = attrOriginal.get(el);
    if (rec) for (const [a, v] of Object.entries(rec)) if (el.getAttribute(a) === v.out) el.setAttribute(a, v.en);
    attrOriginal.delete(el);
  }
  touchedEls.clear();
}

/** Switches the whole page to a language ('en' restores the original English). */
export async function applyLanguage(next: string) {
  if (next === lang && (next === 'en' || dict)) return;
  observer?.disconnect();
  observer = null;
  restoreAll();
  memo.clear();
  lang = next;
  if (next === 'en' || !loaders[next]) {
    dict = null;
    lang = 'en';
    return;
  }
  const mod = await loaders[next]();
  if (lang !== next) return; // switched again while loading
  dict = mod.default;
  compile(dict);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') queue(r.target);
      else if (r.type === 'attributes') queue(r.target);
      else r.addedNodes.forEach((n) => queue(n));
    }
    // Translate right away: observer callbacks run before the browser paints, so English never flashes —
    // and this also works in background tabs, where animation frames are paused.
    if (scheduled) flush();
  });
  walk(document.body);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
}
