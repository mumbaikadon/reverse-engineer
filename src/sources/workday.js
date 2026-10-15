// Workday career sites expose a JSON "cxs" endpoint behind every myworkdayjobs.com page:
//   POST https://{host}/wday/cxs/{tenant}/{site}/jobs        (search, 20 per page)
//   GET  https://{host}/wday/cxs/{tenant}/{site}{externalPath} (job detail)
import { fetchJson, htmlToText, mapLimit } from '../util.js';

export async function list({ host, tenant, site, name, searchText = '', maxJobs = 200, details = 40 }) {
  const base = `https://${host}/wday/cxs/${tenant}/${site}`;
  const postings = [];
  for (let offset = 0; offset < maxJobs; offset += 20) {
    const page = await fetchJson(`${base}/jobs`, { method: 'POST', body: { limit: 20, offset, searchText, appliedFacets: {} } });
    postings.push(...(page.jobPostings || []));
    if (!page.jobPostings?.length || offset + 20 >= (page.total || 0)) break;
  }
  // Search results carry no description; fetch details for the newest few only.
  const withDetail = await mapLimit(postings, 4, async (p, i) => {
    if (i >= details) return { p };
    try { return { p, d: (await fetchJson(`${base}${p.externalPath}`)).jobPostingInfo }; } catch { return { p }; }
  });
  return withDetail.map(({ p, d }) => normalize(p, d, { host, tenant, site, name }));
}

export function normalize(p, d, { host, site, tenant, name }) {
  const url = `https://${host}/${site}${p.externalPath}`;
  const location = d?.location || p.locationsText || '';
  return {
    id: `workday:${tenant}:${p.bulletFields?.[0] || p.externalPath}`,
    ats: 'workday',
    board: tenant,
    externalId: p.bulletFields?.[0] || p.externalPath,
    company: name || tenant,
    title: p.title.trim(),
    location,
    remote: /remote/i.test(location + ' ' + (d?.remoteType || '')),
    url,
    applyUrl: `${url}/apply`,
    department: '',
    description: htmlToText(d?.jobDescription || ''),
    postedAt: d?.startDate || null,
  };
}
