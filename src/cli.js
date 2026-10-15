#!/usr/bin/env node
// applio — command-line front end for the job application pipeline.
//   discover (scan) → score (jobs) → tailor → approve → apply → track (board)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// Re-exec once with the runtime flags we need:
//  - Node 22.5–22.12 only exposes node:sqlite behind --experimental-sqlite (22.13+ accepts it as a no-op).
//  - Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set.
const [major, minor] = process.versions.node.split('.').map(Number);
const needsSqliteFlag = (major < 22 || (major === 22 && minor < 13)) && !process.execArgv.includes('--experimental-sqlite');
const needsProxyEnv = !!(process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY;
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`applio needs Node.js 22.5 or newer (you have ${process.version}). Install the current LTS from https://nodejs.org`);
  process.exit(1);
}
if (needsSqliteFlag || needsProxyEnv) {
  const flags = ['--no-warnings', ...(needsSqliteFlag ? ['--experimental-sqlite'] : [])];
  const r = spawnSync(process.execPath, [...flags, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, ...(needsProxyEnv ? { NODE_USE_ENV_PROXY: '1' } : {}) } });
  process.exit(r.status ?? 1);
}

const { open, STATUSES } = await import('./db.js');
const { rank } = await import('./match.js');
const { loadProfile } = await import('./profile.js');
const actions = await import('./actions.js');
const store = await import('./store.js');
const { rowToJob } = actions;

const HELP = `applio — self-hosted job application agent

Usage: applio <command> [options]

  scan                       Pull every board in the watchlist, store new jobs, score them
  watch [--every 30]         Run scan every N minutes and print new matches
  jobs [--min 60] [--limit 25] [--all]
                             List matched jobs, best first
  show <job>                 Posting details, score reasons and history
  tailor <job> | --top N     Tailor résumé + cover letter with the AI provider
                             (set it up in dashboard Settings → Integrations, or ANTHROPIC_API_KEY / OPENAI_API_KEY)
  approve <job>              Mark tailored materials as reviewed and OK to send
  apply <job> [--submit] [--headed] [--base]
                             Fill the application form. Without --submit it stops before
                             sending and saves a screenshot + receipt. --submit requires approval.
                             --base uses your untailored résumé.
  mark <job> <status>        Set status manually (${STATUSES.join(', ')})
  skip <job>                 Mark a job as not interesting
  board                      Pipeline overview by status
  serve [--port 4317] [--host 127.0.0.1]
                             Start the web dashboard

<job> is a job id or any unique fragment of it (e.g. the numeric posting id).
Data lives in data/applio.db; generated files in out/.`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const { values: opt, positionals: pos } = parseArgs({
  args: argv.slice(1), allowPositionals: true, strict: false,
  options: {
    port: { type: 'string' }, host: { type: 'string' },
    min: { type: 'string' }, limit: { type: 'string' }, top: { type: 'string' }, every: { type: 'string' },
    submit: { type: 'boolean' }, headed: { type: 'boolean' }, base: { type: 'boolean' }, all: { type: 'boolean' },
    db: { type: 'string', default: process.env.APPLIO_DB || 'data/applio.db' },
  },
});

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m` };
const pad = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); };
const shortId = id => id.split(':').slice(1).join(':');

async function main() {
  store.useDb(opt.db);
  if (cmd && cmd !== 'help' && cmd !== '--help') store.migrateLegacyFiles({ log: m => console.log(c.dim(m)) });
  switch (cmd) {
    case 'init': return init();
    case 'scan': return scan();
    case 'watch': return watch();
    case 'jobs': return jobs();
    case 'show': return show(pos[0]);
    case 'tailor': return tailorCmd();
    case 'approve': return mark(pos[0], 'approved');
    case 'skip': return mark(pos[0], 'skipped');
    case 'mark': return mark(pos[0], pos[1]);
    case 'apply': return apply(pos[0]);
    case 'board': return board();
    case 'serve': {
      const { serve } = await import('./server.js');
      return serve({ port: Number(opt.port || process.env.PORT || 4317), host: opt.host || '127.0.0.1', dbPath: opt.db });
    }
    default: console.log(HELP); if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

function init() {
  console.log(`Setup now happens in the dashboard: run ${c.bold('npm run dashboard')} and open http://localhost:4317 —\nit walks you through uploading your résumé, your profile and the companies to watch.`);
}

async function scan({ quiet = false } = {}) {
  const db = open(opt.db);
  const r = await actions.scan(db, { log: line => !quiet && console.log(c.dim('  ' + line)) });
  if (quiet) console.log(`${r.open} open roles, ${r.fresh} new, ${r.matches} new matches.`);
  for (const m of r.newMatches.slice(0, 15)) console.log(`  ${c.bold(String(m.score).padStart(3))}  ${pad(m.row.company, 12)} ${pad(m.row.title, 52)} ${c.dim(shortId(m.row.id))}`);
  return r.newMatches;
}

async function watch() {
  const every = Number(opt.every || 30);
  console.log(`Watching every ${every} min. Ctrl-C to stop.`);
  for (;;) {
    console.log(c.dim(`\n[${new Date().toLocaleTimeString()}] scanning…`));
    try { await scan({ quiet: true }); } catch (e) { console.error(c.red(e.message)); }
    await new Promise(r => setTimeout(r, every * 60_000));
  }
}

function jobs() {
  const db = open(opt.db);
  const min = Number(opt.min ?? 0), limit = Number(opt.limit ?? 25);
  let rows = db.board().filter(r => (r.score ?? 0) >= min && (opt.all || !['skipped', 'rejected'].includes(r.status)));
  if (!rows.length) {
    // Nothing stored yet — rank on the fly so a fresh install still shows something useful.
    const prefs = loadProfile().preferences;
    rows = rank(db.openJobs().map(rowToJob), prefs).filter(r => r.score >= min).map(r => ({ job_id: r.job.id, score: r.score, status: 'new', company: r.job.company, title: r.job.title, location: r.job.location }));
  }
  console.log(c.dim(`${pad('score', 6)}${pad('status', 12)}${pad('company', 13)}${pad('title', 50)}${pad('location', 26)}id`));
  for (const r of rows.slice(0, limit)) {
    console.log(`${pad(r.score, 6)}${pad(r.status, 12)}${pad(r.company, 13)}${pad(r.title, 50)}${pad(r.location, 26)}${c.dim(shortId(r.job_id))}`);
  }
  if (rows.length > limit) console.log(c.dim(`… ${rows.length - limit} more (--limit)`));
}

function show(ref) {
  const db = open(opt.db), id = db.resolve(ref), j = db.job(id), a = db.app(id);
  console.log(`${c.bold(j.title)} — ${j.company}\n${j.location}${j.remote ? ' (remote ok)' : ''} · ${j.ats} · posted ${j.posted_at || 'unknown'}${j.closed ? c.red(' · CLOSED') : ''}\n${j.url}\napply: ${j.apply_url}`);
  if (a) {
    console.log(`\nstatus ${c.bold(a.status)} · score ${a.score}`);
    for (const r of JSON.parse(a.reasons || '[]')) console.log(c.dim(`  • ${r}`));
    if (a.tailored_path) console.log(`tailored: ${a.tailored_path}`);
    if (a.receipt_path) console.log(`receipt: ${a.receipt_path}`);
    if (a.note) console.log(c.yellow(`note: ${a.note}`));
  }
  console.log('\n' + (j.description || '(no description)').slice(0, 1500) + (j.description?.length > 1500 ? c.dim('\n…') : ''));
  const ev = db.events(id);
  if (ev.length) { console.log(c.dim('\nhistory')); for (const e of ev) console.log(c.dim(`  ${e.at.slice(0, 16)} ${e.kind} ${e.detail}`)); }
}

async function tailorCmd() {
  const db = open(opt.db);
  const ids = opt.top ? actions.topMatched(db, Number(opt.top)) : [db.resolve(pos[0])];
  if (!ids.length) return console.log('No matched jobs waiting. Run "applio scan" first.');
  for (const id of ids) {
    const r = await actions.tailorJob(db, id, { log: line => console.log(c.dim('  ' + line)) });
    console.log(`  review ${join(r.dir, 'changes.md')}`);
  }
  console.log(`\nReview the changes, then ${c.bold('applio approve <job>')} and ${c.bold('applio apply <job> --submit')}.`);
}

function mark(ref, status) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}"`);
  const db = open(opt.db), id = db.resolve(ref);
  const cur = db.app(id);
  if (status === 'approved' && !cur?.tailored_path) console.log(c.yellow('Note: no tailored materials yet; approving the base résumé.'));
  db.setApp(id, { status, ...(cur ? {} : { score: 0 }) });
  console.log(`${shortId(id)} → ${status}`);
}

async function apply(ref) {
  const db = open(opt.db), id = db.resolve(ref);
  console.log(c.dim(db.job(id).apply_url));
  const result = await actions.applyJob(db, id, { submit: !!opt.submit, headed: !!opt.headed, base: !!opt.base, log: line => console.log(line) });
  for (const f of result.receipt.fields) {
    const mark = f.source === 'missing' || String(f.source).startsWith('error') ? (f.required ? c.red('✗') : c.yellow('○')) : c.green('✓');
    const v = typeof f.value === 'string' ? f.value.replace(/\s+/g, ' ') : String(f.value ?? '');
    console.log(`  ${mark} ${pad(f.label || '(unlabelled)', 48)} ${pad(v, 60)} ${c.dim(f.source)}`);
  }
  console.log(c.dim(`Screenshot and receipt: ${result.dir}`));
}

function board() {
  const db = open(opt.db);
  const counts = Object.fromEntries(db.counts().map(r => [r.status, r.n]));
  console.log(STATUSES.filter(s => counts[s]).map(s => `${s} ${c.bold(counts[s])}`).join('  ·  ') || 'Nothing yet. Run "applio scan".');
  for (const s of ['needs_input', 'approved', 'tailored', 'submitted', 'interview']) {
    const rows = db.board(s);
    if (!rows.length) continue;
    console.log(`\n${c.bold(s.toUpperCase())}`);
    for (const r of rows.slice(0, 10)) console.log(`  ${pad(r.company, 12)} ${pad(r.title, 50)} ${c.dim(r.updated_at.slice(0, 10))} ${r.note ? c.yellow(r.note) : ''}`);
  }
}

main().catch(e => { console.error(c.red(`error: ${e.message}`)); process.exitCode = 1; });
