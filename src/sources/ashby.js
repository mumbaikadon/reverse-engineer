// Ashby public Job Posting API: https://api.ashbyhq.com/posting-api/job-board/{name}
import { fetchJson } from '../util.js';

export async function list({ slug, name }) {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  return (data.jobs || []).filter(j => j.isListed !== false).map(j => normalize(j, { slug, name }));
}

export function normalize(j, { slug, name }) {
  const locs = [j.location, ...(j.secondaryLocations || []).map(l => l.location)].filter(Boolean);
  return {
    id: `ashby:${slug}:${j.id}`,
    ats: 'ashby',
    board: slug,
    externalId: j.id,
    company: name || slug,
    title: j.title.trim(),
    location: locs.join(' / '),
    remote: !!j.isRemote || j.workplaceType === 'Remote',
    url: j.jobUrl,
    applyUrl: j.applyUrl,
    department: j.department || '',
    compensation: j.compensation?.compensationTierSummary || '',
    description: (j.descriptionPlain || '').trim(),
    postedAt: j.publishedAt || null,
  };
}
