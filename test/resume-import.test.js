import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linesToMarkdown, importResumePdf } from '../src/resume-import.js';
import { renderPdf } from '../src/render.js';

const L = (text, size = 10, x = 40) => ({ text, size, x, page: 1 });

test('linesToMarkdown rebuilds headings, roles, bullets and wrapped lines', () => {
  const md = linesToMarkdown([
    L('PRIYA NAIR', 22), L('Austin, TX | priya@example.com'),
    L('PROFESSIONAL SUMMARY'), L('Analyst who turns messy data into decisions for supply chain'), L('and finance teams.'),
    L('WORK EXPERIENCE'), L('Senior Data Analyst, Lone Star Logistics Mar 2022 – Present'),
    L('• Built a forecasting model in Python that reduced stockouts by 18% across 40'), L('warehouses', 10, 52),
    L('Automated monthly reporting with SQL and Tableau', 10, 52),
    L('SKILLS'), L('Python, SQL, Tableau'), L('Page 1 of 2'),
  ]);
  assert.match(md, /^# Priya Nair$/m);
  assert.match(md, /^## Summary\nAnalyst who turns messy data into decisions for supply chain and finance teams\.$/m);
  assert.match(md, /^### Senior Data Analyst, Lone Star Logistics \(Mar 2022 – Present\)$/m);
  assert.match(md, /^- Built a forecasting model in Python that reduced stockouts by 18% across 40 warehouses$/m);
  assert.match(md, /^- Automated monthly reporting with SQL and Tableau$/m, 'indented line under a role becomes a bullet');
  assert.match(md, /^## Skills\nPython, SQL, Tableau$/m);
  assert.doesNotMatch(md, /Page 1/);
});

test('importResumePdf round-trips a real PDF', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'applio-pdf-'));
  const src = readFileSync('test/fixtures/resume.md', 'utf8');
  const pdf = await renderPdf(src, join(dir, 'r.pdf'));
  const r = await importResumePdf(readFileSync(pdf));
  assert.equal(r.pages, 1);
  assert.deepEqual(r.warnings, []);
  for (const line of src.split('\n').filter(l => /^- /.test(l))) assert.ok(r.markdown.includes(line), `missing bullet: ${line}`);
  assert.match(r.markdown, /^## Experience$/m);
  assert.match(r.markdown, /^### Software Engineer II — Northwind \(2022 – present\)$/m);
});

test('importResumePdf rejects non-PDF uploads', async () => {
  await assert.rejects(importResumePdf(Buffer.from('hello')), /not a PDF/);
  await assert.rejects(importResumePdf(Buffer.alloc(0)), /empty/);
});
