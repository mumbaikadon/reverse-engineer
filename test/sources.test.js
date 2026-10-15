import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as greenhouse from '../src/sources/greenhouse.js';
import * as lever from '../src/sources/lever.js';
import * as ashby from '../src/sources/ashby.js';
import * as workday from '../src/sources/workday.js';
import { htmlToText } from '../src/util.js';

test('greenhouse normalize', () => {
  const j = greenhouse.normalize({ id: 42, title: ' Backend Engineer ', location: { name: 'Remote - US' }, absolute_url: 'https://x/jobs/42', content: '&lt;p&gt;Go &amp;amp; Postgres&lt;/p&gt;', first_published: '2026-10-01T00:00:00Z', departments: [{ name: 'Eng' }] }, { slug: 'acme', name: 'Acme' });
  assert.equal(j.id, 'greenhouse:acme:42');
  assert.equal(j.title, 'Backend Engineer');
  assert.equal(j.remote, true);
  assert.equal(j.applyUrl, 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=42');
  assert.equal(j.description, 'Go & Postgres');
});

test('lever normalize', () => {
  const j = lever.normalize({ id: 'abc', text: 'Platform Engineer', categories: { location: 'New York', team: 'Infra' }, workplaceType: 'hybrid', hostedUrl: 'h', applyUrl: 'a', descriptionPlain: 'About', lists: [{ text: 'You have', content: '<li>Go</li><li>K8s</li>' }], createdAt: 1786469891368 }, { slug: 'acme' });
  assert.equal(j.id, 'lever:acme:abc');
  assert.equal(j.remote, false);
  assert.match(j.description, /You have/);
  assert.match(j.description, /• Go/);
  assert.equal(j.postedAt, new Date(1786469891368).toISOString());
});

test('ashby normalize', () => {
  const j = ashby.normalize({ id: 'u1', title: 'SRE', location: 'NYC', secondaryLocations: [{ location: 'Remote (US)' }], isRemote: true, jobUrl: 'j', applyUrl: 'a', descriptionPlain: 'desc', compensation: { compensationTierSummary: '$1' } }, { slug: 'acme', name: 'Acme' });
  assert.equal(j.location, 'NYC / Remote (US)');
  assert.equal(j.remote, true);
  assert.equal(j.compensation, '$1');
});

test('workday normalize', () => {
  const j = workday.normalize({ title: 'Engineer', externalPath: '/job/US-CA/Engineer_JR1', locationsText: '2 Locations', bulletFields: ['JR1'] }, { location: 'US, CA, Santa Clara', jobDescription: '<p>Hi</p>' }, { host: 'acme.wd5.myworkdayjobs.com', tenant: 'acme', site: 'Ext' });
  assert.equal(j.id, 'workday:acme:JR1');
  assert.equal(j.url, 'https://acme.wd5.myworkdayjobs.com/Ext/job/US-CA/Engineer_JR1');
  assert.equal(j.location, 'US, CA, Santa Clara');
});

test('htmlToText keeps list structure', () => {
  assert.equal(htmlToText('<ul><li>One</li><li>Two</li></ul>'), '• One\n• Two');
});
