// User settings (résumé, profile, companies, AI keys) live in the same SQLite file as the jobs,
// so there is nothing to edit by hand. data/ is git-ignored.
import { existsSync, readFileSync } from 'node:fs';
import { open } from './db.js';

let path = process.env.APPLIO_DB || 'data/applio.db';
let db = null;

/** Point the store at a database (the server and CLI pass the --db path, tests a temp file). */
export function useDb(p, existing) {
  if (p && p !== path) { path = p; db = null; }
  if (existing) db = existing;
}
const raw = () => (db ??= open(path)).raw;

export function getJSON(key) {
  const row = raw().prepare('SELECT json FROM settings WHERE key = ?').get(key);
  return row?.json != null ? JSON.parse(row.json) : null;
}
export function setJSON(key, value) {
  raw().prepare(`INSERT INTO settings (key, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), new Date().toISOString());
  return value;
}
export function getBlob(key) {
  const row = raw().prepare('SELECT blob FROM settings WHERE key = ?').get(key);
  return row?.blob ? Buffer.from(row.blob) : null;
}
export function setBlob(key, buf) {
  raw().prepare(`INSERT INTO settings (key, blob, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`).run(key, buf, new Date().toISOString());
}
export const has = key => !!raw().prepare('SELECT 1 FROM settings WHERE key = ? AND (json IS NOT NULL OR blob IS NOT NULL)').get(key);
export const remove = key => raw().prepare('DELETE FROM settings WHERE key = ?').run(key);

/**
 * One-time import of the old file-based setup (config/*.json, resume/resume.md) so existing
 * users keep their data. Files are left in place but no longer read afterwards.
 */
export function migrateLegacyFiles({ log = () => {} } = {}) {
  if (getJSON('_migrated_files')) return [];
  const imported = [];
  const json = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  const pairs = [
    ['profile', () => json('config/profile.json')],
    ['companies', () => json('config/companies.json')],
    ['integrations', () => json('config/integrations.json')],
    ['resume', () => existsSync('resume/resume.md') ? readFileSync('resume/resume.md', 'utf8') : null],
  ];
  for (const [key, read] of pairs) {
    if (has(key)) continue;
    try { const v = read(); if (v != null) { setJSON(key, v); imported.push(key); } } catch { /* unreadable file: skip */ }
  }
  if (!has('resume_pdf') && existsSync('resume/resume.original.pdf')) { setBlob('resume_pdf', readFileSync('resume/resume.original.pdf')); imported.push('resume PDF'); }
  setJSON('_migrated_files', { at: new Date().toISOString(), imported });
  if (imported.length) log(`Imported your existing ${imported.join(', ')} from the old config files into the database.`);
  return imported;
}
