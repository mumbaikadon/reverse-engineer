import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point config at a scratch folder before anything reads it.
const dir = mkdtempSync(join(tmpdir(), 'applio-cfg-'));
process.env.APPLIO_DB = join(dir, 'settings.db');

const { parseBoardUrl } = await import('../src/detect.js');
const { validateProfile, validateCompanies, readConfig, draftProfile } = await import('../src/profile.js');
const { getJSON } = await import('../src/store.js');
const { serve } = await import('../src/server.js');
const { open } = await import('../src/db.js');
const { rescore } = await import('../src/actions.js');

test('parseBoardUrl recognises every supported board', () => {
  assert.deepEqual(parseBoardUrl('https://boards.greenhouse.io/stripe'), { ats: 'greenhouse', slug: 'stripe' });
  assert.deepEqual(parseBoardUrl('https://job-boards.greenhouse.io/figma/jobs/123'), { ats: 'greenhouse', slug: 'figma' });
  assert.deepEqual(parseBoardUrl('<iframe src="https://boards.greenhouse.io/embed/job_board?for=airbnb">'), { ats: 'greenhouse', slug: 'airbnb' });
  assert.deepEqual(parseBoardUrl('jobs.lever.co/palantir/abc-123'), { ats: 'lever', slug: 'palantir' });
  assert.deepEqual(parseBoardUrl('https://jobs.ashbyhq.com/ramp/xyz'), { ats: 'ashby', slug: 'ramp' });
  assert.deepEqual(parseBoardUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/X'),
    { ats: 'workday', host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', site: 'NVIDIAExternalCareerSite' });
  assert.equal(parseBoardUrl('https://example.com/careers'), null);
});

test('validation rejects broken profiles and company lists', () => {
  const ok = { name: 'A B', email: 'a@b.co', preferences: { titles: ['x'] } };
  assert.equal(validateProfile(ok), ok);
  assert.throws(() => validateProfile({ ...ok, email: 'nope' }), /email/);
  assert.throws(() => validateProfile({ ...ok, preferences: { titles: 'x' } }), /titles/);
  assert.throws(() => validateProfile({ ...ok, answers: [{ match: '(', answer: 'No' }] }), /not a valid pattern/);
  assert.throws(() => validateCompanies([{ ats: 'monster', slug: 'x' }]), /ats/);
  assert.throws(() => validateCompanies([{ ats: 'workday', host: 'a.wd1.myworkdayjobs.com' }]), /Workday/);
  assert.throws(() => validateCompanies([{ ats: 'lever', slug: 'a' }, { ats: 'lever', slug: 'A' }]), /twice/);
});

test('nothing is set up until the user saves it (no example data)', () => {
  const c = readConfig();
  assert.deepEqual(c.exists, { resume: false, profile: false, companies: false });
  assert.deepEqual(c.companies, []);
  assert.equal(c.resume, '');
});

test('draftProfile fills the profile from the résumé', () => {
  const p = draftProfile(readFileSync('test/fixtures/resume.md', 'utf8'));
  assert.equal(p.name, 'Jordan Reyes');
  assert.equal(p.email, 'jordan@example.com');
  assert.equal(p.location, 'Brooklyn, NY');
  assert.equal(p.currentCompany, 'Northwind');
  assert.equal(p.links.github, 'https://github.com/example');
  assert.deepEqual(p.preferences.titles, ['software engineer']);
  assert.ok(p.preferences.skills.includes('kubernetes'));
  const q = draftProfile('# Priya Nair\nAustin, TX | priya@example.com | (555) 010-2233\n');
  assert.equal(q.phone, '(555) 010-2233');
});

let server, base;
before(async () => {
  server = serve({ port: 0, dbPath: process.env.APPLIO_DB, migrate: false });
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const put = (path, body) => fetch(base + path, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-applio': '1' }, body: JSON.stringify(body) });

test('settings API saves all three files and reports setup state', async () => {
  let s = await (await fetch(base + '/api/summary')).json();
  assert.equal(s.setup.profile, false);

  const profile = { name: 'Ana Silva', email: 'ana@example.org', preferences: { titles: ['product designer'], skills: ['figma'], locations: ['toronto'], minScore: 50 } };
  assert.equal((await put('/api/config/profile', { profile })).status, 200);
  assert.equal((await put('/api/config/resume', { markdown: '# Ana\r\n\r\n## Skills\r\nFigma\r\n' })).status, 200);
  assert.equal((await put('/api/config/companies', { companies: [{ ats: 'greenhouse', slug: 'figma', name: 'Figma' }] })).status, 200);

  s = await (await fetch(base + '/api/summary')).json();
  assert.deepEqual(s.setup, { resume: true, profile: true, companies: true });
  assert.equal(getJSON('profile').name, 'Ana Silva');
  assert.equal(getJSON('resume'), '# Ana\n\n## Skills\nFigma\n', 'Windows line endings are normalised');
});

test('settings API rejects invalid input without touching the file', async () => {
  const before = JSON.stringify(getJSON('profile'));
  const r = await put('/api/config/profile', { profile: { name: '', email: 'x' } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /name/);
  assert.equal(JSON.stringify(getJSON('profile')), before);
  assert.equal((await put('/api/config/resume', { markdown: '   ' })).status, 400);
  assert.equal((await fetch(base + '/api/config/profile', { method: 'PUT', body: '{}' })).status, 403, 'needs X-Applio header');
});

test('rescore updates untouched matches and leaves reviewed jobs alone', () => {
  const db = open(join(dir, 'rescore.db'));
  const mk = (n, title) => ({ id: `greenhouse:x:${n}`, ats: 'greenhouse', board: 'x', externalId: String(n), company: 'X', title, location: 'Toronto', remote: false, url: 'u', applyUrl: 'u', description: 'Figma' });
  db.saveJobs([mk(1, 'Product Designer'), mk(2, 'Accountant'), mk(3, 'Accountant'), mk(4, 'Product Designer, Senior')]);
  db.setApp('greenhouse:x:2', { status: 'matched', score: 90, reasons: '[]' });   // stale: no longer fits
  db.setApp('greenhouse:x:3', { status: 'approved', score: 90, reasons: '[]' });  // reviewed: must stay
  const r = rescore(db);
  assert.equal(r.removed, 1);
  assert.ok(db.app('greenhouse:x:1')?.score >= 50);
  assert.equal(db.app('greenhouse:x:2'), undefined);
  assert.equal(db.app('greenhouse:x:3').status, 'approved');
});
