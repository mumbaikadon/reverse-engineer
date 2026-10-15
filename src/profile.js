// The user's résumé, profile and company watchlist: validation, storage (in SQLite via store.js),
// and a first draft of the profile read straight from the résumé.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJSON, setJSON, getBlob, setBlob, has } from './store.js';

const SUGGESTED = fileURLToPath(new URL('./suggested-companies.json', import.meta.url));
export const suggestedCompanies = () => JSON.parse(readFileSync(SUGGESTED, 'utf8'));

const SETUP = 'Finish setup in the dashboard first (npm run dashboard)';
export function loadProfile() { const p = getJSON('profile'); if (!p) throw new Error(`No profile yet. ${SETUP}.`); return p; }
export function loadResume() { const r = getJSON('resume'); if (!r) throw new Error(`No résumé yet. ${SETUP}.`); return r; }
export function loadCompanies() { const c = getJSON('companies'); if (!c?.length) throw new Error(`No companies yet. ${SETUP}.`); return c; }

export const setupState = () => ({ resume: has('resume'), profile: has('profile'), companies: (getJSON('companies') || []).length > 0 });

/** Everything the settings and onboarding pages need. Missing pieces come back empty, never as examples. */
export function readConfig() {
  const resume = getJSON('resume') || '';
  return {
    profile: getJSON('profile') || draftProfile(resume),
    companies: getJSON('companies') || [],
    resume,
    exists: setupState(),
    originalPdf: has('resume_pdf'),
  };
}

const isStrList = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const bad = msg => Object.assign(new Error(msg), { status: 400 });

export function validateProfile(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('profile must be an object');
  for (const k of ['name', 'email']) if (typeof p[k] !== 'string' || !p[k].trim()) throw bad(`${k === 'name' ? 'Your name' : 'Your email'} is required`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw bad('That email address does not look right');
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

export const saveProfile = p => setJSON('profile', validateProfile(p));
export const saveCompanies = l => setJSON('companies', validateCompanies(l));
export function saveResume(md) {
  if (typeof md !== 'string' || !md.trim()) throw bad('Your résumé is empty');
  if (md.length > 200_000) throw bad('Your résumé is too long');
  return setJSON('resume', md.replace(/\r\n/g, '\n'));
}

export const saveOriginalPdf = buf => setBlob('resume_pdf', buf);
export const getOriginalPdf = () => getBlob('resume_pdf');
/** Playwright uploads from disk, so materialise the stored PDF under out/ when needed. */
export function originalPdfPath() {
  const buf = getOriginalPdf();
  if (!buf) return null;
  const dir = join('out', '.uploads');
  mkdirSync(dir, { recursive: true });
  const name = (getJSON('profile')?.name || 'resume').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'resume';
  const path = join(dir, `${name}_Resume.pdf`);
  writeFileSync(path, buf);
  return path;
}

// ---- first draft of the profile from the résumé ------------------------
const SENIOR_WORDS = /\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|head of|associate|intern)\b|\b(i{1,3}|iv|[1-5])$/gi;

export function draftProfile(md = '') {
  const lines = md.split('\n');
  const name = (lines.find(l => /^#\s/.test(l)) || '').replace(/^#\s+/, '').trim();
  const nameIdx = lines.findIndex(l => /^#\s/.test(l));
  const contact = nameIdx >= 0 ? lines.slice(nameIdx + 1, nameIdx + 4).filter(l => l.trim() && !/^#/.test(l)).join(' | ') : '';
  const text = md;
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] || '';
  const phone = contact.match(/\+?\(?\d[\d\s().-]{7,}\d/)?.[0]?.trim() || '';
  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+/i)?.[0];
  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+/i)?.[0];
  const site = contact.split(/[|·•,]\s*|\s{2,}/).map(s => s.trim()).find(s => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s) && !/linkedin|github|@/.test(s));
  const location = contact.split(/\s*[|·•]\s*/).map(s => s.trim()).find(s => /^[A-Za-zÀ-ÿ .'-]+,\s*[A-Za-zÀ-ÿ .'-]{2,}(,\s*[A-Za-zÀ-ÿ .'-]+)?$/.test(s) && !/@/.test(s)) || '';
  const url = u => u && (/^https?:\/\//.test(u) ? u : `https://${u}`);

  // Roles: "### Title — Company (2021 – present)" or "### Title, Company (…)"
  const roles = lines.filter(l => /^###\s/.test(l)).map(l => {
    const h = l.replace(/^###\s+/, '');
    const dates = h.match(/\(([^)]*\d{4}[^)]*)\)\s*$/)?.[1] || '';
    const body = h.replace(/\([^)]*\)\s*$/, '').trim();
    const [title, company] = body.split(/\s+[—–-]\s+|\s+at\s+|,\s+/);
    return { title: (title || '').trim(), company: (company || '').trim(), years: (dates.match(/(19|20)\d{2}/g) || []).map(Number) };
  });
  const allYears = roles.flatMap(r => r.years);
  const yearsExperience = allYears.length ? Math.max(0, new Date().getFullYear() - Math.min(...allYears)) : undefined;

  const skillsLine = md.match(/^##\s*Skills[^\n]*\n([\s\S]*?)(?=\n##\s|$)/im)?.[1] || '';
  const skills = [...new Set(skillsLine.split(/[,\n•|]/).map(s => s.replace(/^[-*]\s*/, '').trim().toLowerCase()).filter(s => s && s.length <= 30))].slice(0, 20);
  const titles = [...new Set(roles.map(r => r.title.replace(SENIOR_WORDS, '').replace(/\s{2,}/g, ' ').replace(/[,\s]+$/, '').trim().toLowerCase()).filter(Boolean))].slice(0, 4);
  const keywords = [...new Set(titles.flatMap(t => t.split(/\s+/)).filter(w => w.length > 2 && !/^(and|the|for|of)$/.test(w)))].slice(0, 6);
  const y = yearsExperience ?? 3;
  const seniority = y < 2 ? ['junior', 'mid'] : y < 5 ? ['mid', 'senior'] : y < 10 ? ['mid', 'senior'] : ['senior', 'staff'];
  const [first, ...rest] = name.split(/\s+/);
  const city = location.split(',')[0]?.trim().toLowerCase();

  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
  return {
    ...clean({ name, firstName: first, lastName: rest.join(' '), email, phone, location, currentCompany: roles[0]?.company, currentTitle: roles[0]?.title, yearsExperience }),
    links: clean({ linkedin: url(linkedin), github: url(github), website: url(site) }),
    workAuthorization: { authorized: true, needsSponsorship: false },
    willingToRelocate: false,
    eeo: {},
    answers: [],
    preferences: {
      titles, titleKeywords: keywords, excludeTitleKeywords: ['intern'], excludeCompanies: [],
      skills, locations: city ? [city] : [], remoteOk: true, strictLocation: false, seniority,
      needsSponsorship: false, minScore: 60, dailyTailorLimit: 15,
    },
  };
}

/** Candidate context shared (and cached) across every AI call. */
export function candidateContext(profile, resume) {
  const { preferences, ...facts } = profile;
  return `<candidate_profile>\n${JSON.stringify(facts, null, 2)}\n</candidate_profile>\n\n<resume>\n${resume}\n</resume>`;
}
