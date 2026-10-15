import { readFileSync, existsSync } from 'node:fs';

export function loadProfile(path = 'config/profile.json') {
  if (!existsSync(path)) throw new Error(`${path} not found — run "applio init" first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function loadResume(path = 'resume/resume.md') {
  if (!existsSync(path)) throw new Error(`${path} not found — run "applio init" and paste your résumé there`);
  return readFileSync(path, 'utf8');
}
export function loadCompanies(path = 'config/companies.json') {
  if (!existsSync(path)) throw new Error(`${path} not found — run "applio init" first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Candidate context shared (and cached) across every Claude call. */
export function candidateContext(profile, resume) {
  const { preferences, ...facts } = profile;
  return `<candidate_profile>\n${JSON.stringify(facts, null, 2)}\n</candidate_profile>\n\n<resume>\n${resume}\n</resume>`;
}
