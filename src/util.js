// Small shared helpers: HTML → text, polite fetching with retries, concurrency.

const UA = 'applio/0.1 (+self-hosted job search agent)';

export function htmlToText(html = '') {
  return String(html)
    .replace(/&amp;/g, '&') // Greenhouse double-escapes: "&amp;lt;" → "&lt;" → "<"
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export async function fetchJson(url, { method = 'GET', body, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': UA, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) throw Object.assign(new Error(`404 Not Found: ${url}`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
