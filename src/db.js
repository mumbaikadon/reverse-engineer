// Local SQLite store (node:sqlite) for jobs, applications and the event log.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUSES = ['new', 'matched', 'tailored', 'approved', 'submitted', 'needs_input', 'failed', 'skipped', 'interview', 'rejected', 'offer'];

export function open(path = 'data/applio.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, ats TEXT, board TEXT, external_id TEXT, company TEXT, title TEXT,
      location TEXT, remote INTEGER, url TEXT, apply_url TEXT, department TEXT, compensation TEXT,
      description TEXT, posted_at TEXT, first_seen TEXT, last_seen TEXT, closed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS applications (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id), status TEXT, score INTEGER, reasons TEXT,
      tailored_path TEXT, answers TEXT, receipt_path TEXT, note TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, kind TEXT, detail TEXT, at TEXT
    );
  `);
  return wrap(db);
}

const now = () => new Date().toISOString();

function wrap(db) {
  const upsertJob = db.prepare(`
    INSERT INTO jobs (id, ats, board, external_id, company, title, location, remote, url, apply_url, department, compensation, description, posted_at, first_seen, last_seen, closed)
    VALUES (:id, :ats, :board, :externalId, :company, :title, :location, :remote, :url, :applyUrl, :department, :compensation, :description, :postedAt, :now, :now, 0)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, location = excluded.location, description = CASE WHEN excluded.description = '' THEN jobs.description ELSE excluded.description END,
      apply_url = excluded.apply_url, compensation = excluded.compensation, last_seen = excluded.last_seen, closed = 0`);
  const exists = db.prepare('SELECT 1 FROM jobs WHERE id = ?');

  return {
    raw: db,
    /** Insert or refresh jobs; returns the ones never seen before. */
    saveJobs(jobs) {
      const fresh = [];
      const t = now();
      db.exec('BEGIN');
      try {
        for (const j of jobs) {
          if (!exists.get(j.id)) fresh.push(j);
          upsertJob.run({ compensation: '', department: '', postedAt: null, ...j, remote: j.remote ? 1 : 0, now: t });
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return fresh;
    },
    /** Mark jobs from the scanned boards that no longer appear as closed. */
    closeMissing(boards, seenIds) {
      const seen = new Set(seenIds);
      const q = db.prepare('SELECT id FROM jobs WHERE board = ? AND closed = 0');
      const close = db.prepare('UPDATE jobs SET closed = 1 WHERE id = ?');
      let n = 0;
      for (const b of boards) for (const { id } of q.all(b)) if (!seen.has(id)) { close.run(id); n++; }
      return n;
    },
    job: id => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id),
    openJobs: () => db.prepare('SELECT * FROM jobs WHERE closed = 0').all(),
    app: id => db.prepare('SELECT * FROM applications WHERE job_id = ?').get(id),
    setApp(jobId, fields) {
      const cur = this.app(jobId) || { job_id: jobId };
      const row = { ...cur, ...fields, job_id: jobId, updated_at: now() };
      db.prepare(`INSERT INTO applications (job_id, status, score, reasons, tailored_path, answers, receipt_path, note, updated_at)
        VALUES (:job_id, :status, :score, :reasons, :tailored_path, :answers, :receipt_path, :note, :updated_at)
        ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, score = excluded.score, reasons = excluded.reasons,
          tailored_path = excluded.tailored_path, answers = excluded.answers, receipt_path = excluded.receipt_path,
          note = excluded.note, updated_at = excluded.updated_at`)
        .run({ status: null, score: null, reasons: null, tailored_path: null, answers: null, receipt_path: null, note: null, ...row });
      if (fields.status && fields.status !== cur.status) this.log(jobId, 'status', `${cur.status || '—'} → ${fields.status}`);
      return row;
    },
    log(jobId, kind, detail) {
      db.prepare('INSERT INTO events (job_id, kind, detail, at) VALUES (?, ?, ?, ?)').run(jobId, kind, String(detail), now());
    },
    events: jobId => db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id').all(jobId),
    board(status) {
      const sql = `SELECT a.*, j.company, j.title, j.location, j.url, j.ats FROM applications a JOIN jobs j ON j.id = a.job_id
        ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.score DESC, a.updated_at DESC`;
      return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
    },
    counts: () => db.prepare('SELECT status, COUNT(*) n FROM applications GROUP BY status').all(),
    openCount: () => db.prepare('SELECT COUNT(*) n FROM jobs WHERE closed = 0').get().n,
    setMeta: (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v),
    getMeta: k => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null,
    /** Filtered, paged job list for the dashboard. status 'active' = everything except skipped/rejected. */
    list({ status = 'active', min = 0, q = '', company = '', sort = 'score', limit = 50, offset = 0 } = {}) {
      const where = ['j.closed = 0', 'COALESCE(a.score, 0) >= :min'];
      if (status === 'active') where.push("a.status NOT IN ('skipped', 'rejected')");
      else if (status && status !== 'all') where.push('a.status = :status');
      if (q) where.push('(j.title LIKE :q OR j.company LIKE :q OR j.location LIKE :q)');
      if (company) where.push('j.company = :company');
      const order = { score: 'a.score DESC, j.posted_at DESC', posted: 'j.posted_at DESC', updated: 'a.updated_at DESC', company: 'j.company, a.score DESC' }[sort] || 'a.score DESC';
      const params = { min: Number(min) || 0, status, q: `%${q}%`, company };
      const base = `FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${where.join(' AND ')}`;
      const used = Object.fromEntries(Object.entries(params).filter(([k]) => base.includes(':' + k)));
      const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(used).n;
      const rows = db.prepare(`SELECT a.job_id id, a.status, a.score, a.note, a.updated_at, a.tailored_path, j.company, j.title, j.location, j.remote, j.ats, j.posted_at ${base} ORDER BY ${order} LIMIT :limit OFFSET :offset`)
        .all({ ...used, limit: Math.min(Number(limit) || 50, 500), offset: Number(offset) || 0 });
      return { total, rows };
    },
    companies: () => db.prepare("SELECT j.company, COUNT(*) n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.closed = 0 AND a.status NOT IN ('skipped','rejected') GROUP BY j.company ORDER BY n DESC").all(),
    /** Resolve a short id prefix (or full id) to a job id. */
    resolve(ref) {
      const rows = db.prepare('SELECT id FROM jobs WHERE id = ? OR id LIKE ? OR external_id = ? LIMIT 2').all(ref, `%${ref}%`, ref);
      if (rows.length !== 1) throw new Error(rows.length ? `"${ref}" is ambiguous` : `no job matches "${ref}"`);
      return rows[0].id;
    },
  };
}
