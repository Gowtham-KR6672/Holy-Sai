// Builds apps/web/src/i18n/dict/<lang>.json from translation parts.
//   node tools/i18n-merge.mjs split [chunks]   → writes apps/web/src/i18n/work/chunk-N.json from strings.json
//   node tools/i18n-merge.mjs merge            → merges dict/parts/<lang>-*.json (+ the original 153 translations) into dict/<lang>.json
// Each part file is { "English text or {0} template": "translation", ... }.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const base = path.resolve('apps/web/src/i18n');
const mode = process.argv[2];

if (mode === 'split') {
  const n = Number(process.argv[3] ?? 4);
  const { texts, patterns } = JSON.parse(readFileSync(path.join(base, 'strings.json'), 'utf8'));
  // Only strings that are not yet translated in every language.
  const done = (s) => ['ta', 'hi'].every((l) => {
    const f = path.join(base, 'dict', `${l}.json`);
    if (!existsSync(f)) return false;
    const d = JSON.parse(readFileSync(f, 'utf8'));
    return d.texts?.[s] || d.patterns?.[s];
  });
  const all = [...texts, ...patterns].filter((s) => !done(s));
  mkdirSync(path.join(base, 'work'), { recursive: true });
  const size = Math.ceil(all.length / n);
  for (let i = 0; i < n; i++) {
    const chunk = all.slice(i * size, (i + 1) * size);
    writeFileSync(path.join(base, 'work', `chunk-${i + 1}.json`), JSON.stringify(chunk, null, 1));
    console.log(`chunk-${i + 1}.json: ${chunk.length} strings`);
  }
} else if (mode === 'merge') {
  const legacy = JSON.parse(readFileSync(path.resolve('reference/original-i18n.json'), 'utf8'));
  const { texts, patterns } = JSON.parse(readFileSync(path.join(base, 'strings.json'), 'utf8'));
  const patternSet = new Set(patterns);
  const partsDir = path.join(base, 'dict', 'parts');
  for (const lang of ['ta', 'hi']) {
    const file = path.join(base, 'dict', `${lang}.json`);
    const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { texts: {}, patterns: {} };
    const out = { texts: { ...legacy[lang], ...current.texts }, patterns: { ...current.patterns } };
    if (existsSync(partsDir)) {
      for (const f of readdirSync(partsDir).filter((x) => x.startsWith(`${lang}-`) && x.endsWith('.json'))) {
        const part = JSON.parse(readFileSync(path.join(partsDir, f), 'utf8'));
        for (const [en, tr] of Object.entries(part)) {
          if (typeof tr !== 'string' || !tr.trim()) continue;
          if (patternSet.has(en) || /\{\d+\}/.test(en)) out.patterns[en] = tr;
          else out.texts[en] = tr;
        }
      }
    }
    const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(file, JSON.stringify({ texts: sortObj(out.texts), patterns: sortObj(out.patterns) }, null, 1));
    const missing = texts.filter((t) => !out.texts[t]).length + patterns.filter((p) => !out.patterns[p]).length;
    console.log(`${lang}: ${Object.keys(out.texts).length} texts, ${Object.keys(out.patterns).length} patterns, ${missing} still untranslated`);
  }
} else {
  console.log('Usage: node tools/i18n-merge.mjs split [chunks] | merge');
}
