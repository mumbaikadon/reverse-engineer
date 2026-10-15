// First-run setup wizard: résumé → profile → companies → AI (optional) → scan.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-applio': '1', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};
const send = (method, path, body) => api(path, { method, body: JSON.stringify(body) });

const STEPS = [['resume', 'Résumé'], ['profile', 'About you'], ['companies', 'Companies'], ['ai', 'AI (optional)'], ['done', 'Start']];
let hooks = { toast: () => {}, onChange: () => {}, startScan: async () => {} };
export function initOnboarding(h) { hooks = { ...hooks, ...h }; }

/** First step that still needs doing. */
export function nextStep(setup) {
  if (!setup.resume) return 'resume';
  if (!setup.profile) return 'profile';
  if (!setup.companies) return 'companies';
  return 'ai';
}

export async function showOnboarding(step) {
  const cfg = await api('/api/config');
  if (!STEPS.some(([k]) => k === step)) step = nextStep(cfg.exists);
  // Don't let people skip ahead past an unfinished required step.
  const order = STEPS.map(([k]) => k);
  const firstMissing = order.indexOf(nextStep(cfg.exists));
  if (order.indexOf(step) > firstMissing && firstMissing < 3) step = order[firstMissing];

  const root = $('#welcome');
  const idx = order.indexOf(step);
  root.innerHTML = `
    <div class="wz">
      <div class="wz__intro">
        <h1>${idx === 0 ? 'Welcome to applio' : 'Setting up applio'}</h1>
        <p class="muted">${idx === 0 ? 'Let’s set you up in a few minutes. Everything stays on this computer.' : `Step ${idx + 1} of ${STEPS.length}`}</p>
      </div>
      <ol class="wz__steps">${STEPS.map(([k, l], i) => {
        const done = i < idx || (k === 'resume' && cfg.exists.resume) || (k === 'profile' && cfg.exists.profile) || (k === 'companies' && cfg.exists.companies);
        const reachable = i <= Math.max(idx, firstMissing === -1 ? 4 : firstMissing);
        return `<li class="${k === step ? 'is-current' : ''} ${done && k !== step ? 'is-done' : ''}">${reachable ? `<a href="#/welcome/${k}">` : '<span>'}<b>${done && k !== step ? '✓' : i + 1}</b>${l}${reachable ? '</a>' : '</span>'}</li>`;
      }).join('')}</ol>
      <div class="card wz__body" id="wzBody"></div>
    </div>`;
  ({ resume: stepResume, profile: stepProfile, companies: stepCompanies, ai: stepAI, done: stepDone })[step]($('#wzBody'), cfg);
}
const go = step => { location.hash = `#/welcome/${step}`; };

// ---- 1. Résumé ----------------------------------------------------------
function stepResume(el, cfg) {
  let markdown = cfg.resume;
  el.innerHTML = `
    <h2>Upload your résumé</h2>
    <p class="muted">A PDF works best. applio reads it to fill in your profile and to tailor applications later. The original file is kept, so employers can receive it exactly as you designed it.</p>
    <label class="drop" id="drop">
      <input type="file" accept="application/pdf,.pdf" id="wzPdf" hidden>
      <span class="drop__icon" aria-hidden="true">⇪</span>
      <b>Drop your PDF here</b><span class="muted">or click to choose a file</span>
    </label>
    <p class="small"><button type="button" class="linkbtn" id="pasteToggle">No PDF? Paste the text instead</button></p>
    <div id="wzMsg"></div>
    <div id="wzReview" ${markdown ? '' : 'hidden'}>
      <details ${cfg.exists.resume ? '' : 'open'}><summary><b>Check what applio read</b> <span class="muted small">— fix anything that came out wrong</span></summary>
        <textarea id="wzText" class="code" rows="18" spellcheck="true" aria-label="Résumé text"></textarea>
        <p class="muted small">Headings: <span class="mono"># Name</span>, <span class="mono">## Experience</span>, <span class="mono">### Job — Company (dates)</span>, bullets start with <span class="mono">- </span>.</p>
      </details>
    </div>
    <div class="wz__nav"><span></span><button class="btn btn--primary" id="wzNext" ${markdown ? '' : 'disabled'}>Continue</button></div>`;

  const ta = $('#wzText', el), review = $('#wzReview', el), next = $('#wzNext', el), msg = $('#wzMsg', el);
  ta.value = markdown;
  ta.oninput = () => { markdown = ta.value; next.disabled = !markdown.trim(); };

  const upload = async file => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { msg.innerHTML = '<p class="note">Please choose a PDF file.</p>'; return; }
    $('#drop', el).classList.add('is-busy');
    msg.innerHTML = `<p class="muted"><span class="spin"></span> Reading ${esc(file.name)}…</p>`;
    try {
      const res = await fetch(`/api/config/resume/import${cfg.llm ? '?tidy=1' : ''}`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-applio': '1' }, body: file });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
      markdown = ta.value = r.markdown;
      review.hidden = false; $('details', review).open = true; next.disabled = false;
      msg.innerHTML = `<div class="import-ok">✓ Read ${esc(file.name)} (${r.pages} page${r.pages === 1 ? '' : 's'}). Have a quick look below, then continue.</div>`
        + r.warnings.map(w => `<p class="note">${esc(w)}</p>`).join('');
    } catch (err) { msg.innerHTML = `<p class="note">${esc(err.message)}</p>`; }
    finally { $('#drop', el).classList.remove('is-busy'); }
  };
  $('#wzPdf', el).onchange = e => upload(e.target.files[0]);
  const drop = $('#drop', el);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('is-over'); };
  drop.ondragleave = () => drop.classList.remove('is-over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('is-over'); upload(e.dataTransfer.files[0]); };
  $('#pasteToggle', el).onclick = () => { review.hidden = false; $('details', review).open = true; ta.focus(); };

  next.onclick = async () => {
    next.disabled = true;
    try { await send('PUT', '/api/config/resume', { markdown }); hooks.onChange(); go('profile'); }
    catch (e) { hooks.toast(e.message, true); next.disabled = false; }
  };
}

// ---- 2. Profile ---------------------------------------------------------
function tagInput(box, initial, placeholder) {
  let list = [...initial];
  const render = () => {
    box.innerHTML = list.map((t, i) => `<span class="tag">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('') + `<input placeholder="${esc(placeholder)}">`;
    box.querySelectorAll('button').forEach(b => b.onclick = () => { list.splice(Number(b.dataset.i), 1); render(); box.querySelector('input').focus(); });
    const input = box.querySelector('input');
    const add = () => { const v = input.value.split(',').map(s => s.trim()).filter(Boolean); if (v.length) { list = [...new Set([...list, ...v])]; render(); box.querySelector('input').focus(); } };
    input.onkeydown = e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } else if (e.key === 'Backspace' && !input.value && list.length) { list.pop(); render(); box.querySelector('input').focus(); } };
    input.onblur = () => { if (input.value.trim()) add(); };
  };
  box.onclick = e => { if (e.target === box) box.querySelector('input').focus(); };
  render();
  return () => { const extra = box.querySelector('input').value.trim(); return extra ? [...new Set([...list, ...extra.split(',').map(s => s.trim()).filter(Boolean)])] : list; };
}

async function stepProfile(el, cfg) {
  const p = cfg.exists.profile ? cfg.profile : await api('/api/config/profile/draft');
  p.preferences ??= {}; p.links ??= {}; p.workAuthorization ??= {};
  const SENIORITY = ['junior', 'mid', 'senior', 'staff', 'manager'];
  el.innerHTML = `
    <h2>About you</h2>
    <p class="muted">${cfg.exists.profile ? 'Your saved details.' : 'Filled in from your résumé.'} Check them; they’re used to fill in application forms and to score jobs. You can change everything later in Settings.</p>
    <form id="wzProfile" novalidate>
      <div class="grid">
        <div class="field"><label for="w-name">Full name *</label><input id="w-name" value="${esc(p.name)}" required></div>
        <div class="field"><label for="w-email">Email *</label><input id="w-email" type="email" value="${esc(p.email)}" required></div>
        <div class="field"><label for="w-phone">Phone</label><input id="w-phone" type="tel" value="${esc(p.phone)}"></div>
        <div class="field"><label for="w-loc">Where you live</label><input id="w-loc" value="${esc(p.location)}" placeholder="City, region, country"></div>
        <div class="field"><label for="w-li">LinkedIn</label><input id="w-li" type="url" value="${esc(p.links.linkedin)}" placeholder="https://linkedin.com/in/…"></div>
        <div class="field"><label for="w-site">Website or GitHub</label><input id="w-site" type="url" value="${esc(p.links.website || p.links.github)}"></div>
      </div>
      <h3 class="wz__h3">What are you looking for?</h3>
      <div class="grid">
        <div class="field field--wide"><label>Job titles to look for</label><div class="tags" id="w-titles"></div><span class="muted small">Type a title and press Enter.</span></div>
        <div class="field field--wide"><label>Your main skills</label><div class="tags" id="w-skills"></div></div>
        <div class="field field--wide"><label>Locations you’d work in</label><div class="tags" id="w-locs"></div></div>
        <div class="field field--wide"><span class="label">Level</span><div class="multi" id="w-sen">${SENIORITY.map(x => `<label class="check"><input type="checkbox" value="${x}" ${(p.preferences.seniority || []).includes(x) ? 'checked' : ''}> ${x}</label>`).join('')}</div></div>
        <label class="check"><input type="checkbox" id="w-remote" ${p.preferences.remoteOk !== false ? 'checked' : ''}> Remote jobs are fine</label>
        <label class="check"><input type="checkbox" id="w-auth" ${p.workAuthorization.authorized !== false ? 'checked' : ''}> I’m authorized to work where I’m applying</label>
        <label class="check"><input type="checkbox" id="w-spon" ${p.workAuthorization.needsSponsorship ? 'checked' : ''}> I need visa sponsorship</label>
      </div>
      <div class="wz__nav"><a class="btn" href="#/welcome/resume">← Back</a><button class="btn btn--primary" id="wzNext">Continue</button></div>
    </form>`;
  const titles = tagInput($('#w-titles', el), p.preferences.titles || [], 'e.g. backend engineer');
  const skills = tagInput($('#w-skills', el), p.preferences.skills || [], 'e.g. python');
  const locs = tagInput($('#w-locs', el), p.preferences.locations || [], 'e.g. new york');

  $('#wzProfile', el).onsubmit = async e => {
    e.preventDefault();
    const v = id => $(id, el).value.trim();
    const name = v('#w-name');
    const [first, ...rest] = name.split(/\s+/);
    const site = v('#w-site');
    const profile = {
      ...p, name, email: v('#w-email'), phone: v('#w-phone') || undefined, location: v('#w-loc') || undefined,
      firstName: first, lastName: rest.join(' ') || undefined,
      links: { ...p.links, linkedin: v('#w-li') || undefined, ...(/github\.com/i.test(site) ? { github: site } : { website: site || undefined }) },
      workAuthorization: { authorized: $('#w-auth', el).checked, needsSponsorship: $('#w-spon', el).checked },
      preferences: {
        ...p.preferences, titles: titles(), skills: skills(), locations: locs(),
        titleKeywords: p.preferences.titleKeywords?.length ? p.preferences.titleKeywords : [...new Set(titles().flatMap(t => t.split(/\s+/)).filter(w => w.length > 2))],
        seniority: [...el.querySelectorAll('#w-sen input:checked')].map(i => i.value),
        remoteOk: $('#w-remote', el).checked, needsSponsorship: $('#w-spon', el).checked,
      },
    };
    if (!profile.preferences.titles.length) return hooks.toast('Add at least one job title to look for.', true);
    const btn = $('#wzNext', el); btn.disabled = true;
    try { await send('PUT', '/api/config/profile', { profile: JSON.parse(JSON.stringify(profile)) }); hooks.onChange(); go('companies'); }
    catch (err) { hooks.toast(err.message, true); btn.disabled = false; }
  };
}

// ---- 3. Companies -------------------------------------------------------
const ATS = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday' };
const keyOf = c => `${c.ats}:${c.slug || c.host + '/' + c.site}`.toLowerCase();

async function stepCompanies(el, cfg) {
  const suggested = await api('/api/config/suggested-companies');
  const chosen = new Map(cfg.companies.map(c => [keyOf(c), c]));
  const all = [...cfg.companies, ...suggested.filter(c => !chosen.has(keyOf(c)))];
  el.innerHTML = `
    <h2>Which companies should applio watch?</h2>
    <p class="muted">applio checks these companies’ job boards for new roles. Pick some to start with and add any others you want; you can change the list any time.</p>
    <form class="detect" id="wzFind">
      <input id="wzFindIn" placeholder="Add a company: paste its careers page link, or type its name" aria-label="Careers link or company name">
      <button class="btn">Find</button>
    </form>
    <div id="wzFound"></div>
    <div class="picks" id="wzPicks"></div>
    <div class="wz__nav"><a class="btn" href="#/welcome/profile">← Back</a><span class="muted small" id="wzCount"></span><button class="btn btn--primary" id="wzNext">Continue</button></div>`;

  const render = () => {
    $('#wzPicks', el).innerHTML = all.map(c => `<label class="pick ${chosen.has(keyOf(c)) ? 'is-on' : ''}"><input type="checkbox" data-k="${esc(keyOf(c))}" ${chosen.has(keyOf(c)) ? 'checked' : ''}><b>${esc(c.name || c.slug)}</b><span class="muted small">${ATS[c.ats]}</span></label>`).join('');
    el.querySelectorAll('.pick input').forEach(i => i.onchange = () => {
      const c = all.find(x => keyOf(x) === i.dataset.k);
      i.checked ? chosen.set(i.dataset.k, c) : chosen.delete(i.dataset.k);
      i.closest('.pick').classList.toggle('is-on', i.checked); count();
    });
    count();
  };
  const count = () => { $('#wzCount', el).textContent = `${chosen.size} selected`; $('#wzNext', el).disabled = !chosen.size; };
  render();

  $('#wzFind', el).onsubmit = async e => {
    e.preventDefault();
    const input = $('#wzFindIn', el), out = $('#wzFound', el);
    if (!input.value.trim()) return;
    out.innerHTML = '<p class="muted small"><span class="spin"></span> Looking for their job board…</p>';
    try {
      const r = await send('POST', '/api/config/detect', { input: input.value });
      if (!r.found.length) { out.innerHTML = '<p class="note">Couldn’t find a public job board for that. Try pasting the link of one of their job postings.</p>'; return; }
      const f = r.found[0];
      if (!all.some(c => keyOf(c) === keyOf(f.entry))) all.unshift(f.entry);
      chosen.set(keyOf(f.entry), all.find(c => keyOf(c) === keyOf(f.entry)));
      out.innerHTML = `<div class="import-ok small">✓ Added ${esc(f.entry.name)} (${ATS[f.entry.ats]}, ${f.jobs} open roles)</div>`;
      input.value = ''; render();
    } catch (err) { out.innerHTML = `<p class="note">${esc(err.message)}</p>`; }
  };
  $('#wzNext', el).onclick = async () => {
    const btn = $('#wzNext', el); btn.disabled = true;
    try { await send('PUT', '/api/config/companies', { companies: [...chosen.values()] }); hooks.onChange(); go('ai'); }
    catch (err) { hooks.toast(err.message, true); btn.disabled = false; }
  };
}

// ---- 4. AI (optional) ---------------------------------------------------
async function stepAI(el) {
  const st = await api('/api/integrations');
  const active = st.active;
  el.innerHTML = `
    <h2>Connect an AI provider <span class="muted small">(optional)</span></h2>
    <p class="muted">With Claude or OpenAI, applio rewrites your résumé and a cover letter for each job and answers written application questions in your voice. Without one, it still finds and scores jobs and fills in forms from your details. You pay the provider for what you use.</p>
    ${active ? `<div class="import-ok">✓ Connected to ${esc(active.label)} (<span class="mono">${esc(active.model)}</span>).</div>` : `
    <div class="provider-pick" role="radiogroup">
      <label class="check"><input type="radio" name="wzProv" value="claude" checked> Claude <span class="muted small">(Anthropic)</span></label>
      <label class="check"><input type="radio" name="wzProv" value="openai"> OpenAI</label>
    </div>
    <div class="grid">
      <div class="field"><label for="wzKey">API key</label><input id="wzKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…"></div>
      <div class="field"><label for="wzModel">Model</label><select id="wzModel" disabled><option>Connect to see models</option></select></div>
    </div>
    <p class="small"><span id="wzKeyHelp"><a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Get a Claude API key</a></span> · <span id="wzAIMsg" class="muted"></span></p>
    <button class="btn" id="wzConnect">Connect</button>`}
    <div class="wz__nav"><a class="btn" href="#/welcome/companies">← Back</a><span></span><button class="btn ${active ? 'btn--primary' : ''}" id="wzNext">${active ? 'Continue' : 'Skip for now'}</button></div>`;
  $('#wzNext', el).onclick = () => go('done');
  if (active) return;

  const prov = () => el.querySelector('input[name=wzProv]:checked').value;
  el.querySelectorAll('input[name=wzProv]').forEach(r => r.onchange = () => {
    $('#wzKey', el).placeholder = prov() === 'claude' ? 'sk-ant-…' : 'sk-…';
    $('#wzKeyHelp', el).innerHTML = prov() === 'claude' ? '<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Get a Claude API key</a>' : '<a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">Get an OpenAI API key</a>';
    $('#wzModel', el).innerHTML = '<option>Connect to see models</option>'; $('#wzModel', el).disabled = true; $('#wzConnect', el).textContent = 'Connect';
  });
  $('#wzConnect', el).onclick = async () => {
    const btn = $('#wzConnect', el), msg = $('#wzAIMsg', el), key = $('#wzKey', el).value.trim(), model = $('#wzModel', el);
    if (!key) return hooks.toast('Paste your API key first.', true);
    btn.disabled = true;
    try {
      if (model.disabled) {
        msg.innerHTML = '<span class="spin"></span> Checking the key…';
        const r = await send('POST', '/api/integrations/test', { provider: prov(), apiKey: key });
        const preferred = prov() === 'claude' ? st.claude.defaultModel : null;
        model.innerHTML = r.models.map(m => `<option ${m === preferred ? 'selected' : ''}>${esc(m)}</option>`).join('');
        model.disabled = false; btn.textContent = 'Save'; msg.className = 'ok'; msg.textContent = `✓ Key works. Pick a model and press Save.`;
      } else {
        await send('PUT', '/api/integrations', { provider: prov(), [prov()]: { apiKey: key, model: model.value } });
        hooks.onChange(); hooks.toast(`Connected to ${prov() === 'claude' ? 'Claude' : 'OpenAI'}.`); go('done');
      }
    } catch (e) { msg.className = 'bad'; msg.textContent = '✕ ' + e.message; }
    finally { btn.disabled = false; }
  };
}

// ---- 5. Done ------------------------------------------------------------
async function stepDone(el, cfg) {
  const st = await api('/api/integrations');
  el.innerHTML = `
    <h2>You’re all set</h2>
    <ul class="wz__summary">
      <li>✓ Résumé saved${cfg.originalPdf ? ' (with your original PDF)' : ''}</li>
      <li>✓ Looking for: ${esc((cfg.profile.preferences?.titles || []).join(', ') || '—')}</li>
      <li>✓ Watching ${cfg.companies.length} compan${cfg.companies.length === 1 ? 'y' : 'ies'}</li>
      <li>${st.active ? `✓ AI: ${esc(st.active.label)}` : '○ No AI provider; you can add one later in Settings → Integrations'}</li>
    </ul>
    <p class="muted">Next, applio pulls every open role from those companies and scores each one against your profile. It doesn’t apply anywhere until you review a job and press Submit.</p>
    <div class="wz__nav"><a class="btn" href="#/welcome/ai">← Back</a><span></span><button class="btn btn--primary btn--lg" id="wzScan">Find jobs now</button></div>`;
  $('#wzScan', el).onclick = async () => {
    $('#wzScan', el).disabled = true;
    try { await hooks.startScan(); location.hash = '#/'; }
    catch (e) { hooks.toast(e.message, true); $('#wzScan', el).disabled = false; }
  };
}
