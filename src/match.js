// Deterministic fit scoring: cheap enough to run over thousands of postings on every scan.
// Score is 0–100 and comes with human-readable reasons, mirroring what a recruiter screen checks.

const norm = s => String(s || '').toLowerCase();
const has = (text, term) => new RegExp(`(^|[^a-z0-9+#.])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9+#])`).test(text);

// Checked in order: the most specific level wins ("Senior Staff" is staff, not senior).
const SENIORITY = [
  ['intern', /\bintern(ship)?\b/], ['manager', /\b(manager|director|head of|vp)\b/],
  ['staff', /\b(staff|principal|lead|architect|distinguished)\b/], ['senior', /\b(senior|sr\.?|iii)\b/],
  ['junior', /\b(junior|jr\.?|new grad|entry[- ]level|associate)\b/], ['mid', /\b(ii|mid)\b/],
];
export const seniorityOf = title => (SENIORITY.find(([, re]) => re.test(norm(title))) || ['mid'])[0];

// Very short skill names ("Go", "R", "C") are ordinary words in lowercase prose, so
// match them case-sensitively against the original text (or via a common alias).
const ALIASES = { go: ['golang'], r: ['rstats'], c: [] };
function hasSkill(rawText, lowerText, skill) {
  if (skill.length > 2) return has(lowerText, skill);
  const proper = skill[0].toUpperCase() + skill.slice(1);
  return new RegExp(`(^|[^A-Za-z0-9+#])${proper}($|[^A-Za-z0-9+#])`).test(rawText) || (ALIASES[skill.toLowerCase()] || []).some(a => has(lowerText, a));
}

export function score(job, prefs) {
  const title = norm(job.title), desc = norm(job.description), loc = norm(job.location);
  const rawText = `${job.title}\n${job.description || ''}`;
  const reasons = [];
  let s = 0;

  // Hard filters
  for (const x of prefs.excludeTitleKeywords || []) if (has(title, x)) return { score: 0, reasons: [`title contains excluded "${x}"`], excluded: true };
  for (const c of prefs.excludeCompanies || []) if (norm(job.company) === norm(c)) return { score: 0, reasons: [`company ${job.company} excluded`], excluded: true };

  // Title (40)
  const titleHits = (prefs.titles || []).filter(t => title.includes(norm(t)));
  const kwHits = (prefs.titleKeywords || []).filter(k => has(title, k));
  if (titleHits.length) { s += 35; reasons.push(`title matches "${titleHits[0]}"`); }
  else if (kwHits.length) { s += 18 + Math.min(kwHits.length, 3) * 6; reasons.push(`title keywords: ${kwHits.join(', ')}`); }
  else reasons.push('title not in target list');

  // Skills (30)
  const skills = prefs.skills || [];
  const skillHits = skills.filter(k => hasSkill(rawText, `${title}\n${desc}`, k));
  if (skills.length) {
    s += Math.round(30 * Math.min(1, skillHits.length / Math.max(3, Math.ceil(skills.length * 0.6))));
    if (skillHits.length) reasons.push(`skills: ${skillHits.slice(0, 6).join(', ')}${skillHits.length > 6 ? '…' : ''}`);
  }

  // Location (20)
  const wantLocs = (prefs.locations || []).map(norm);
  const locOk = wantLocs.some(l => has(loc, l)) || (prefs.remoteOk && job.remote);
  if (locOk) { s += 20; reasons.push(job.remote && prefs.remoteOk ? 'remote ok' : `location ${job.location}`); }
  else if (wantLocs.length) { reasons.push(`location ${job.location || 'unknown'} not preferred`); if (prefs.strictLocation) return { score: 0, reasons, excluded: true }; }
  else s += 10;

  // Seniority (10)
  const sen = seniorityOf(job.title);
  if (!prefs.seniority?.length || prefs.seniority.includes(sen)) { s += 10; } else reasons.push(`seniority ${sen} outside target`);

  // Freshness bonus: being early matters more than anything else.
  if (job.postedAt) {
    const hours = (Date.now() - new Date(job.postedAt).getTime()) / 36e5;
    if (hours < 48) { s += 5; reasons.push(`posted ${Math.max(1, Math.round(hours))}h ago`); }
  }

  // Work authorization signals
  if (prefs.needsSponsorship && /(unable|not able|cannot|will not|won't|no)\s+(to\s+)?(provide\s+|offer\s+)?(visa\s+)?sponsor/.test(desc)) {
    s = Math.min(s, 15); reasons.push('posting says no visa sponsorship');
  }
  return { score: Math.min(100, s), reasons };
}

export function rank(jobs, prefs) {
  return jobs.map(job => ({ job, ...score(job, prefs) })).filter(r => !r.excluded).sort((a, b) => b.score - a.score);
}
