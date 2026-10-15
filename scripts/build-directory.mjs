// Build src/board-directory.json: the companies applio searches when "search all companies" is on.
// For each name in scripts/company-names.txt (plus any boards already in the directory), try the
// obvious board slugs on Greenhouse, Lever and Ashby and keep the ones that list at least one job.
//
//   node scripts/build-directory.mjs            # rebuild
//   node scripts/build-directory.mjs --add "Acme Corp" "Globex"   # check and add a few names
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = new URL('../src/board-directory.json', import.meta.url);
const NAMES = new URL('./company-names.txt', import.meta.url);
const UA = { 'user-agent': 'applio-directory-builder' };

const args = process.argv.slice(2);
const adding = args[0] === '--add';
const names = adding ? args.slice(1) : readFileSync(NAMES, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];

const slugsFor = name => [...new Set([
  name.toLowerCase().replace(/[^a-z0-9]/g, ''),
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
])].filter(Boolean);

async function get(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
  return res.ok ? res.json() : null;
}
const CHECK = {
  greenhouse: async s => { const d = await get(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`); return d?.jobs?.length ? { n: d.jobs.length, name: d.jobs[0].company_name } : 0; },
  lever: async s => { const d = await get(`https://api.lever.co/v0/postings/${s}?mode=json&limit=200`); return Array.isArray(d) ? d.length : 0; },
  ashby: async s => (await get(`https://api.ashbyhq.com/posting-api/job-board/${s}`))?.jobs?.length || 0,
};

const tasks = names.flatMap(name => slugsFor(name).flatMap(slug => Object.keys(CHECK).map(ats => ({ name, slug, ats }))));
const found = new Map(existing.map(e => [`${e.ats}:${e.slug}`, e]));
let done = 0;
async function worker() {
  for (let t; (t = tasks.shift());) {
    const key = `${t.ats}:${t.slug}`;
    if (!found.has(key)) {
      try {
        const r = await CHECK[t.ats](t.slug);
        const n = typeof r === 'object' ? r.n : r;
        // Greenhouse reports the board's real company name; use it so a slug collision is visible.
        if (n > 0) found.set(key, { ats: t.ats, slug: t.slug, name: (typeof r === 'object' && r.name) || t.name, asked: t.name, jobs: n });
      } catch { /* network hiccup: skip */ }
    }
    if (++done % 200 === 0) console.error(`${done} checks, ${found.size} boards`);
  }
}
await Promise.all(Array.from({ length: 16 }, worker));

// One board per company name: prefer the one with the most jobs.
const byName = new Map();
for (const e of found.values()) { const k = (e.asked || e.name).toLowerCase(); if (!byName.has(k) || byName.get(k).jobs < e.jobs) byName.set(k, e); }
const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ ats, slug, name }) => ({ ats, slug, name }));
writeFileSync(OUT, JSON.stringify(list, null, 0).replace(/},{/g, '},\n{') + '\n');
const per = list.reduce((m, e) => (m[e.ats] = (m[e.ats] || 0) + 1, m), {});
console.log(`${list.length} company boards (${Object.entries(per).map(([k, v]) => `${k} ${v}`).join(', ')}) → src/board-directory.json`);
