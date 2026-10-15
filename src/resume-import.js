// Turn an uploaded résumé PDF into the Markdown layout tailoring expects.
// Step 1 (always): extract text with PDF.js and rebuild headings/bullets from font size and layout.
// Step 2 (optional, needs an AI provider in Settings → Integrations): fix the structure without changing the wording.
import { structured, hasCredentials } from './llm.js';

const BULLET = /^\s*[•●▪■◦‣∙·\-–—*]\s*/;
const SECTION = /^(summary|profile|about( me)?|objective|professional summary|experience|work experience|professional experience|employment( history)?|education|skills|technical skills|core skills|projects|selected projects|certifications?|awards|publications|languages|interests|volunteer(ing)?( experience)?|leadership|activities)$/i;
const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

export async function extractPdfLines(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // isEvalSupported: false — never let font programs compile to JS.
  const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const lines = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    const rows = [];
    for (const it of items) {
      if (!it.str?.trim() && !it.hasEOL) continue;
      const [a, , , d, x, y] = it.transform;
      const size = Math.abs(d) || Math.abs(a);
      // Same line if baselines are within a third of the font size.
      let row = rows.find(r => Math.abs(r.y - y) < Math.max(2, size / 3));
      if (!row) rows.push(row = { y, page: n, parts: [] });
      row.parts.push({ x, str: it.str, size, w: it.width });
    }
    for (const r of rows.sort((a, b) => b.y - a.y)) {
      r.parts.sort((a, b) => a.x - b.x);
      let text = '';
      let end = null;
      for (const p of r.parts) {
        // Insert a space where PDF.js split words into separate runs.
        if (end !== null && p.x - end > p.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
        text += p.str;
        end = p.x + (p.w || 0);
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) lines.push({ text, size: Math.max(...r.parts.map(p => p.size)), x: r.parts[0].x, page: r.page });
    }
  }
  return { lines, pages: doc.numPages };
}

// Section names tailoring relies on (## Summary / ## Experience / ## Skills), plus common variants.
const CANON = [
  [/^(professional |career |executive )?(summary|profile)$|^about( me)?$|^objective$/i, 'Summary'],
  [/^((work|professional|relevant|employment) )?(experience|history)$|^employment$/i, 'Experience'],
  [/^((technical|core|key) )?skills( (&|and) (tools|technologies))?$|^technologies$|^tools$/i, 'Skills'],
];
const canonical = name => (CANON.find(([re]) => re.test(name)) || [, titleCase(name)])[1];
const DATE_RANGE = /\(?\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}\s*[–—-]\s*(((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}|present|current|now)\)?\s*$/i;

export function linesToMarkdown(lines) {
  if (!lines.length) return '';
  const sizes = lines.map(l => l.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)];
  const out = [];
  let named = false, section = '', job = null; // job = x of the current "### role" line
  const last = () => out[out.length - 1] ?? '';
  for (let i = 0; i < lines.length; i++) {
    const { text, size, x } = lines[i];
    const words = text.split(' ').length;
    if (/^page \d+( of \d+)?$|^\d+\s*\/\s*\d+$/i.test(text)) continue; // page footers

    if (!named && i < 3 && size >= body * 1.35 && words <= 6) {
      out.push(`# ${text === text.toUpperCase() ? titleCase(text) : text}`); named = true; continue;
    }
    const bare = text.replace(/[:\s]+$/, '');
    if ((SECTION.test(bare) || (bare === bare.toUpperCase() && /[A-Z]{2}/.test(bare) && words <= 4 && bare.length <= 32)) && size >= body * 0.95) {
      section = canonical(bare); job = null; out.push('', `## ${section}`); continue;
    }
    if (BULLET.test(text) && text.replace(BULLET, '').length > 1) { out.push(`- ${text.replace(BULLET, '')}`); continue; }

    const prevLine = lines[i - 1];
    // Wrapped continuation: starts lowercase / with punctuation, or is indented under a bullet.
    const continues = /^[a-z(,&;]/.test(text) || (last().startsWith('- ') && x > (prevLine?.x ?? 0) + 2);
    if (continues && last() && !last().startsWith('#')) { out[out.length - 1] += ' ' + text; continue; }

    // Role line: ends with a date range and is short.
    if (DATE_RANGE.test(text) && words <= 16 && !/\.$/.test(text)) {
      const m = text.match(DATE_RANGE);
      const head = text.slice(0, m.index).replace(/[\s,|–—-]+$/, '');
      out.push('', `### ${head ? `${head} (${m[0].replace(/[()]/g, '').trim()})` : text}`);
      job = x; continue;
    }
    // Under a role in Experience, sentence-like or indented lines are accomplishments even when the
    // PDF drew the bullet as a shape rather than a character.
    if (section === 'Experience' && job !== null && (x > job + 4 || words >= 5)) { out.push(`- ${text}`); continue; }
    out.push(text);
  }
  if (!named && out.length) out[0] = `# ${out[0]}`;
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const TIDY_INSTRUCTIONS = `You convert résumé text extracted from a PDF into clean Markdown.

Output layout:
# Full Name
one contact line
## Summary            (only if the résumé has one)
## Experience
### Job Title — Company (Start – End)
- one bullet per accomplishment
## Education
## Skills              (comma-separated on one line)
Keep any other sections the résumé has (Projects, Certifications, …) as ## sections.

Rules:
- Keep the candidate's wording exactly. Do not rewrite, summarise, add, or drop any facts, numbers, dates or skills.
- Only fix structure: join lines that were wrapped, split run-together bullets, remove page numbers and repeated headers/footers, and put each piece under the right heading.`;

export async function tidyWithAI(text) {
  const { data } = await structured({
    instructions: TIDY_INSTRUCTIONS,
    context: 'Return the Markdown in the "markdown" field.',
    prompt: `<extracted_text>\n${text.slice(0, 60_000)}\n</extracted_text>`,
    schema: { type: 'object', additionalProperties: false, required: ['markdown'], properties: { markdown: { type: 'string' } } },
    effort: 'low',
  });
  return data.markdown.trim() + '\n';
}

/** @returns {Promise<{markdown:string, pages:number, chars:number, tidied:boolean, warnings:string[]}>} */
export async function importResumePdf(buffer, { tidy = false } = {}) {
  if (!buffer?.length) throw Object.assign(new Error('The uploaded file is empty'), { status: 400 });
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw Object.assign(new Error('That file is not a PDF'), { status: 400 });
  let lines, pages;
  try { ({ lines, pages } = await extractPdfLines(buffer)); }
  catch (e) { throw Object.assign(new Error(`Could not read that PDF: ${e.message}`), { status: 400 }); }
  const text = lines.map(l => l.text).join('\n');
  const warnings = [];
  if (text.replace(/\s/g, '').length < 200) {
    warnings.push('Very little text was found. If this is a scanned image or a design export, copy the text from the original document and paste it instead.');
  }
  let markdown = linesToMarkdown(lines), tidied = false;
  if (tidy && hasCredentials() && text.trim()) {
    try { markdown = await tidyWithAI(text); tidied = true; }
    catch (e) { warnings.push(`AI clean-up failed (${e.message}); showing the basic conversion.`); }
  }
  if (!/^##\s*Experience/im.test(markdown)) warnings.push('No "Experience" heading was recognised. Add "## Experience" above your jobs so tailoring can find your bullets.');
  if ((markdown.match(/^- /gm) || []).length < 3) warnings.push('Few bullet points were recognised. Start each accomplishment with "- ".');
  return { markdown, pages, chars: text.length, tidied, warnings };
}
