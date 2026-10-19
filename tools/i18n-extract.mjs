// Extracts user-visible English strings from the web app source for translation.
// Output: apps/web/src/i18n/strings.json = { texts: string[], patterns: string[] }
//   texts    — exact strings (JSX text, UI props, string literals that look like copy)
//   patterns — template literals with ${…} replaced by {0}, {1}… (matched as regexes at runtime)
// Usage: node tools/i18n-extract.mjs
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = path.resolve('apps/web/src');
const out = path.join(root, 'i18n/strings.json');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) {
      if (!['i18n', 'styles'].includes(f)) walk(p);
    } else if (/\.(tsx|ts)$/.test(f) && !f.endsWith('.d.ts')) files.push(p);
  }
})(root);

// Props whose string values are shown to people.
const UI_PROPS = new Set([
  'title', 'sub', 'label', 'placeholder', 'hint', 'emptyText', 'aria-label', 'alt', 'confirmLabel', 'body', 'meta', 'text',
  'children', 'tooltip', 'caption', 'description', 'subtitle', 'heading', 'name', 'cta', 'action', 'note', 'summary', 'message',
  'success', 'error', 'allLabel', 'value', 'detail', 'reason', 'help', 'empty', 'question', 'answer', 'tip', 'status',
]);
// Strings that are code, not copy.
const CODEY = [
  /^\s*$/,
  /^[a-z0-9_.:\/-]+$/, // identifiers, keys, paths, css tokens
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.source && /^[a-z]+[A-Z][A-Za-z0-9]*$/, // camelCase
  /^(\/|https?:|mailto:|#|data:|var\(|rgba?\(|url\()/,
  /^[\d\s.,:%₹+\-–—/()]+$/, // numbers and punctuation only
  /^[A-Z0-9_]+$/, // CONSTANTS
  /\b(g-\d|t-[a-z]+|mt-\d|mb-\d|row|col|grid|btn|card|badge|oi-|pc-|is-|has-)\b/, // class lists
  /^[a-z]+(\s[a-z-]+)*$/, // lowercase space-separated tokens (class lists, enum words)
  /\$\{/,
];
const isCopy = (s) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 400) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (CODEY.some((re) => re instanceof RegExp && re.test(t))) {
    // keep Title Case single words and short phrases starting with a capital
    if (!/^[A-Z][a-z]/.test(t)) return false;
    if (/^[A-Z][a-z]+[A-Z]/.test(t) && !t.includes(' ')) return false; // PascalCase identifiers
  }
  return true;
};

const texts = new Set();
const patterns = new Set();

function templateToPattern(node, sf) {
  let s = node.head.text;
  node.templateSpans.forEach((span, i) => {
    s += `{${i}}` + span.literal.text;
  });
  return s.replace(/\s+/g, ' ').trim();
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const t = node.text.replace(/\s+/g, ' ').trim();
      if (t && /[A-Za-z]/.test(t)) texts.add(t);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const t = node.text.replace(/\s+/g, ' ').trim();
      // Skip imports, object keys, comparisons, css/className, routes, API paths.
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return;
      if (ts.isJsxAttribute(parent)) {
        const name = parent.name.getText(sf);
        if (UI_PROPS.has(name) && isCopy(t)) texts.add(t);
        return;
      }
      if (ts.isPropertyAssignment(parent) && parent.name === node) return;
      if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(parent.operatorToken.kind)) {
        // enum values compared in code are often also shown (e.g. 'Under Review'); keep if they look like copy
        if (isCopy(t) && /^[A-Z]/.test(t)) texts.add(t);
        return;
      }
      if (ts.isCallExpression(parent)) {
        const callee = parent.expression.getText(sf);
        if (/^(api\.|useApi|usePaged|navigate|setSp|localStorage|document\.|console\.|new URL|fetch|require|import|qc\.|cx|clsx)/.test(callee)) return;
      }
      if (isCopy(t)) texts.add(t);
    } else if (ts.isTemplateExpression(node)) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && /^(api\.|useApi|usePaged|navigate)/.test(parent.expression.getText(sf))) return;
      const p = templateToPattern(node, sf);
      const staticPart = p.replace(/\{\d+\}/g, '').trim();
      if (/[A-Za-z]{3}/.test(staticPart) && !/^[\/#]|className|https?:/.test(p) && !/^[a-z0-9_.\/{}:-]+$/.test(p)) patterns.add(p);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// Markup, CSS and class lists are not copy.
const NOISE = [/</, /="/, /[{};]\s*$/, /__/, /^[a-z][a-z0-9-]*(\s+[a-z][a-z0-9-]*)*(\s+\{\d+\})*$/, /^\{\d+\}(\s*\{\d+\})*$/, /^[a-z-]+--/, /\bvar\(--/, /^\.[a-z]/];
const clean = (s) => !NOISE.some((re) => re.test(s));
const sortedTexts = [...texts].filter((t) => !/^\{\d+\}$/.test(t) && clean(t)).sort((a, b) => a.localeCompare(b));
const sortedPatterns = [...patterns].filter((p) => /[A-Za-z]{3}/.test(p.replace(/\{\d+\}/g, '')) && clean(p)).sort((a, b) => a.localeCompare(b));
writeFileSync(out, JSON.stringify({ texts: sortedTexts, patterns: sortedPatterns }, null, 1));
console.log(`${files.length} files → ${sortedTexts.length} texts, ${sortedPatterns.length} patterns → ${path.relative(process.cwd(), out)}`);
