import * as greenhouse from './greenhouse.js';
import * as lever from './lever.js';
import * as ashby from './ashby.js';
import * as workday from './workday.js';
import { mapLimit } from '../util.js';

export const SOURCES = { greenhouse, lever, ashby, workday };

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
