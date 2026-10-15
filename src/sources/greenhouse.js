// Greenhouse public Job Board API: https://boards-api.greenhouse.io/v1/boards/{token}/jobs
import { fetchJson, htmlToText } from '../util.js';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

export async function list({ slug, name }) {
  const data = await fetchJson(`${BASE}/${slug}/jobs?content=true`);
  return (data.jobs || []).map(j => normalize(j, { slug, name }));
}

export function normalize(j, { slug, name }) {
  const location = j.location?.name || '';
  return {
    id: `greenhouse:${slug}:${j.id}`,
    ats: 'greenhouse',
    board: slug,
    externalId: String(j.id),
    company: name || j.company_name || slug,
    title: j.title.trim(),
    location,
    remote: /remote/i.test(location),
    url: j.absolute_url,
    applyUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${slug}&token=${j.id}`,
    department: j.departments?.[0]?.name || '',
    description: htmlToText(j.content),
    postedAt: j.first_published || j.updated_at || null,
  };
}

/**
 * Jobs first published in the last `days` whose title passes `keep`, with descriptions fetched
 * only for those. The plain list (no content) is ~12x smaller than ?content=true.
 */
export async function listRecent({ slug, name }, { since, keep }) {
  const data = await fetchJson(`${BASE}/${slug}/jobs`);
  const hits = (data.jobs || []).filter(j => new Date(j.first_published || j.updated_at) >= since && keep(j.title));
  const out = [];
  for (const j of hits.slice(0, 40)) {
    try { out.push(normalize(await fetchJson(`${BASE}/${slug}/jobs/${j.id}`), { slug, name })); }
    catch { out.push(normalize(j, { slug, name })); }
  }
  return out;
}

// The board API also publishes each job's application questions, which lets us
// prepare answers before ever opening the form.
export async function questions({ board, externalId }) {
  const data = await fetchJson(`${BASE}/${board}/jobs/${externalId}?questions=true`);
  return (data.questions || []).map(q => ({
    label: htmlToText(q.label),
    required: !!q.required,
    description: htmlToText(q.description || ''),
    fields: q.fields.map(f => ({ name: f.name, type: f.type, options: (f.values || []).map(v => v.label) })),
  }));
}
