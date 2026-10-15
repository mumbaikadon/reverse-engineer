// Build the user's profile from their résumé with no typing: the built-in parser always runs,
// and if an AI provider is connected its reading takes precedence field by field.
import { draftProfile } from './profile.js';
import { structured, providerInfo } from './llm.js';

const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'staff', 'manager'];

const INSTRUCTIONS = `You read a résumé and fill in a job seeker's profile for an application assistant.

Rules:
- Use only what the résumé says. Use "" (or 0 for numbers) for anything it does not state; never guess contact details.
- target_titles: 2–5 job titles this person would search for next, based on their recent roles (e.g. "backend engineer"), lowercase, without seniority words.
- skills: up to 15 of their strongest, most marketable skills from the résumé, lowercase.
- seniority: the 1–2 levels they would apply at, from: ${SENIORITY.join(', ')}.
- years_experience: whole years of professional experience (from the earliest job to now), 0 if unclear.
- locations: places they would work, starting with where they live (city names, lowercase).`;

const str = { type: 'string' };
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'email', 'phone', 'location', 'country', 'linkedin', 'github', 'website', 'current_title', 'current_company', 'years_experience', 'target_titles', 'skills', 'seniority', 'locations'],
  properties: {
    name: str, email: str, phone: str, location: { type: 'string', description: 'City, region, country as written' }, country: str,
    linkedin: str, github: str, website: str, current_title: str, current_company: str,
    years_experience: { type: 'integer' },
    target_titles: { type: 'array', items: str }, skills: { type: 'array', items: str },
    seniority: { type: 'array', items: { type: 'string', enum: SENIORITY } },
    locations: { type: 'array', items: str },
  },
};

// What a résumé can tell us. Everything else in an existing profile (standing answers, EEO,
// sponsorship, score threshold, search options) is the user's choice and is kept.
const CONTACT = ['name', 'firstName', 'lastName', 'email', 'phone', 'location', 'country'];
const FROM_RESUME = [...CONTACT, 'currentCompany', 'currentTitle', 'yearsExperience'];
const PREFS_FROM_RESUME = ['titles', 'titleKeywords', 'skills', 'seniority', 'locations'];
const filled = v => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);

function mergeOnto(base, draft) {
  const out = structuredClone(base);
  // A different person's résumé: don't carry the old contact details over.
  const samePerson = !draft.name || !base.name || draft.name.toLowerCase() === base.name.toLowerCase();
  if (!samePerson) { for (const k of CONTACT) delete out[k]; out.links = {}; }
  for (const k of FROM_RESUME) if (filled(draft[k])) out[k] = draft[k];
  out.links = { ...out.links, ...Object.fromEntries(Object.entries(draft.links || {}).filter(([, v]) => filled(v))) };
  out.preferences = { ...draft.preferences, ...base.preferences };
  for (const k of PREFS_FROM_RESUME) if (filled(draft.preferences[k])) out.preferences[k] = draft.preferences[k];
  return out;
}

const url = u => u && (/^https?:\/\//.test(u) ? u : `https://${u}`);
const lowerList = l => [...new Set((l || []).map(s => String(s).trim().toLowerCase()).filter(Boolean))];

/**
 * @returns {Promise<{profile: object, source: 'ai'|'parser', provider: string|null, missing: string[], note?: string}>}
 */
export async function profileFromResume(markdown, base = null) {
  const draft = draftProfile(markdown);
  const profile = base ? mergeOnto(base, draft) : draft;
  let source = 'parser', note;
  const ai = providerInfo();
  if (ai && markdown.trim()) {
    try {
      const { data: d } = await structured({ instructions: INSTRUCTIONS, context: 'Reply with the profile fields only.', prompt: `<resume>\n${markdown.slice(0, 60_000)}\n</resume>`, schema: SCHEMA, effort: 'low' });
      const set = (k, v) => { if (v !== '' && v != null && !(Array.isArray(v) && !v.length) && v !== 0) profile[k] = v; };
      set('name', d.name.trim()); set('email', d.email.trim()); set('phone', d.phone.trim()); set('location', d.location.trim());
      set('country', d.country.trim()); set('currentTitle', d.current_title.trim()); set('currentCompany', d.current_company.trim());
      set('yearsExperience', d.years_experience);
      profile.links = { ...profile.links, ...Object.fromEntries(Object.entries({ linkedin: url(d.linkedin), github: url(d.github), website: url(d.website) }).filter(([, v]) => v)) };
      const pr = profile.preferences;
      if (d.target_titles.length) { pr.titles = lowerList(d.target_titles); pr.titleKeywords = [...new Set(pr.titles.flatMap(t => t.split(/\s+/)).filter(w => w.length > 2))]; }
      if (d.skills.length) pr.skills = lowerList(d.skills);
      if (d.seniority.length) pr.seniority = d.seniority;
      if (d.locations.length) pr.locations = lowerList(d.locations);
      source = 'ai';
    } catch (e) { note = `${ai.label} couldn't read it (${e.message}); used the built-in parser instead.`; }
  }
  if (profile.name) { const [f, ...r] = profile.name.split(/\s+/); profile.firstName ??= f; if (r.length) profile.lastName ??= r.join(' '); }
  const missing = [];
  if (!profile.name) missing.push('name');
  if (!profile.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profile.email)) missing.push('email');
  if (!profile.preferences.titles?.length) missing.push('titles');
  return { profile, source, provider: source === 'ai' ? ai.label : null, missing, ...(note ? { note } : {}) };
}
