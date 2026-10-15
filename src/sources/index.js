import * as greenhouse from './greenhouse.js';
import * as lever from './lever.js';
import * as ashby from './ashby.js';
import * as workday from './workday.js';
import { mapLimit } from '../util.js';
import { readFileSync } from 'node:fs';

export const SOURCES = { greenhouse, lever, ashby, workday };

const DIRECTORY = JSON.parse(readFileSync(new URL('../board-directory.json', import.meta.url), 'utf8'));
export const directory = () => DIRECTORY;
const boardKey = c => `${c.ats}:${c.slug || c.tenant}`.toLowerCase();

/**
 * Search the whole company directory for recent jobs matching `keep`, skipping boards already
 * scanned in full (the watchlist). Workday boards are only scanned via the watchlist.
 */
export async function searchDirectory({ days = 7, keep, skip = [], extra = [], concurrency = 12, onProgress } = {}) {
  const since = new Date(Date.now() - days * 864e5);
  const skipKeys = new Set(skip.map(boardKey));
  const boards = [...new Map([...DIRECTORY, ...extra].filter(b => SOURCES[b.ats]?.listRecent && !skipKeys.has(boardKey(b))).map(b => [boardKey(b), b])).values()];
  let done = 0, failed = 0;
  const results = await mapLimit(boards, concurrency, async b => {
    try { return await SOURCES[b.ats].listRecent(b, { since, keep }); }
    catch { failed++; return []; }
    finally { if (++done % 50 === 0 || done === boards.length) onProgress?.(done, boards.length); }
  });
  return { jobs: results.flat(), boards: boards.length, failed };
}

/** Fetch every board in the watchlist. Failures are reported, not fatal. */
export async function scanAll(companies, { concurrency = 6, onBoard } = {}) {
  const results = await mapLimit(companies, concurrency, async c => {
    const src = SOURCES[c.ats];
    if (!src) return { company: c, error: `unknown ats "${c.ats}"`, jobs: [] };
    try {
      const jobs = await src.list(c);
      onBoard?.(c, jobs.length);
      return { company: c, jobs };
    } catch (err) {
      onBoard?.(c, 0, err);
      return { company: c, error: err.message, jobs: [] };
    }
  });
  return { jobs: results.flatMap(r => r.jobs), errors: results.filter(r => r.error) };
}
