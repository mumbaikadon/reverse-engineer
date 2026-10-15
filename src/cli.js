#!/usr/bin/env node
// applio — command-line front end for the job application pipeline.
//   discover (scan) → score (jobs) → tailor → approve → apply → track (board)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set; re-exec once with it.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, ['--no-warnings', ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status ?? 1);
}

const { open, STATUSES } = await import('./db.js');
const { scanAll } = await import('./sources/index.js');
const { rank, score } = await import('./match.js');
const { loadProfile, loadResume, loadCompanies } = await import('./profile.js');
const { hasCredentials, MODEL } = await import('./llm.js');

const HELP = `applio — self-hosted job application agent

Usage: applio <command> [options]

  init                       Create config/profile.json, config/companies.json, resume/resume.md
  scan                       Pull every board in the watchlist, store new jobs, score them
  watch [--every 30]         Run scan every N minutes and print new matches
  jobs [--min 60] [--limit 25] [--all]
                             List matched jobs, best first
  show <job>                 Posting details, score reasons and history
  tailor <job> | --top N     Tailor résumé + cover letter with Claude (needs ANTHROPIC_API_KEY)
  approve <job>              Mark tailored materials as reviewed and OK to send
  apply <job> [--submit] [--headed] [--base]
                             Fill the application form. Without --submit it stops before
                             sending and saves a screenshot + receipt. --submit requires approval.
                             --base uses your untailored résumé.
  mark <job> <status>        Set status manually (${STATUSES.join(', ')})
  skip <job>                 Mark a job as not interesting
  board                      Pipeline overview by status

<job> is a job id or any unique fragment of it (e.g. the numeric posting id).
Data lives in data/applio.db; generated files in out/.`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const { values: opt, positionals: pos } = parseArgs({
  args: argv.slice(1), allowPositionals: true, strict: false,
  options: {
    min: { type: 'string' }, limit: { type: 'string' }, top: { type: 'string' }, every: { type: 'string' },
    submit: { type: 'boolean' }, headed: { type: 'boolean' }, base: { type: 'boolean' }, all: { type: 'boolean' },
    db: { type: 'string', default: process.env.APPLIO_DB || 'data/applio.db' },
  },
});

const c = { dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m` };
const pad = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); };
const shortId = id => id.split(':').slice(1).join(':');

async function main() {
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
    default: console.log(HELP); if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

function init() {
  for (const [src, dst] of [['config/profile.example.json', 'config/profile.json'], ['config/companies.example.json', 'config/companies.json'], ['resume/resume.example.md', 'resume/resume.md']]) {
    if (existsSync(dst)) console.log(c.dim(`exists  ${dst}`));
    else { copyFileSync(src, dst); console.log(`created ${dst}`); }
  }
  console.log(`\nNext: edit those three files with your details, then run ${c.bold('applio scan')}.`);
}

async function scan({ quiet = false } = {}) {
  const db = open(opt.db), profile = loadProfile(), companies = loadCompanies();
  const t0 = Date.now();
  const { jobs: found, errors } = await scanAll(companies, {
    onBoard: (co, n, err) => !quiet && console.log(c.dim(`  ${pad(co.name || co.slug || co.tenant, 14)} ${err ? c.red(err.message) : `${n} open roles`}`)),
  });
  const fresh = db.saveJobs(found);
  const closed = db.closeMissing(companies.filter(co => !errors.some(e => e.company === co)).map(co => co.slug || co.tenant), found.map(j => j.id));

  // Score anything without an application row yet; keep the ones above the bar.
  const prefs = profile.preferences;
  const min = prefs.minScore ?? 60;
  const newMatches = [];
  for (const row of db.openJobs()) {
    if (db.app(row.id)) continue;
    const r = score(rowToJob(row), prefs);
    if (r.excluded || r.score < min) continue;
    db.setApp(row.id, { status: 'matched', score: r.score, reasons: JSON.stringify(r.reasons) });
    newMatches.push({ row, ...r });
  }
  console.log(`\nScanned ${companies.length} boards in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${found.length} open roles, ${fresh.length} new, ${closed} closed, ${errors.length} board errors.`);
  console.log(`${c.green(newMatches.length + ' new matches')} at score ≥ ${min}.`);
  for (const m of newMatches.sort((a, b) => b.score - a.score).slice(0, 15)) console.log(`  ${c.bold(String(m.score).padStart(3))}  ${pad(m.row.company, 12)} ${pad(m.row.title, 52)} ${c.dim(shortId(m.row.id))}`);
  return newMatches;
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

function rowToJob(r) {
  return { id: r.id, ats: r.ats, company: r.company, title: r.title, location: r.location, remote: !!r.remote, description: r.description || '', postedAt: r.posted_at, externalId: r.external_id, url: r.url, applyUrl: r.apply_url };
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
  if (!hasCredentials()) throw new Error('Set ANTHROPIC_API_KEY to tailor résumés with Claude.');
  const { tailor } = await import('./tailor.js');
  const { renderPdf } = await import('./render.js');
  const db = open(opt.db), profile = loadProfile(), resume = loadResume();
  const ids = opt.top
    ? db.board('matched').slice(0, Math.min(Number(opt.top), profile.preferences.dailyTailorLimit ?? 15)).map(r => r.job_id)
    : [db.resolve(pos[0])];
  if (!ids.length) return console.log('No matched jobs waiting. Run "applio scan" first.');
  for (const id of ids) {
    const job = rowToJob(db.job(id));
    process.stdout.write(`Tailoring ${job.title} @ ${job.company} with ${MODEL}… `);
    const r = await tailor({ job, profile, resume });
    await renderPdf(readFileSync(join(r.dir, 'resume.md'), 'utf8'), join(r.dir, 'resume.pdf'));
    await renderPdf(readFileSync(join(r.dir, 'cover_letter.txt'), 'utf8').split('\n').join('\n\n'), join(r.dir, 'cover_letter.pdf'));
    db.setApp(id, { status: 'tailored', tailored_path: r.dir });
    db.log(id, 'tailor', `${r.accepted.length} edits kept, ${r.rejected.length} rejected by fact check`);
    console.log(c.green('done'));
    console.log(c.dim(`  ${r.accepted.length} bullet edits, ${r.rejected.length} rejected by fact check · review ${join(r.dir, 'changes.md')}`));
    if (r.data.keywords_missing.length) console.log(c.dim(`  gaps (not claimed): ${r.data.keywords_missing.join(', ')}`));
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
  const { fillApplication } = await import('./apply/filler.js');
  const { answerQuestions } = await import('./answers.js');
  const { renderPdf } = await import('./render.js');
  const db = open(opt.db), profile = loadProfile(), resume = loadResume();
  const id = db.resolve(ref), row = db.job(id), app = db.app(id) || {};
  if (row.closed) throw new Error('This posting is closed.');
  if (opt.submit && app.status !== 'approved') throw new Error('Approve it first ("applio approve <job>") — nothing is submitted without your review.');

  const dir = app.tailored_path || join('out', id.replace(/[^a-z0-9]+/gi, '-'));
  mkdirSync(dir, { recursive: true });
  const files = {};
  if (!opt.base && app.tailored_path && existsSync(join(dir, 'resume.pdf'))) {
    files.resume = join(dir, 'resume.pdf');
    files.coverLetter = join(dir, 'cover_letter.pdf');
  } else {
    files.resume = await renderPdf(resume, join(dir, 'resume-base.pdf'));
  }
  const coverLetter = existsSync(join(dir, 'cover_letter.txt')) ? readFileSync(join(dir, 'cover_letter.txt'), 'utf8') : '';
  const job = rowToJob(row);

  console.log(`${opt.submit ? 'Applying to' : 'Dry run (no submit):'} ${row.title} @ ${row.company}\n${c.dim(row.apply_url)}`);
  const result = await fillApplication({
    job: row, files, submit: !!opt.submit, headed: !!opt.headed, outDir: join(dir, 'apply'),
    answer: fields => answerQuestions({ questions: fields, job, profile, resume, coverLetter }),
  });

  for (const f of result.receipt.fields) {
    const mark = f.source === 'missing' || String(f.source).startsWith('error') ? (f.required ? c.red('✗') : c.yellow('○')) : c.green('✓');
    const v = typeof f.value === 'string' ? f.value.replace(/\s+/g, ' ') : String(f.value ?? '');
    console.log(`  ${mark} ${pad(f.label || '(unlabelled)', 48)} ${pad(v, 60)} ${c.dim(f.source)}`);
  }
  const status = result.status === 'filled' ? (app.status || 'matched') : result.status;
  db.setApp(id, { status, receipt_path: join(dir, 'apply'), note: result.note || null, ...(app.score == null ? { score: 0 } : {}) });
  db.log(id, 'apply', `${result.status}${result.note ? ': ' + result.note : ''}`);
  writeFileSync(join(dir, 'apply', 'answers.md'), result.receipt.fields.map(f => `**${f.label}**\n${f.value ?? ''}\n`).join('\n'));
  console.log(`\n${result.status === 'submitted' ? c.green('Submitted.') : result.status === 'filled' ? 'Form filled, not submitted.' : c.yellow('Needs you: ' + result.note)}`);
  console.log(c.dim(`Screenshot and receipt: ${join(dir, 'apply')}`));
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
