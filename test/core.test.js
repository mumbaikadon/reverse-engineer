import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, seniorityOf } from '../src/match.js';
import { vetEdits, applyEdits } from '../src/tailor.js';
import { fromProfile } from '../src/answers.js';
import { markdownToHtml } from '../src/render.js';
import { open } from '../src/db.js';

const prefs = { titles: ['backend engineer'], titleKeywords: ['engineer'], excludeTitleKeywords: ['intern'], skills: ['go', 'postgres', 'kafka'], locations: ['new york'], remoteOk: true, seniority: ['mid', 'senior'] };

test('seniority picks the most specific level', () => {
  assert.equal(seniorityOf('Senior Staff Software Engineer'), 'staff');
  assert.equal(seniorityOf('Sr. Backend Engineer'), 'senior');
  assert.equal(seniorityOf('Software Engineer II'), 'mid');
  assert.equal(seniorityOf('Engineering Manager, Platform'), 'manager');
});

test('score: strong match vs excluded vs weak', () => {
  const strong = score({ title: 'Backend Engineer', description: 'We use Go, Postgres and Kafka.', location: 'New York, NY' }, prefs);
  assert.ok(strong.score >= 90, strong.score);
  assert.equal(score({ title: 'Backend Engineer Intern', description: '', location: 'New York' }, prefs).excluded, true);
  const weak = score({ title: 'Account Executive', description: 'go to market', location: 'Houston, TX' }, prefs);
  assert.ok(weak.score < 30, weak.score);
  assert.ok(!weak.reasons.some(r => r.startsWith('skills')), 'lowercase "go" in prose is not the Go language');
});

test('score: sponsorship red flag caps the score', () => {
  const r = score({ title: 'Backend Engineer', description: 'Go Postgres Kafka. We are unable to sponsor visas.', location: 'New York' }, { ...prefs, needsSponsorship: true });
  assert.ok(r.score <= 15);
});

const RESUME = `# Jordan\n\n## Summary\nOld summary.\n\n## Experience\n- Maintained Go services on Kubernetes.\n- Cut deploy time from 25 to 6 minutes.\n\n## Skills\nPython, Go, Kafka\n`;

test('vetEdits rejects invented numbers and unknown bullets', () => {
  const { accepted, rejected } = vetEdits(RESUME, [
    { original: 'Maintained Go services on Kubernetes.', rewritten: 'Ran Go services on Kubernetes.', reason: '' },
    { original: 'Maintained Go services on Kubernetes.', rewritten: 'Ran 40 Go services serving 4M users.', reason: '' },
    { original: 'Did something else.', rewritten: 'x', reason: '' },
    { original: 'Cut deploy time from 25 to 6 minutes.', rewritten: 'Reduced deploys from 25 to 6 minutes.', reason: '' },
  ]);
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].why, /40/);
});

test('applyEdits rewrites bullets, summary and skill order', () => {
  const out = applyEdits(RESUME, { summary: 'New summary.', accepted: [{ original: 'Maintained Go services on Kubernetes.', rewritten: 'Ran Go services on Kubernetes.' }], skillsOrder: ['Kafka', 'Go', 'Rust'] });
  assert.match(out, /Ran Go services/);
  assert.match(out, /## Summary\nNew summary\./);
  assert.match(out, /## Skills\nKafka, Go, Python/);
  assert.doesNotMatch(out, /Rust/);
});

test('fromProfile maps common questions', () => {
  const p = { name: 'Jordan Reyes', email: 'j@x.io', country: 'United States', workAuthorization: { authorized: true, needsSponsorship: true }, yearsExperience: 5, answers: [{ match: 'security clearance', answer: 'No' }] };
  assert.equal(fromProfile({ label: 'First Name' }, p), 'Jordan');
  assert.equal(fromProfile({ label: 'Full name' }, p), 'Jordan Reyes');
  assert.equal(fromProfile({ label: 'Will you require visa sponsorship?', options: ['Yes', 'No'] }, p), 'Yes');
  assert.equal(fromProfile({ label: 'Country', options: ['United Kingdom +44', 'United States +1'] }, p), 'United States +1');
  assert.equal(fromProfile({ label: 'How many years of relevant experience do you have?', options: ['0-2', '3-4', '5-7', '7+'] }, p), '5-7');
  assert.equal(fromProfile({ label: 'Do you hold an active security clearance?', options: ['Yes', 'No'] }, p), 'No');
  assert.equal(fromProfile({ label: 'Gender', options: ['Male', 'Female', 'Decline to self-identify'] }, p), 'Decline to self-identify');
  assert.equal(fromProfile({ label: 'Why do you want to work here?' }, p), undefined);
});

test('markdownToHtml', () => {
  const html = markdownToHtml('# Name\n## Skills\n- **Go**\n- Python');
  assert.match(html, /<h1>Name<\/h1>/);
  assert.match(html, /<ul>\n<li><strong>Go<\/strong><\/li>\n<li>Python<\/li>\n<\/ul>/);
});

test('db: save, close missing, status history', () => {
  const db = open(':memory:');
  const job = { id: 'greenhouse:a:1', ats: 'greenhouse', board: 'a', externalId: '1', company: 'A', title: 'T', location: 'L', remote: false, url: 'u', applyUrl: 'u', description: 'd' };
  assert.equal(db.saveJobs([job]).length, 1);
  assert.equal(db.saveJobs([job]).length, 0);
  db.setApp(job.id, { status: 'matched', score: 80 });
  db.setApp(job.id, { status: 'approved' });
  assert.equal(db.app(job.id).score, 80);
  assert.deepEqual(db.events(job.id).map(e => e.detail), ['— → matched', 'matched → approved']);
  assert.equal(db.closeMissing(['a'], []), 1);
  assert.equal(db.openJobs().length, 0);
  assert.equal(db.resolve('a:1'), job.id);
});
