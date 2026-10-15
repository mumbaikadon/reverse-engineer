import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.js';
import { open } from '../src/db.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(mkdtempSync(join(tmpdir(), 'applio-srv-')), 'test.db');
const id = 'greenhouse:acme:1';
let server, base;

before(async () => {
  const db = open(dbPath);
  db.saveJobs([{ id, ats: 'greenhouse', board: 'acme', externalId: '1', company: 'Acme', title: 'Backend Engineer', location: 'Remote', remote: true, url: 'https://example.com/1', applyUrl: 'https://example.com/1/apply', description: 'Go and Postgres' }]);
  db.setApp(id, { status: 'matched', score: 88, reasons: JSON.stringify(['title matches']) });
  server = serve({ port: 0, dbPath, migrate: false });
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, headers = { 'x-applio': '1' }) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('serves the dashboard page', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /applio dashboard/);
});

test('summary and job list', async () => {
  const s = await (await fetch(base + '/api/summary')).json();
  assert.equal(s.counts.matched, 1);
  assert.equal(s.open, 1);
  const list = await (await fetch(base + '/api/jobs?min=80&q=backend')).json();
  assert.equal(list.total, 1);
  assert.equal(list.rows[0].company, 'Acme');
  assert.equal((await (await fetch(base + '/api/jobs?min=90')).json()).total, 0);
});

test('job detail', async () => {
  const d = await (await fetch(`${base}/api/jobs/${encodeURIComponent(id)}`)).json();
  assert.equal(d.job.title, 'Backend Engineer');
  assert.deepEqual(d.app.reasons, ['title matches']);
});

test('state changes need the X-Applio header (CSRF guard)', async () => {
  assert.equal((await post(`/api/jobs/${encodeURIComponent(id)}/status`, { status: 'approved' }, {})).status, 403);
});

test('cannot submit before approval; status changes are logged', async () => {
  const r = await post(`/api/jobs/${encodeURIComponent(id)}/apply`, { submit: true });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Approve/);
  const ok = await (await post(`/api/jobs/${encodeURIComponent(id)}/status`, { status: 'approved' })).json();
  assert.equal(ok.app.status, 'approved');
  assert.equal(ok.events.at(-1).detail, 'matched → approved');
  assert.equal((await post(`/api/jobs/${encodeURIComponent(id)}/status`, { status: 'nope' })).status, 400);
});

test('file route cannot escape out/', async () => {
  assert.equal((await fetch(base + '/files/..%2Fpackage.json')).status, 403);
});
