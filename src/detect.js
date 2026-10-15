// Work out which job board a company uses from a careers-page URL or a plain name,
// then confirm it by fetching the board.
import { SOURCES } from './sources/index.js';

const titleCase = s => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Recognise a board from a URL or text without any network calls. */
export function parseBoardUrl(input) {
  const s = String(input).trim();
  let m;
  if ((m = s.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/i)) && !/^embed$/i.test(m[1])) return { ats: 'greenhouse', slug: m[1].toLowerCase() };
  if ((m = s.match(/greenhouse\.io\/[^\s"']*[?&]for=([A-Za-z0-9_-]+)/i))) return { ats: 'greenhouse', slug: m[1].toLowerCase() };
  if ((m = s.match(/boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/i))) return { ats: 'greenhouse', slug: m[1].toLowerCase() };
  if ((m = s.match(/jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9._-]+)/i))) return { ats: 'lever', slug: m[1] };
  if ((m = s.match(/api\.lever\.co\/v0\/postings\/([A-Za-z0-9._-]+)/i))) return { ats: 'lever', slug: m[1] };
  if ((m = s.match(/jobs\.ashbyhq\.com\/([A-Za-z0-9._%-]+)/i))) return { ats: 'ashby', slug: decodeURIComponent(m[1]) };
  if ((m = s.match(/api\.ashbyhq\.com\/posting-api\/job-board\/([A-Za-z0-9._-]+)/i))) return { ats: 'ashby', slug: m[1] };
  if ((m = s.match(/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:wday\/cxs\/[a-z0-9-]+\/)?(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i)) && !/^(wday|job|jobs)$/i.test(m[3])) {
    return { ats: 'workday', host: `${m[1].toLowerCase()}.${m[2].toLowerCase()}.myworkdayjobs.com`, tenant: m[1].toLowerCase(), site: m[3] };
  }
  return null;
}

async function countJobs(entry) {
  const jobs = await SOURCES[entry.ats].list(entry.ats === 'workday' ? { ...entry, maxJobs: 20, details: 0 } : entry);
  return jobs.length;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (applio board detector)' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  return { url: res.url, text: res.ok ? await res.text() : '' };
}

/**
 * @returns {Promise<{found: Array<{entry, jobs:number}>, tried: string[]}>}
 */
export async function detectBoards(input, { name } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw Object.assign(new Error('Enter a careers page URL or a company name'), { status: 400 });
  const found = [], tried = [];
  const confirm = async (entry, why) => {
    const key = JSON.stringify(entry);
    if (tried.includes(key)) return;
    tried.push(key);
    try {
      const jobs = await countJobs(entry);
      found.push({ entry: { ...entry, name: name || entry.name || titleCase(entry.slug || entry.tenant) }, jobs, via: why });
    } catch { /* not this board */ }
  };

  const direct = parseBoardUrl(raw);
  if (direct) { await confirm(direct, 'url'); return { found, tried }; }

  if (/^https?:\/\/|\.[a-z]{2,}(\/|$)/i.test(raw)) {
    // A company's own careers page: look for an embedded board link, following one redirect hop.
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const page = await fetchText(url);
      const fromRedirect = parseBoardUrl(page.url);
      const candidates = [fromRedirect, ...[...page.text.matchAll(/https?:\/\/[^\s"'<>]*(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com)[^\s"'<>]*/gi)].map(m => parseBoardUrl(m[0]))].filter(Boolean);
      const pageName = name || page.text.match(/<title>([^<|–-]+)/i)?.[1]?.trim();
      for (const c of candidates.slice(0, 6)) await confirm({ ...c, ...(pageName ? { name: pageName } : {}) }, 'page');
    } catch { /* unreachable page */ }
    if (found.length) return { found, tried };
  }

  // A bare company name: try the obvious slugs on each public board.
  const base = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[./]/)[0];
  const slugs = [...new Set([base.toLowerCase().replace(/[^a-z0-9]/g, ''), base.toLowerCase().replace(/[^a-z0-9]+/g, '-')])].filter(Boolean);
  await Promise.all(slugs.flatMap(slug => ['greenhouse', 'lever', 'ashby'].map(ats => confirm({ ats, slug, name: name || titleCase(base) }, 'name'))));
  // Some boards answer for any name with an empty list; only keep guesses that have postings.
  const real = found.filter(f => f.via !== 'name' || f.jobs > 0).sort((a, b) => b.jobs - a.jobs);
  return { found: real, tried };
}
