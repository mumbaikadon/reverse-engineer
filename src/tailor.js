// Per-job résumé + cover letter tailoring, with a guard against invented facts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { structured } from './llm.js';
import { candidateContext } from './profile.js';
import { slugify } from './util.js';

const INSTRUCTIONS = `You tailor a candidate's résumé to one job posting.

Rules:
- Only rephrase, reorder and emphasise what is already in the résumé. Never add employers, titles, dates, degrees, tools, metrics or achievements that the résumé does not support. If the posting asks for something the candidate lacks, list it under keywords_missing instead of claiming it.
- Each bullet edit must quote one existing résumé bullet exactly in "original" (the text after the leading "- ", verbatim) and give the improved version in "rewritten". Skip bullets that are already strong or irrelevant. Aim for 3–8 edits.
- Use the posting's own vocabulary where it truthfully describes the candidate's work, so applicant-tracking keyword filters pick it up. Keep each bullet to one line, starting with a strong verb.
- The summary is 2–3 sentences aimed at this role.
- The cover letter is 150–250 words, plain text, specific to the company and role, in the candidate's voice, with no clichés ("I am writing to express…"). Sign it with the candidate's name.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'bullet_edits', 'skills_order', 'keywords_matched', 'keywords_missing', 'cover_letter'],
  properties: {
    summary: { type: 'string' },
    bullet_edits: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['original', 'rewritten', 'reason'],
        properties: { original: { type: 'string' }, rewritten: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    skills_order: { type: 'array', items: { type: 'string' }, description: 'The candidate\'s existing skills, most relevant to this job first' },
    keywords_matched: { type: 'array', items: { type: 'string' } },
    keywords_missing: { type: 'array', items: { type: 'string' } },
    cover_letter: { type: 'string' },
  },
};

const numbersIn = s => (String(s).match(/\d[\d,.]*%?/g) || []).map(n => n.replace(/[,.]$/, ''));

/** Drop edits that quote a non-existent bullet or introduce numbers absent from the résumé. */
export function vetEdits(resume, edits) {
  const known = new Set(numbersIn(resume));
  const accepted = [], rejected = [];
  for (const e of edits) {
    if (!resume.includes(e.original.trim())) { rejected.push({ ...e, why: 'original bullet not found in résumé' }); continue; }
    const invented = numbersIn(e.rewritten).filter(n => !known.has(n));
    if (invented.length) { rejected.push({ ...e, why: `introduces figures not in résumé: ${invented.join(', ')}` }); continue; }
    accepted.push(e);
  }
  return { accepted, rejected };
}

export function applyEdits(resume, { summary, accepted, skillsOrder }) {
  let out = resume;
  for (const e of accepted) out = out.replace(e.original.trim(), e.rewritten.trim());
  if (summary) out = out.replace(/(^##\s*Summary\s*\n)([\s\S]*?)(?=\n##\s|$)/im, `$1${summary.trim()}\n`);
  if (skillsOrder?.length) {
    out = out.replace(/(^##\s*Skills\s*\n)([\s\S]*?)(?=\n##\s|$)/im, (m, h, body) => {
      const existing = body.split(/[,\n]/).map(s => s.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
      const lower = existing.map(s => s.toLowerCase());
      const ordered = [...skillsOrder.filter(s => lower.includes(s.toLowerCase())), ...existing.filter(s => !skillsOrder.some(o => o.toLowerCase() === s.toLowerCase()))];
      return `${h}${[...new Set(ordered)].join(', ')}\n`;
    });
  }
  return out;
}

export function diffMarkdown(job, accepted, rejected, data) {
  const lines = [`# Changes for ${job.title} @ ${job.company}`, '', `Matched keywords: ${data.keywords_matched.join(', ') || '—'}`,
    `Missing (not claimed): ${data.keywords_missing.join(', ') || '—'}`, '', '## Summary', '', data.summary, '', '## Bullet edits', ''];
  for (const e of accepted) lines.push(`- − ${e.original}`, `- + ${e.rewritten}`, `  _${e.reason}_`, '');
  if (rejected.length) {
    lines.push('## Rejected by fact check', '');
    for (const e of rejected) lines.push(`- ${e.rewritten}`, `  _${e.why}_`, '');
  }
  return lines.join('\n');
}

export async function tailor({ job, profile, resume, outDir = 'out' }) {
  const prompt = `<job_posting company="${job.company}" title="${job.title}" location="${job.location}">\n${job.description.slice(0, 30000)}\n</job_posting>\n\nTailor the résumé to this posting.`;
  const { data, usage } = await structured({ instructions: INSTRUCTIONS, context: candidateContext(profile, resume), prompt, schema: SCHEMA, effort: 'medium' });

  const { accepted, rejected } = vetEdits(resume, data.bullet_edits);
  const tailored = applyEdits(resume, { summary: data.summary, accepted, skillsOrder: data.skills_order });

  const dir = join(outDir, slugify(`${job.company}-${job.title}`) + '-' + slugify(job.externalId).slice(-8));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'resume.md'), tailored);
  writeFileSync(join(dir, 'cover_letter.txt'), data.cover_letter.trim() + '\n');
  writeFileSync(join(dir, 'changes.md'), diffMarkdown(job, accepted, rejected, data));
  writeFileSync(join(dir, 'tailor.json'), JSON.stringify({ job: { id: job.id, title: job.title, company: job.company }, ...data, accepted, rejected, usage }, null, 2));
  return { dir, accepted, rejected, data, usage };
}
