import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point config at a scratch folder before anything reads it.
const dir = mkdtempSync(join(tmpdir(), 'applio-cfg-'));
process.env.APPLIO_CONFIG_DIR = join(dir, 'config');
process.env.APPLIO_RESUME = join(dir, 'resume.md');

const { parseBoardUrl } = await import('../src/detect.js');
const { validateProfile, validateCompanies, readConfig } = await import('../src/profile.js');
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

test('readConfig falls back to the examples until files are saved', () => {
  const c = readConfig();
  assert.deepEqual(c.exists, { profile: false, companies: false, resume: false });
  assert.ok(c.profile.name && c.companies.length && c.resume.includes('##'));
});

let server, base;
before(async () => {
  server = serve({ port: 0, dbPath: join(dir, 'test.db') });
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
  assert.deepEqual(s.setup, { profile: true, companies: true, resume: true });
  assert.equal(JSON.parse(readFileSync(join(dir, 'config', 'profile.json'), 'utf8')).name, 'Ana Silva');
  assert.equal(readFileSync(join(dir, 'resume.md'), 'utf8'), '# Ana\n\n## Skills\nFigma\n', 'Windows line endings are normalised');
});

test('settings API rejects invalid input without touching the file', async () => {
  const before = readFileSync(join(dir, 'config', 'profile.json'), 'utf8');
  const r = await put('/api/config/profile', { profile: { name: '', email: 'x' } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /name/);
  assert.equal(readFileSync(join(dir, 'config', 'profile.json'), 'utf8'), before);
  assert.equal((await put('/api/config/resume', { markdown: '   ' })).status, 400);
  assert.equal((await fetch(base + '/api/config/profile', { method: 'PUT', body: '{}' })).status, 403, 'needs X-Applio header');
  assert.ok(!existsSync(join(dir, 'config', 'profile.json.tmp')));
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
