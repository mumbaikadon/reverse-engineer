// Lever public Postings API: https://api.lever.co/v0/postings/{company}?mode=json
import { fetchJson } from '../util.js';

export async function list({ slug, name }) {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (data || []).map(j => normalize(j, { slug, name }));
}

/** Recent jobs whose title passes `keep` (these lists already include descriptions). */
export async function listRecent(board, { since, keep }) {
  return (await list(board)).filter(j => j.postedAt && new Date(j.postedAt) >= since && keep(j.title));
}

export function normalize(j, { slug, name }) {
  const location = j.categories?.allLocations?.join(' / ') || j.categories?.location || '';
  const lists = (j.lists || []).map(l => `${l.text}\n${(l.content || '').replace(/<li>/g, '• ').replace(/<[^>]+>/g, '\n')}`).join('\n\n');
  return {
    id: `lever:${slug}:${j.id}`,
    ats: 'lever',
    board: slug,
    externalId: j.id,
    company: name || slug,
    title: j.text.trim(),
    location,
    remote: j.workplaceType === 'remote' || /remote/i.test(location),
    url: j.hostedUrl,
    applyUrl: j.applyUrl,
    department: j.categories?.team || '',
    description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  };
}
