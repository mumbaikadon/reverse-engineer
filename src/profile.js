// Reading, validating and saving the user's three config files.
// Paths can be redirected with APPLIO_CONFIG_DIR / APPLIO_RESUME (used by tests).
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const paths = () => {
  const dir = process.env.APPLIO_CONFIG_DIR || 'config';
  return {
    profile: join(dir, 'profile.json'),
    companies: join(dir, 'companies.json'),
    resume: process.env.APPLIO_RESUME || join('resume', 'resume.md'),
    get originalPdf() { return join(dirname(this.resume), 'resume.original.pdf'); },
  };
};
export const examples = {
  profile: join(ROOT, 'config', 'profile.example.json'),
  companies: join(ROOT, 'config', 'companies.example.json'),
  resume: join(ROOT, 'resume', 'resume.example.md'),
};

export function loadProfile(path = paths().profile) {
  if (!existsSync(path)) throw new Error(`${path} not found — open Settings in the dashboard or run "applio init"`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function loadResume(path = paths().resume) {
  if (!existsSync(path)) throw new Error(`${path} not found — add your résumé in Settings or run "applio init"`);
  return readFileSync(path, 'utf8');
}
export function loadCompanies(path = paths().companies) {
  if (!existsSync(path)) throw new Error(`${path} not found — add companies in Settings or run "applio init"`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Current config plus whether each file exists; missing files come back as the examples. */
export function readConfig() {
  const p = paths();
  const read = (k, parse) => existsSync(p[k]) ? { value: parse(readFileSync(p[k], 'utf8')), exists: true } : { value: parse(readFileSync(examples[k], 'utf8')), exists: false };
  const profile = read('profile', JSON.parse), companies = read('companies', JSON.parse), resume = read('resume', s => s);
  return { profile: profile.value, companies: companies.value, resume: resume.value, exists: { profile: profile.exists, companies: companies.exists, resume: resume.exists }, originalPdf: existsSync(p.originalPdf), paths: { ...p, originalPdf: p.originalPdf } };
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', text);
  renameSync(path + '.tmp', path);
}

const isStrList = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const bad = msg => Object.assign(new Error(msg), { status: 400 });

export function validateProfile(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('profile must be an object');
  for (const k of ['name', 'email']) if (typeof p[k] !== 'string' || !p[k].trim()) throw bad(`profile.${k} is required`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw bad('profile.email does not look like an email address');
  const pr = p.preferences;
  if (!pr || typeof pr !== 'object') throw bad('profile.preferences is required');
  for (const k of ['titles', 'titleKeywords', 'excludeTitleKeywords', 'excludeCompanies', 'skills', 'locations', 'seniority']) {
    if (pr[k] !== undefined && !isStrList(pr[k])) throw bad(`preferences.${k} must be a list of text`);
  }
  if (p.resumePdf !== undefined && !['original', 'generated'].includes(p.resumePdf)) throw bad('resumePdf must be "original" or "generated"');
  if (pr.minScore !== undefined && !(Number.isFinite(pr.minScore) && pr.minScore >= 0 && pr.minScore <= 100)) throw bad('preferences.minScore must be 0–100');
  for (const a of p.answers || []) {
    if (typeof a?.match !== 'string' || typeof a?.answer !== 'string') throw bad('each standing answer needs "match" and "answer" text');
    try { new RegExp(a.match, 'i'); } catch { throw bad(`standing answer pattern "${a.match}" is not a valid pattern`); }
  }
  return p;
}

export function validateCompanies(list) {
  if (!Array.isArray(list)) throw bad('companies must be a list');
  const seen = new Set();
  return list.map((c, i) => {
    const where = `company #${i + 1}${c?.name ? ` (${c.name})` : ''}`;
    if (!c || typeof c !== 'object') throw bad(`${where} is not an object`);
    if (!['greenhouse', 'lever', 'ashby', 'workday'].includes(c.ats)) throw bad(`${where}: ats must be greenhouse, lever, ashby or workday`);
    if (c.ats === 'workday') { for (const k of ['host', 'tenant', 'site']) if (!c[k]) throw bad(`${where}: Workday needs host, tenant and site`); }
    else if (!c.slug || !/^[A-Za-z0-9._-]+$/.test(c.slug)) throw bad(`${where}: slug is missing or invalid`);
    const key = `${c.ats}:${c.slug || c.tenant + '/' + c.site}`.toLowerCase();
    if (seen.has(key)) throw bad(`${where} is listed twice`);
    seen.add(key);
    return c;
  });
}

export function saveOriginalPdf(buffer) {
  const path = paths().originalPdf;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', buffer);
  renameSync(path + '.tmp', path);
  return path;
}

export const saveProfile = p => (writeAtomic(paths().profile, JSON.stringify(validateProfile(p), null, 2) + '\n'), p);
export const saveCompanies = l => (writeAtomic(paths().companies, JSON.stringify(validateCompanies(l), null, 2) + '\n'), l);
export function saveResume(md) {
  if (typeof md !== 'string' || !md.trim()) throw bad('résumé is empty');
  if (md.length > 200_000) throw bad('résumé is too long');
  writeAtomic(paths().resume, md.replace(/\r\n/g, '\n'));
  return md;
}

/** Candidate context shared (and cached) across every AI call. */
export function candidateContext(profile, resume) {
  const { preferences, ...facts } = profile;
  return `<candidate_profile>\n${JSON.stringify(facts, null, 2)}\n</candidate_profile>\n\n<resume>\n${resume}\n</resume>`;
}
