// Local web dashboard: static UI + JSON API over the same database and actions as the CLI.
// Binds to 127.0.0.1 by default. It can submit job applications, so it is not meant to be
// exposed to a network; state-changing requests also require a same-origin header.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, STATUSES } from './db.js';
import * as actions from './actions.js';
import { providerInfo, testProvider } from './llm.js';
import { publicIntegrations, saveIntegrations, PROVIDERS } from './integrations.js';
import { loadCompanies, loadProfile, readConfig, saveProfile, saveResume, saveCompanies, saveOriginalPdf, paths } from './profile.js';
import { detectBoards } from './detect.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const OUT = resolve('out');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

// ---- background tasks ------------------------------------------------------
// Scans and browser runs go through one queue so only one Chromium/scan runs at a time.
const tasks = new Map();
let seq = 0, queue = Promise.resolve();

function startTask(kind, jobId, label, run) {
  const t = { id: ++seq, kind, jobId, label, status: 'queued', log: [], createdAt: new Date().toISOString() };
  tasks.set(t.id, t);
  const log = line => { t.log.push(line); if (t.log.length > 200) t.log.shift(); };
  queue = queue.then(async () => {
    t.status = 'running'; t.startedAt = new Date().toISOString();
    try { t.result = summarize(await run(log)); t.status = 'done'; }
    catch (e) { t.status = 'error'; t.error = e.message; log(`error: ${e.message}`); }
    t.finishedAt = new Date().toISOString();
  });
  // Keep the last 50 tasks.
  for (const id of [...tasks.keys()].slice(0, -50)) tasks.delete(id);
  return t;
}
const summarize = r => r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).filter(([k, v]) => typeof v !== 'object' || v === null)) : r;
const busy = (kind, jobId) => [...tasks.values()].some(t => (t.status === 'queued' || t.status === 'running') && t.kind === kind && t.jobId === jobId);

// ---- helpers ---------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw Object.assign(new Error('body too large'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
}
async function readRaw(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error(`file is larger than ${max / 1e6} MB`), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function serveFile(res, path) {
  if (!existsSync(path) || !statSync(path).isFile()) return send(res, 404, 'not found');
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(path).pipe(res);
}
const inside = (root, p) => { const r = resolve(p); return r === root || r.startsWith(root + sep); };
const readIf = (p, max = 200_000) => existsSync(p) ? readFileSync(p, 'utf8').slice(0, max) : null;
const relOut = p => p && inside(OUT, p) ? resolve(p).slice(OUT.length + 1).split(sep).join('/') : null;

function jobDetail(db, id) {
  const job = db.job(id);
  if (!job) return null;
  const app = db.app(id) || null;
  const dir = app?.tailored_path || (app?.receipt_path ? join(app.receipt_path, '..') : null);
  const applyDir = app?.receipt_path || (dir ? join(dir, 'apply') : null);
  const files = {};
  if (dir && existsSync(dir)) for (const f of readdirSync(dir)) if (/\.(pdf|md|txt)$/.test(f)) files[f] = relOut(join(dir, f));
  if (applyDir && existsSync(applyDir)) for (const f of readdirSync(applyDir)) if (/\.(png|json|md)$/.test(f)) files['apply/' + f] = relOut(join(applyDir, f));
  let tailor = null;
  const tj = dir && readIf(join(dir, 'tailor.json'));
  if (tj) { const t = JSON.parse(tj); tailor = { summary: t.summary, accepted: t.accepted, rejected: t.rejected, keywords_matched: t.keywords_matched, keywords_missing: t.keywords_missing }; }
  const receipt = applyDir && readIf(join(applyDir, 'receipt.json'));
  return {
    job: { ...job, remote: !!job.remote, closed: !!job.closed },
    app: app && { ...app, reasons: JSON.parse(app.reasons || '[]') },
    events: db.events(id),
    tailor,
    coverLetter: dir && readIf(join(dir, 'cover_letter.txt')),
    receipt: receipt ? JSON.parse(receipt) : null,
    files,
    busy: ['tailor', 'apply'].filter(k => busy(k, id)),
  };
}

// ---- server ----------------------------------------------------------------
export function serve({ port = 4317, host = '127.0.0.1', dbPath = 'data/applio.db' } = {}) {
  const db = open(dbPath);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = decodeURIComponent(url.pathname);
    try {
      // CSRF guard: browsers can't add this header cross-origin without a CORS preflight, which we never grant.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-applio'] !== '1') return send(res, 403, { error: 'missing X-Applio header' });

      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return serveFile(res, join(PUBLIC, 'index.html'));
      if (req.method === 'GET' && /^\/(app\.js|app\.css|settings\.js)$/.test(path)) return serveFile(res, join(PUBLIC, path.slice(1)));
      if (req.method === 'GET' && path.startsWith('/files/')) {
        const p = join(OUT, path.slice('/files/'.length));
        return inside(OUT, p) ? serveFile(res, p) : send(res, 403, 'forbidden');
      }

      if (path === '/api/summary' && req.method === 'GET') {
        const counts = Object.fromEntries(db.counts().map(r => [r.status, r.n]));
        let profile = null, boards = 0;
        try { const p = loadProfile(); profile = { name: p.name, minScore: p.preferences?.minScore ?? 60 }; boards = loadCompanies().length; } catch { /* not initialised yet */ }
        const { exists } = readConfig();
        return send(res, 200, { setup: exists, counts, statuses: STATUSES, open: db.openCount(), lastScan: JSON.parse(db.getMeta('last_scan') || 'null'), companies: db.companies(), boards, profile, llm: (() => { const a = providerInfo(); return { enabled: !!a, provider: a?.name || null, label: a?.label || null, model: a?.model || null }; })() });
      }
      if (path === '/api/jobs' && req.method === 'GET') {
        return send(res, 200, db.list(Object.fromEntries(url.searchParams)));
      }
      // ---- settings: profile, résumé, companies --------------------------------
      if (path === '/api/config' && req.method === 'GET') return send(res, 200, { ...readConfig(), llm: providerInfo() });
      if (path === '/api/config/profile' && req.method === 'PUT') { saveProfile((await readBody(req)).profile); return send(res, 200, readConfig()); }
      if (path === '/api/config/resume' && req.method === 'PUT') { saveResume((await readBody(req)).markdown); return send(res, 200, readConfig()); }
      if (path === '/api/config/companies' && req.method === 'PUT') { saveCompanies((await readBody(req)).companies); return send(res, 200, readConfig()); }
      if (path === '/api/integrations' && req.method === 'GET') return send(res, 200, publicIntegrations());
      if (path === '/api/integrations' && req.method === 'PUT') return send(res, 200, saveIntegrations(await readBody(req)));
      if (path === '/api/integrations/test' && req.method === 'POST') {
        const { provider, apiKey } = await readBody(req);
        if (!PROVIDERS[provider]) return send(res, 400, { error: 'unknown provider' });
        return send(res, 200, await testProvider(provider, typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined));
      }
      if (path === '/api/config/detect' && req.method === 'POST') {
        const { input, name } = await readBody(req);
        return send(res, 200, await detectBoards(input, { name }));
      }
      if (path === '/api/config/resume/import' && req.method === 'POST') {
        const buf = await readRaw(req, 10e6);
        const { importResumePdf } = await import('./resume-import.js');
        const result = await importResumePdf(buf, { tidy: url.searchParams.get('tidy') === '1' });
        saveOriginalPdf(buf);
        return send(res, 200, { ...result, originalPdf: true });
      }
      if (path === '/api/config/resume/original.pdf' && req.method === 'GET') return serveFile(res, paths().originalPdf);
      if (path === '/api/config/resume/preview' && req.method === 'POST') {
        const { markdown } = await readBody(req);
        const { renderPdf } = await import('./render.js');
        mkdirSync(OUT, { recursive: true });
        await renderPdf(String(markdown || ''), join(OUT, 'resume-preview.pdf'));
        return send(res, 200, { file: 'resume-preview.pdf' });
      }
      if (path === '/api/rescore' && req.method === 'POST') {
        return send(res, 202, startTask('rescore', undefined, 'Re-score jobs', log => actions.rescore(db, { log })));
      }

      if (path === '/api/tasks' && req.method === 'GET') {
        return send(res, 200, [...tasks.values()].reverse());
      }
      if (path === '/api/scan' && req.method === 'POST') {
        if (busy('scan')) return send(res, 409, { error: 'A scan is already running' });
        return send(res, 202, startTask('scan', undefined, 'Scan job boards', log => actions.scan(db, { log })));
      }
      if (path === '/api/tailor-top' && req.method === 'POST') {
        const { n = 5 } = await readBody(req);
        const ids = actions.topMatched(db, Number(n));
        return send(res, 202, ids.map(id => startTask('tailor', id, `Tailor ${db.job(id).title} @ ${db.job(id).company}`, log => actions.tailorJob(db, id, { log }))));
      }

      const m = path.match(/^\/api\/jobs\/([^/]+)(?:\/(tailor|apply|status))?$/);
      if (m) {
        const id = m[1];
        if (!db.job(id)) return send(res, 404, { error: 'unknown job' });
        if (!m[2] && req.method === 'GET') return send(res, 200, jobDetail(db, id));
        const body = req.method === 'POST' ? await readBody(req) : {};
        const j = db.job(id);
        if (m[2] === 'status' && req.method === 'POST') {
          if (!STATUSES.includes(body.status)) return send(res, 400, { error: `unknown status "${body.status}"` });
          db.setApp(id, { status: body.status, ...(db.app(id) ? {} : { score: 0 }) });
          return send(res, 200, jobDetail(db, id));
        }
        if (m[2] === 'tailor' && req.method === 'POST') {
          if (busy('tailor', id)) return send(res, 409, { error: 'Already tailoring this job' });
          return send(res, 202, startTask('tailor', id, `Tailor ${j.title} @ ${j.company}`, log => actions.tailorJob(db, id, { log })));
        }
        if (m[2] === 'apply' && req.method === 'POST') {
          if (busy('apply', id)) return send(res, 409, { error: 'Already applying to this job' });
          const submit = body.submit === true;
          if (submit && db.app(id)?.status !== 'approved') return send(res, 400, { error: 'Approve the job before submitting.' });
          return send(res, 202, startTask('apply', id, `${submit ? 'Submit' : 'Dry run'} ${j.title} @ ${j.company}`, log => actions.applyJob(db, id, { submit, base: body.base === true, log })));
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    }
  });

  server.listen(port, host, () => {
    console.log(`applio dashboard → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (host !== '127.0.0.1' && host !== 'localhost') console.warn('Warning: listening beyond localhost. Anyone who can reach this port can submit applications as you.');
  });
  return server;
}
