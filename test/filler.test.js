import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fillApplication } from '../src/apply/filler.js';
import { answerQuestions } from '../src/answers.js';
import { renderPdf } from '../src/render.js';

const profile = { name: 'Jordan Reyes', email: 'j@x.io', phone: '+1 555', links: { linkedin: 'https://linkedin.com/in/x' }, workAuthorization: { authorized: true, needsSponsorship: false } };
const job = { id: 'fixture', apply_url: pathToFileURL(resolve('test/fixtures/form.html')).href };

test('fills the fixture form, stops on missing required answer, submits when complete', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'applio-'));
  const resumePdf = await renderPdf('# Jordan Reyes\n- Did things', join(dir, 'r.pdf'));
  const answer = extra => async fields => {
    const a = await answerQuestions({ questions: fields, job: { company: 'A', title: 'B' }, profile, resume: '' });
    for (const f of fields) if (/why/i.test(f.label) && extra) a[f.id] = { value: extra, source: 'test' };
    return a;
  };
  const first = await fillApplication({ job, files: { resume: resumePdf }, submit: true, outDir: join(dir, '1'), answer: answer(null) });
  assert.equal(first.status, 'needs_input');
  assert.match(first.note, /Why do you want to work here/);
  assert.equal(first.receipt.submitted, false);

  const second = await fillApplication({ job, files: { resume: resumePdf }, submit: true, outDir: join(dir, '2'), answer: answer('Because.') });
  assert.equal(second.status, 'submitted');
  const byLabel = Object.fromEntries(second.receipt.fields.map(f => [f.label, f.value]));
  assert.equal(byLabel['First Name'], 'Jordan');
  assert.equal(byLabel['Will you now or in the future require visa sponsorship?'], 'No');
  assert.equal(byLabel['Gender'], 'Decline to self-identify');
  assert.equal(byLabel['Resume/CV'], 'r.pdf');
});
