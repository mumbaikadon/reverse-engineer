// Résumé markdown → clean single-column HTML → PDF (ATS parsers handle simple PDFs best).
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
  .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

export function markdownToHtml(md) {
  const out = [];
  let inList = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (!li && inList) { out.push('</ul>'); inList = false; }
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(li[1])}</li>`); }
    else if (/^#\s/.test(line)) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (/^##\s/.test(line)) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (/^###\s/.test(line)) out.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Helvetica,Arial,sans-serif;font-size:10.5pt;line-height:1.35;color:#111;margin:0}
    h1{font-size:20pt;margin:0 0 2pt} h2{font-size:11pt;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #999;margin:12pt 0 4pt;padding-bottom:2pt}
    h3{font-size:10.5pt;margin:8pt 0 2pt} p{margin:2pt 0} ul{margin:2pt 0 4pt 14pt;padding:0} li{margin:1pt 0} a{color:#111}
  </style></head><body>${out.join('\n')}</body></html>`;
}

export function launchOptions(extra = {}) {
  // Use a system Chromium if Playwright's own browser download is not present.
  const fallback = process.env.APPLIO_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const opts = { ...extra };
  if (process.env.APPLIO_CHROMIUM || (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(fallback))) opts.executablePath = fallback;
  if (process.env.HTTPS_PROXY) opts.proxy = { server: process.env.HTTPS_PROXY };
  return opts;
}

export async function renderPdf(md, path) {
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(markdownToHtml(md), { waitUntil: 'load' });
    await page.pdf({ path, format: 'Letter', margin: { top: '0.5in', bottom: '0.5in', left: '0.6in', right: '0.6in' }, printBackground: true });
  } finally { await browser.close(); }
  return path;
}
