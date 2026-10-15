// Pipeline operations shared by the CLI and the web dashboard.
// Each takes an open db plus options and reports progress through `log`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAll } from './sources/index.js';
import { score } from './match.js';
import { loadProfile, loadResume, loadCompanies } from './profile.js';
import { hasCredentials, MODEL } from './llm.js';

export function rowToJob(r) {
  return { id: r.id, ats: r.ats, company: r.company, title: r.title, location: r.location, remote: !!r.remote, description: r.description || '', postedAt: r.posted_at, externalId: r.external_id, url: r.url, applyUrl: r.apply_url };
}

export async function scan(db, { log = () => {} } = {}) {
  const profile = loadProfile(), companies = loadCompanies();
  const t0 = Date.now();
  const { jobs: found, errors } = await scanAll(companies, {
    onBoard: (co, n, err) => log(`${co.name || co.slug || co.tenant}: ${err ? 'error: ' + err.message : `${n} open roles`}`),
  });
  const fresh = db.saveJobs(found);
  const okBoards = companies.filter(co => !errors.some(e => e.company === co)).map(co => co.slug || co.tenant);
  const closed = db.closeMissing(okBoards, found.map(j => j.id));

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
  newMatches.sort((a, b) => b.score - a.score);
  const summary = { boards: companies.length, seconds: (Date.now() - t0) / 1000, open: found.length, fresh: fresh.length, closed, errors: errors.length, matches: newMatches.length, minScore: min };
  db.setMeta('last_scan', JSON.stringify({ at: new Date().toISOString(), ...summary }));
  log(`Scanned ${summary.boards} boards in ${summary.seconds.toFixed(1)}s: ${summary.open} open roles, ${summary.fresh} new, ${closed} closed, ${summary.errors} board errors, ${summary.matches} new matches ≥ ${min}.`);
  return { ...summary, newMatches };
}

export async function tailorJob(db, id, { log = () => {} } = {}) {
  if (!hasCredentials()) throw new Error('Set ANTHROPIC_API_KEY to tailor résumés with Claude.');
  const { tailor } = await import('./tailor.js');
  const { renderPdf } = await import('./render.js');
  const profile = loadProfile(), resume = loadResume();
  const job = rowToJob(db.job(id));
  log(`Tailoring ${job.title} @ ${job.company} with ${MODEL}…`);
  const r = await tailor({ job, profile, resume });
  await renderPdf(readFileSync(join(r.dir, 'resume.md'), 'utf8'), join(r.dir, 'resume.pdf'));
  await renderPdf(readFileSync(join(r.dir, 'cover_letter.txt'), 'utf8').split('\n').join('\n\n'), join(r.dir, 'cover_letter.pdf'));
  db.setApp(id, { status: 'tailored', tailored_path: r.dir });
  db.log(id, 'tailor', `${r.accepted.length} edits kept, ${r.rejected.length} rejected by fact check`);
  log(`${r.accepted.length} bullet edits, ${r.rejected.length} rejected by fact check.`);
  if (r.data.keywords_missing.length) log(`Gaps (not claimed): ${r.data.keywords_missing.join(', ')}`);
  return r;
}

export function topMatched(db, n) {
  const limit = loadProfile().preferences.dailyTailorLimit ?? 15;
  return db.board('matched').slice(0, Math.min(n, limit)).map(r => r.job_id);
}

export async function applyJob(db, id, { submit = false, headed = false, base = false, log = () => {} } = {}) {
  const { fillApplication } = await import('./apply/filler.js');
  const { answerQuestions } = await import('./answers.js');
  const { renderPdf } = await import('./render.js');
  const profile = loadProfile(), resume = loadResume();
  const row = db.job(id), app = db.app(id) || {};
  if (row.closed) throw new Error('This posting is closed.');
  if (submit && app.status !== 'approved') throw new Error('Approve it first — nothing is submitted without your review.');

  const dir = app.tailored_path || jobDir(id);
  mkdirSync(dir, { recursive: true });
  const files = {};
  if (!base && app.tailored_path && existsSync(join(dir, 'resume.pdf'))) {
    files.resume = join(dir, 'resume.pdf');
    files.coverLetter = join(dir, 'cover_letter.pdf');
  } else {
    files.resume = await renderPdf(resume, join(dir, 'resume-base.pdf'));
  }
  const coverLetter = existsSync(join(dir, 'cover_letter.txt')) ? readFileSync(join(dir, 'cover_letter.txt'), 'utf8') : '';
  const job = rowToJob(row);

  log(`${submit ? 'Applying to' : 'Dry run (no submit):'} ${row.title} @ ${row.company}`);
  const result = await fillApplication({
    job: row, files, submit, headed, outDir: join(dir, 'apply'),
    answer: fields => answerQuestions({ questions: fields, job, profile, resume, coverLetter }),
  });
  const status = result.status === 'filled' ? (app.status || 'matched') : result.status;
  db.setApp(id, { status, receipt_path: join(dir, 'apply'), note: result.note || null, ...(app.score == null ? { score: 0 } : {}) });
  db.log(id, 'apply', `${result.status}${result.note ? ': ' + result.note : ''}`);
  writeFileSync(join(dir, 'apply', 'answers.md'), result.receipt.fields.map(f => `**${f.label}**\n${f.value ?? ''}\n`).join('\n'));
  const filled = result.receipt.fields.filter(f => !(f.source === 'missing' || String(f.source).startsWith('error'))).length;
  log(`${result.status === 'submitted' ? 'Submitted.' : result.status === 'filled' ? 'Form filled, not submitted.' : 'Needs you: ' + result.note} (${filled}/${result.receipt.fields.length} fields filled)`);
  return { ...result, dir: join(dir, 'apply') };
}

export const jobDir = id => join('out', id.replace(/[^a-z0-9]+/gi, '-'));
