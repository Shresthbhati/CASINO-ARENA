/**
 * Render the app icons (PNG) from `public/icons/icon.svg` with a real browser, so the committed PNGs are
 * reproducible: `node scripts/qa/make-icons.mjs`.
 *
 * Produces: icon-192.png, icon-512.png (rounded, transparent corners), icon-maskable-512.png (full-bleed
 * with the mark inside the maskable safe zone) and apple-touch-icon.png (180px, opaque, as iOS wants).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const dir = fileURLToPath(new URL('../../public/icons/', import.meta.url));
const svg = readFileSync(`${dir}icon.svg`, 'utf8');
const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const plain = (size) => `<body style="margin:0;background:transparent"><img src="${uri}" width="${size}" height="${size}" style="display:block"></body>`;
const maskable = (size) =>
  `<body style="margin:0;background:#121012"><svg width="${size}" height="${size}" viewBox="0 0 512 512" style="display:block"><rect width="512" height="512" fill="#121012"/><image href="${uri}" x="76" y="76" width="360" height="360"/></svg></body>`;
const opaque = (size) => `<body style="margin:0;background:#121012"><img src="${uri}" width="${size}" height="${size}" style="display:block"></body>`;

const jobs = [
  ['icon-192.png', 192, plain, true],
  ['icon-512.png', 512, plain, true],
  ['icon-maskable-512.png', 512, maskable, false],
  ['apple-touch-icon.png', 180, opaque, false],
];

const browser = await launch();
try {
  for (const [name, size, html, transparent] of jobs) {
    const page = await browser.open('about:blank', { width: size, height: size, dpr: 1 });
    await page.send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : { color: { r: 18, g: 16, b: 18, a: 1 } });
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html(size))}`);
    const r = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 }, fromSurface: true });
    writeFileSync(`${dir}${name}`, Buffer.from(r.data, 'base64'));
    console.log(`wrote ${name} (${size}x${size})`);
    await page.close();
  }
} finally {
  await browser.close();
}
