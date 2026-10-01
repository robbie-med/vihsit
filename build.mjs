// Builds the single self-contained file: node build.mjs -> dist/vihsit.html
// Inlines CSS, fonts (base64) and scripts, then writes a CSP that allows exactly those inline blocks and no network.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// LF only: git normalizes line endings, and the CSP hashes must match the committed bytes.
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const b64 = p => readFileSync(new URL(p, import.meta.url)).toString('base64');
const hash = s => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

const css = read('./src/style.css')
  .replace('url(FONT_NEXT)', `url(data:font/woff2;base64,${b64('./fonts/atkinson-next.woff2')})`)
  .replace('url(FONT_MONO)', `url(data:font/woff2;base64,${b64('./fonts/atkinson-mono.woff2')})`);
const scripts = [read('./src/core.js'), read('./src/app.js')];

const csp = [
  "default-src 'none'",
  "connect-src 'none'",
  `script-src ${scripts.map(hash).join(' ')}`,
  `style-src ${hash(css)}`,
  'font-src data:',
  'img-src data:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const html = read('./src/index.html')
  .replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
  .replace('<!--STYLE-->', () => `<style>${css}</style>`)
  .replace('<!--SCRIPTS-->', () => scripts.map(s => `<script>${s}</script>`).join('\n'));

mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/vihsit.html', import.meta.url), html);
console.log(`dist/vihsit.html  ${(html.length / 1024).toFixed(0)} KB`);
