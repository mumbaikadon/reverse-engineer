import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'applio-auto-'));
process.env.APPLIO_DB = join(dir, 'auto.db');
for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[v];

const { titleFilter } = await import('../src/match.js');
const { directory } = await import('../src/sources/index.js');
const { profileFromResume } = await import('../src/extract.js');
const { renderPdf } = await import('../src/render.js');
const { serve } = await import('../src/server.js');
const { getJSON, getBlob } = await import('../src/store.js');

test('titleFilter keeps target roles and drops excluded or unrelated ones', () => {
  const keep = titleFilter({ titles: ['data analyst'], titleKeywords: ['data', 'analyst'], excludeTitleKeywords: ['intern'] });
  assert.equal(keep('Senior Data Analyst'), true);
  assert.equal(keep('Analyst, Data Platform'), true, 'two keywords in any order');
  assert.equal(keep('Data Engineer'), false, 'one keyword is not enough when several are set');
  assert.equal(keep('Data Analyst Intern'), false);
});

test('the bundled company directory is a list of verified boards', () => {
  const d = directory();
  assert.ok(d.length >= 250, `only ${d.length} boards`);
  for (const e of d) assert.ok(['greenhouse', 'lever', 'ashby'].includes(e.ats) && e.slug && e.name, JSON.stringify(e));
  assert.equal(new Set(d.map(e => `${e.ats}:${e.slug}`)).size, d.length, 'no duplicates');
});

test('profileFromResume fills everything from the résumé without an AI provider', async () => {
  const r = await profileFromResume(readFileSync('test/fixtures/resume.md', 'utf8'));
  assert.equal(r.source, 'parser');
  assert.deepEqual(r.missing, []);
  assert.equal(r.profile.name, 'Jordan Reyes');
  assert.equal(r.profile.preferences.searchAllCompanies, true);
  const blank = await profileFromResume('Just some words without contact details');
  assert.deepEqual(blank.missing.sort(), ['email', 'name', 'titles']);
});

let server, base;
before(async () => {
  server = serve({ port: 0, dbPath: process.env.APPLIO_DB, migrate: false });
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('uploading a résumé PDF sets up résumé, original PDF and profile in one step', { timeout: 60_000 }, async () => {
  const pdf = readFileSync(await renderPdf(readFileSync('test/fixtures/resume.md', 'utf8'), join(dir, 'r.pdf')));
  const res = await fetch(base + '/api/setup/resume', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-applio': '1' }, body: pdf });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  assert.equal(r.saved, true);
  assert.deepEqual(r.missing, []);
  assert.equal(getJSON('profile').email, 'jordan@example.com');
  assert.match(getJSON('resume'), /^## Experience$/m);
  assert.equal(getBlob('resume_pdf').subarray(0, 5).toString(), '%PDF-');
  const s = await (await fetch(base + '/api/summary')).json();
  assert.equal(s.setup.resume && s.setup.profile, true);
});

test('only missing details are asked for, then saved', async () => {
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-applio': '1' }, body: JSON.stringify(body) });
  const r = await (await post('/api/setup/resume', { text: '# Sam Lee\nSenior Product Designer\n\n## Experience\n### Product Designer — Acme (2019 – present)\n- Designed things.\n' })).json();
  assert.deepEqual(r.missing, ['email']);
  const done = await (await post('/api/setup/complete-profile', { email: 'sam@example.com' })).json();
  assert.equal(done.saved, true);
  assert.equal(getJSON('profile').name, 'Sam Lee');
  assert.equal(getJSON('profile').email, 'sam@example.com');
});
