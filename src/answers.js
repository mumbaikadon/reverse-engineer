// Turn application-form questions into answers: profile facts first, the AI provider for the rest.
import { structured, hasCredentials } from './llm.js';
import { candidateContext } from './profile.js';

const pick = (options, ...wants) => {
  if (!options?.length) return null;
  for (const w of wants) {
    const hit = options.find(o => (w instanceof RegExp ? w.test(o) : o.toLowerCase() === String(w).toLowerCase()));
    if (hit) return hit;
  }
  return null;
};
const yesNo = (options, yes) => pick(options, yes ? /^yes\b/i : /^no\b/i) ?? (yes ? 'Yes' : 'No');

/**
 * Deterministic mapping from common labels to profile fields.
 * Returns undefined when the question needs judgement.
 */
export function fromProfile(q, p) {
  const l = q.label.toLowerCase();
  const o = q.options;
  const [first, ...rest] = (p.name || '').split(' ');
  // The candidate's own standing answers come first, e.g. { "match": "ever worked for", "answer": "No" }.
  for (const a of p.answers || []) {
    if (!new RegExp(a.match, 'i').test(q.label)) continue;
    const v = o?.length ? pick(o, a.answer) ?? pick(o, new RegExp(`^${a.answer}`, 'i')) : a.answer;
    if (v != null) return v;
  }
  const rules = [
    [/^(legal )?first name|given name|preferred first/, () => p.firstName || first],
    [/^(legal )?last name|surname|family name/, () => p.lastName || rest.join(' ')],
    [/^(full )?name$|^your name/, () => p.name],
    [/e-?mail/, () => p.email],
    [/phone|mobile/, () => p.phone],
    [/linkedin/, () => p.links?.linkedin],
    [/github/, () => p.links?.github],
    [/portfolio|personal (web)?site|^website/, () => p.links?.website || p.links?.portfolio],
    [/^country( of residence)?$|which country do you (currently )?(live|reside)/, () => p.country],
    [/^(current )?(location|city)|where are you (currently )?(located|based)/, () => p.location],
    [/current (or previous )?(company|employer)|most recent (company|employer)/, () => p.currentCompany],
    [/current (or previous )?(job )?title|most recent title/, () => p.currentTitle],
    [/(require|need).*(sponsor)|sponsorship/, () => yesNo(o, !!p.workAuthorization?.needsSponsorship)],
    [/(legally )?authori[sz]ed to work|eligible to work|right to work/, () => yesNo(o, p.workAuthorization?.authorized !== false)],
    [/salary|compensation expectation|desired pay/, () => p.salaryExpectation],
    [/notice period|start date|when can you start|earliest start/, () => p.availability],
    [/how (did |do )?you (hear|heard|find|found|learn)|where did you (hear|find)|referr(al|ed) source|source of (your )?application/, () => pick(o, /careers? (page|site)|company website|job board|website/i) || (o?.length ? undefined : p.howDidYouHear || 'Company careers page')],
    [/pronouns/, () => p.pronouns || pick(o, /decline|prefer not/i)],
    [/relocat/, () => yesNo(o, !!p.willingToRelocate)],
    [/how many years|years of [a-z ,-]*experience/, () => (o ? pick(o, ...bucketRegexes(p.yearsExperience)) : String(p.yearsExperience ?? ''))],
    // Voluntary self-identification: use stated answers, otherwise decline.
    [/gender|race|ethnicit|hispanic|latino|veteran|military|disabilit|sexual orientation|transgender/, () => {
      const key = Object.keys(p.eeo || {}).find(k => l.includes(k.toLowerCase()));
      return (key && (pick(o, p.eeo[key]) || p.eeo[key])) || pick(o, /decline|prefer not|don.?t wish|do not wish|not to (say|answer|disclose)/i);
    }],
    [/privacy (policy|notice)|consent|acknowledge|certify|i agree|attest/, () => pick(o, /^(yes|i agree|i acknowledge|i consent|acknowledge|agree)/i) || (q.type === 'checkbox' ? true : undefined)],
  ];
  for (const [re, f] of rules) {
    if (!re.test(l)) continue;
    let v = f();
    if (v === undefined || v === null || v === '') continue;
    // A choice question needs one of its own options; otherwise let the AI decide.
    if (o?.length && typeof v === 'string' && !o.includes(v)) v = pick(o, v) ?? pick(o, new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function bucketRegexes(years) {
  if (years == null) return [];
  return [new RegExp(`^${years}\\b`), new RegExp(`\\b${years}\\+`), ...[1, 2, 3, 5, 7, 10, 15].filter(b => years >= b).reverse().map(b => new RegExp(`\\b${b}\\+|${b}\\s*-`))];
}

const INSTRUCTIONS = `You fill in a job application on the candidate's behalf. For each question, write the answer the candidate would give.

Rules:
- Use only facts in the candidate profile and résumé. Never invent experience, credentials, numbers or personal details.
- If a question cannot be answered truthfully from that information (e.g. a specific certification, a reference's phone number, a personal preference not on file), set "answer" to "" and "needs_human" to true.
- For questions with options, "answer" must be exactly one of the options (or several, joined by " | ", only when the field allows multiple).
- Open-ended answers: 2–5 sentences, first person, specific to this company and role, plain and direct.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'answer', 'needs_human'],
        properties: { id: { type: 'string' }, answer: { type: 'string' }, needs_human: { type: 'boolean' } },
      },
    },
  },
};

/**
 * @param {Array<{id:string,label:string,type:string,options?:string[],required?:boolean,multiple?:boolean}>} questions
 * @returns {Promise<Record<string,{value:any,source:'profile'|'claude'|'missing'}>>}
 */
export async function answerQuestions({ questions, job, profile, resume, coverLetter }) {
  const out = {};
  const open = [];
  for (const q of questions) {
    if (q.type === 'file') continue;
    if (/cover letter/i.test(q.label) && coverLetter && !q.options?.length) { out[q.id] = { value: coverLetter, source: 'tailor' }; continue; }
    const v = fromProfile(q, profile);
    if (v !== undefined) out[q.id] = { value: v, source: 'profile' };
    else open.push(q);
  }
  if (!open.length) return out;
  if (!hasCredentials()) {
    for (const q of open) out[q.id] = { value: '', source: 'missing' };
    return out;
  }
  const prompt = `<job company="${job.company}" title="${job.title}">\n${(job.description || '').slice(0, 12000)}\n</job>\n\n<questions>\n${JSON.stringify(
    open.map(q => ({ id: q.id, question: q.label, type: q.type, required: !!q.required, ...(q.options?.length ? { options: q.options, multiple: !!q.multiple } : {}) })), null, 1)}\n</questions>`;
  const { data } = await structured({ instructions: INSTRUCTIONS, context: candidateContext(profile, resume), prompt, schema: SCHEMA, effort: 'low' });
  const byId = Object.fromEntries(data.answers.map(a => [a.id, a]));
  for (const q of open) {
    const a = byId[q.id];
    let value = a?.answer ?? '';
    if (q.options?.length && value && !q.multiple && !q.options.includes(value)) value = pick(q.options, value) || '';
    out[q.id] = { value, source: a && !a.needs_human && value !== '' ? 'claude' : 'missing' };
  }
  return out;
}
