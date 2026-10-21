// Draws the We School logo mark and renders every icon the web and mobile apps ship.
//   node tools/brand-render.mjs
// The mark: a rounded tile in the brand magenta, a white "W" whose middle peak and gold dot read as a
// person among people ("we"), over the shape of an open book. Colours are the brand tokens in
// apps/web/src/styles/holysai.css (--brand-hover, --brand, --brand-strong, --accent, --gold-deep-fill).
// Edit the geometry here, then re-run to regenerate the files listed in OUTPUTS.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(path.resolve('apps/api/package.json'));
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const BRAND = { light: '#B30042', base: '#990033', deep: '#4A0A22', gold: '#FFDB6E', goldDeep: '#E3B04B', paper: '#FAF8F6' };

// Geometry on a 64-unit square.
const W_PATH = 'M13 25 L22.5 47 L32 31 L41.5 47 L51 25';
const DOT = { cx: 32, cy: 17.5, r: 5 };
const STROKE = 6;

/**
 * The mark as SVG.
 *   tile: 'rounded' (app icon look) | 'square' (full bleed, the OS rounds it) | 'none' (glyph only)
 *   scale: size of the glyph inside the canvas (1 = as drawn on the tile)
 *   mono: one colour for everything (Android themed icon)
 */
function markSvg({ tile = 'rounded', scale = 1, mono = null, size = 64 } = {}) {
  const fg = mono ?? '#FFFFFF';
  const dot = mono ?? 'url(#gold)';
  const t = (32 * (1 - scale)).toFixed(3);
  const bg =
    tile === 'rounded' ? '<rect width="64" height="64" rx="15" fill="url(#tile)"/>'
    : tile === 'square' ? '<rect width="64" height="64" fill="url(#tile)"/>'
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
<defs>
<linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND.light}"/><stop offset=".55" stop-color="${BRAND.base}"/><stop offset="1" stop-color="${BRAND.deep}"/></linearGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BRAND.gold}"/><stop offset="1" stop-color="${BRAND.goldDeep}"/></linearGradient>
</defs>
${bg}<g transform="translate(${t} ${t}) scale(${scale})">
<path d="${W_PATH}" fill="none" stroke="${fg}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="${dot}"/>
</g>
</svg>
`;
}

/** Background for the Android adaptive icon: the tile gradient, full bleed. */
const backgroundSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
<defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BRAND.light}"/><stop offset=".55" stop-color="${BRAND.base}"/><stop offset="1" stop-color="${BRAND.deep}"/></linearGradient></defs>
<rect width="64" height="64" fill="url(#tile)"/>
</svg>
`;

async function png(svg, size, file, { pad = 0, background = null } = {}) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
  }
  const img = await loadImage(Buffer.from(svg));
  ctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);
  writeFileSync(file, canvas.toBuffer('image/png'));
  console.log(`${file} (${size}×${size})`);
}

const web = 'apps/web/public';
const mobile = 'apps/mobile/assets';

// Vector mark, used by the web app (Lotus / LogoLockup) and the browser tab.
writeFileSync(`${web}/logo-mark.svg`, markSvg());
console.log(`${web}/logo-mark.svg`);

// Web icons. homescreen.png is the iOS/Android "add to home screen" icon: full bleed, no transparency.
await png(markSvg({ size: 512 }), 256, `${web}/favicon.png`);
await png(markSvg({ size: 512 }), 64, `${web}/favicon-64.png`);
await png(markSvg({ tile: 'square', scale: 0.86, size: 512 }), 180, `${web}/homescreen.png`);

// Mobile. iOS rounds icon.png itself; the splash shows the tile on the paper background.
await png(markSvg({ tile: 'square', scale: 0.86, size: 1024 }), 1024, `${mobile}/icon.png`);
await png(markSvg({ size: 1024 }), 512, `${mobile}/splash-icon.png`, { pad: 32 });
await png(markSvg({ size: 512 }), 64, `${mobile}/favicon.png`);
await png(markSvg({ size: 1024 }), 288, `${mobile}/images/logo-mark.png`);
// Android adaptive icon: 108dp canvas, the launcher shows the middle 72dp and may crop to a 66dp circle,
// so the glyph is drawn at 62 % of the canvas.
await png(markSvg({ tile: 'none', scale: 0.62, size: 1024 }), 1024, `${mobile}/android-icon-foreground.png`);
await png(backgroundSvg(1024), 1024, `${mobile}/android-icon-background.png`);
await png(markSvg({ tile: 'none', scale: 0.62, mono: '#FFFFFF', size: 1024 }), 1024, `${mobile}/android-icon-monochrome.png`);
