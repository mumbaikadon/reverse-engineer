// Generic application-form filler (Greenhouse, Lever, Ashby and most hosted forms).
// Reads the form's fields and labels from the live page, answers them, fills them,
// and only clicks submit when explicitly asked. CAPTCHAs and login walls are handed
// back to the human ("needs_input") — never bypassed.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchOptions } from '../render.js';

/** Runs in the page: index every fillable control and give it a stable data-applio-id. */
function extractFields() {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') || el.type === 'file'; };
  const clean = s => (s || '').replace(/\s+/g, ' ').replace(/[\s*✱]+$/, '').trim();
  // Text of an element without the text of any form controls nested inside it.
  const ownText = node => { const c = node.cloneNode(true); c.querySelectorAll('select, option, input, textarea, [role=listbox]').forEach(x => x.remove()); return c.innerText ?? c.textContent; };
  const labelOf = el => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(' ').map(id => document.getElementById(id)?.innerText).filter(Boolean).join(' '); if (t) return t; }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return ownText(l); }
    const wrap = el.closest('label'); if (wrap) return ownText(wrap);
    // Walk up a few levels looking for a label-ish element.
    let node = el;
    for (let i = 0; i < 5 && node; i++) {
      node = node.parentElement;
      const l = node?.querySelector(':scope > label, :scope > legend, :scope > .application-label, :scope > .text, :scope > [class*="label" i]');
      if (l && !l.contains(el)) return ownText(l);
    }
    return el.getAttribute('placeholder') || el.name || '';
  };
  const groupLabel = (container, el) => {
    const l = container.querySelector(':scope > legend, :scope > label, :scope > [class*="label" i]');
    if (l && !l.contains(el)) return ownText(l);
    let p = el.parentElement;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) { const x = p.querySelector(':scope > label, :scope > legend, :scope > [class*="label" i], :scope > .text'); if (x && !x.contains(el)) return ownText(x); }
    return el.name;
  };
  const optionLabel = el => clean(el.closest('label') ? ownText(el.closest('label')) : (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.value);
  const isRequired = el => el.required || el.getAttribute('aria-required') === 'true' || /[*✱]\s*$/.test(labelOf(el).trim());

  const root = document.querySelector('form#application-form, form#application_form, form.application-form, form[action*="apply" i], form') || document;
  const fields = [];
  const groups = new Map();
  let n = 0;
  const tag = el => { const id = `f${n++}`; el.setAttribute('data-applio-id', id); return id; };

  // Yes/No toggle buttons (Ashby): a pair of aria-pressed buttons next to a hidden checkbox.
  for (const box of root.querySelectorAll('div:has(> button[aria-pressed])')) {
    const buttons = [...box.querySelectorAll(':scope > button[aria-pressed]')];
    const hidden = box.querySelector('input');
    if (hidden) hidden.setAttribute('data-applio-skip', '1');
    const container = box.parentElement;
    fields.push({ id: tag(box), type: 'buttons', label: clean(groupLabel(container, box)), required: !!hidden?.required, options: buttons.map(b => b.innerText.trim()), members: buttons.map(tag) });
  }

  for (const el of root.querySelectorAll('input, textarea, select')) {
    const type = (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text')).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type) || el.disabled || el.hasAttribute('data-applio-skip')) continue;
    // Validation proxies (react-select's hidden "required" input, etc.)
    if (el.getAttribute('aria-hidden') === 'true' || (el.tabIndex === -1 && type !== 'file' && !el.id)) continue;
    if (!visible(el)) continue;

    if (type === 'radio' || type === 'checkbox') {
      const fs = el.closest('fieldset, [role=group], [role=radiogroup]');
      const siblings = fs ? fs.querySelectorAll(`input[type=${type}]`).length : (el.name ? root.querySelectorAll(`input[type=${type}][name="${CSS.escape(el.name)}"]`).length : 1);
      if (siblings > 1) {
        const key = fs || `${type}:${el.name}`;
        if (!groups.has(key)) {
          const g = { id: `g${n}`, type: type === 'radio' ? 'radio' : 'checkboxes', multiple: type === 'checkbox', label: clean(fs ? groupLabel(fs, el) : groupLabel(el.parentElement, el)), required: el.required || /[*✱]\s*$/.test(fs?.innerText.split('\n')[0] || ''), options: [], members: [] };
          groups.set(key, g); fields.push(g);
        }
        const g = groups.get(key); g.options.push(optionLabel(el)); g.members.push(tag(el));
        continue;
      }
    }
    const id = tag(el);
    const f = { id, type: el.getAttribute('role') === 'combobox' ? 'combobox' : type, label: clean(labelOf(el)), required: isRequired(el), name: el.name || '' };
    if (type === 'select') { f.options = [...el.options].map(o => o.text.trim()).filter(t => t && !/^(select|choose|--|please select)/i.test(t)); f.multiple = el.multiple; }
    fields.push(f);
  }
  return fields;
}

// Options of an autocomplete/react-select field, scoped to that field's own listbox.
async function listboxOptions(page, box) {
  const lb = (await box.getAttribute('aria-controls')) || (await box.getAttribute('aria-owns'));
  return lb ? page.locator(`[id="${lb}"] [role="option"]`)
    : box.locator('xpath=ancestor::*[.//*[@role="option"]][1]').locator('[role="option"]');
}

async function comboboxOptions(page, f) {
  const box = page.locator(`[data-applio-id="${f.id}"]`);
  try {
    await box.click({ timeout: 3000 });
    await page.waitForTimeout(400);
    const opts = await (await listboxOptions(page, box)).allInnerTexts();
    return opts.map(s => s.trim()).filter(Boolean).slice(0, 500);
  } catch { return []; }
  finally { await box.press('Escape').catch(() => {}); await box.blur().catch(() => {}); }
}

async function fillField(page, f, value) {
  const el = page.locator(`[data-applio-id="${f.id}"]`);
  switch (f.type) {
    case 'select':
      await el.selectOption({ label: String(value) }); return;
    case 'buttons': {
      const i = f.options.findIndex(o => o.toLowerCase() === String(value).toLowerCase());
      if (i >= 0) await page.locator(`[data-applio-id="${f.members[i]}"]`).click();
      return;
    }
    case 'radio': case 'checkboxes': {
      const wanted = String(value).split(' | ').map(s => s.trim().toLowerCase());
      for (const [i, opt] of f.options.entries()) if (wanted.includes(opt.toLowerCase())) await page.locator(`[data-applio-id="${f.members[i]}"]`).check({ force: true });
      return;
    }
    case 'checkbox':
      if (value === true || /^(yes|true|i agree|agree|acknowledge)/i.test(String(value))) await el.check({ force: true }); return;
    case 'combobox': {
      await el.click();
      await el.fill(String(value));
      await page.waitForTimeout(600); // async search fields (e.g. city) need a moment
      const opts = await listboxOptions(page, el);
      const exact = opts.filter({ hasText: new RegExp(`^\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') });
      const target = (await exact.count()) ? exact.first() : opts.first();
      if (await target.count()) await target.click({ timeout: 4000 });
      else await el.press('Enter');
      return;
    }
    default:
      await el.fill(String(value));
  }
}

const CAPTCHA = 'iframe[src*="recaptcha"][src*="anchor"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], .h-captcha, .cf-turnstile';
const SUCCESS = /thank you|thanks for applying|application (has been )?(received|submitted)|we.ve received your application|successfully submitted/i;

/**
 * @param {object} o
 * @param {object} o.job            row from the jobs table (apply_url, ats, …)
 * @param {(fields)=>Promise<Record<string,{value,source}>>} o.answer  answers keyed by field id
 * @param {{resume:string, coverLetter?:string}} o.files  local PDF paths
 * @param {boolean} [o.submit]      click submit after filling
 * @param {boolean} [o.headed]      show the browser
 * @param {string} o.outDir
 */
export async function fillApplication({ job, answer, files, submit = false, headed = false, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(launchOptions({ headless: !headed }));
  const receipt = { job: job.id, url: job.apply_url, startedAt: new Date().toISOString(), fields: [], submitted: false };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(job.apply_url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    // Lever/Ashby sometimes land on the posting; open the form if there is an "Apply" link.
    if (!(await page.locator('input[type=file], input[type=email]').count())) {
      const btn = page.getByRole('link', { name: /apply( for this job| now)?$/i }).or(page.getByRole('button', { name: /apply( for this job| now)?$/i })).first();
      if (await btn.count()) { await btn.click(); await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}); }
    }
    if (await page.getByText(/sign in|create account|log in to apply/i).first().isVisible().catch(() => false) && !(await page.locator('input[type=email]').count())) {
      return { status: 'needs_input', note: 'Application requires an account sign-in on this portal', receipt };
    }

    const fields = await page.evaluate(extractFields);
    for (const f of fields) if (f.type === 'combobox') f.options = await comboboxOptions(page, f);
    if (!fields.length) return { status: 'needs_input', note: 'No application form found on the page', receipt };

    const answers = await answer(fields.filter(f => f.type !== 'file'));
    const missing = [];
    for (const f of fields) {
      let value, source;
      if (f.type === 'file') {
        const isCover = /cover/i.test(f.label + f.name);
        value = isCover ? files.coverLetter : (/resume|résumé|\bcv\b/i.test(f.label + f.name) || !isCover ? files.resume : null);
        source = 'file';
        if (value) await page.locator(`[data-applio-id="${f.id}"]`).setInputFiles(value).catch(e => { source = `error: ${e.message.split('\n')[0]}`; });
      } else {
        ({ value, source } = answers[f.id] || { value: '', source: 'missing' });
        if (value !== '' && value != null && value !== false) {
          try { await fillField(page, f, value); } catch (e) { source = `error: ${e.message.split('\n')[0]}`; }
        }
      }
      const empty = value === '' || value == null || String(source).startsWith('error');
      if (f.required && empty) missing.push(f.label || f.name || f.id);
      receipt.fields.push({ label: f.label, type: f.type, required: f.required, value: f.type === 'file' ? value?.split('/').pop() : value, source });
    }
    await page.screenshot({ path: join(outDir, 'filled.png'), fullPage: true });

    const captcha = await page.locator(CAPTCHA).first().isVisible().catch(() => false);
    let status = 'filled', note = '';
    if (missing.length) { status = 'needs_input'; note = `Required fields without an answer: ${missing.join('; ')}`; }
    else if (submit) {
      if (captcha) { status = 'needs_input'; note = 'Form shows a CAPTCHA; finish it yourself with --headed'; }
      else {
        const btn = page.locator('button[type=submit], input[type=submit]').or(page.getByRole('button', { name: /submit( application)?|send application/i })).last();
        await btn.click();
        const ok = await page.waitForFunction(re => new RegExp(re, 'i').test(document.body.innerText), SUCCESS.source, { timeout: 25_000 }).then(() => true).catch(() => false);
        await page.screenshot({ path: join(outDir, 'after-submit.png'), fullPage: true });
        if (ok) { status = 'submitted'; receipt.submitted = true; }
        else { status = 'needs_input'; note = (await page.locator(CAPTCHA).first().isVisible().catch(() => false)) ? 'CAPTCHA appeared on submit' : 'No confirmation seen after submit; check after-submit.png'; }
      }
    }
    if (headed && status === 'needs_input') {
      console.log(`  ${note}\n  The browser is open — finish the form there, then press Enter here.`);
      await new Promise(r => process.stdin.once('data', r));
    }
    return { status, note, receipt };
  } finally {
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(join(outDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
    await browser.close();
  }
}
