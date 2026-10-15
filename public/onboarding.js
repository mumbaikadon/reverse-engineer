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

const STEPS = [['resume', 'Your résumé'], ['companies', 'Companies'], ['ai', 'AI (optional)'], ['done', 'Start']];
let hooks = { toast: () => {}, onChange: () => {}, startScan: async () => {} };
export function initOnboarding(h) { hooks = { ...hooks, ...h }; }

/** First step that still needs doing. */
export function nextStep(setup) {
  if (!setup.resume || !setup.profile) return 'resume';
  if (!setup.companies) return 'companies';
  return 'ai';
}

export async function showOnboarding(step) {
  const cfg = await api('/api/config');
  if (!STEPS.some(([k]) => k === step)) step = nextStep(cfg.exists);
  // Don't let people skip ahead past an unfinished required step.
  const order = STEPS.map(([k]) => k);
  const ready = cfg.exists.resume && cfg.exists.profile;
  if (!ready) step = 'resume';

  const root = $('#welcome');
  const idx = order.indexOf(step);
  root.innerHTML = `
    <div class="wz">
      <div class="wz__intro">
        <h1>${idx === 0 ? 'Welcome to applio' : 'Setting up applio'}</h1>
        <p class="muted">${idx === 0 ? 'Upload your résumé and applio does the rest. Everything stays on this computer.' : `Step ${idx + 1} of ${STEPS.length}`}</p>
      </div>
      <ol class="wz__steps">${STEPS.map(([k, l], i) => {
        const done = i < idx || (k === 'resume' && cfg.exists.resume && cfg.exists.profile) || (k === 'companies' && cfg.exists.companies);
        const reachable = ready || i === 0;
        return `<li class="${k === step ? 'is-current' : ''} ${done && k !== step ? 'is-done' : ''}">${reachable ? `<a href="#/welcome/${k}">` : '<span>'}<b>${done && k !== step ? '✓' : i + 1}</b>${l}${reachable ? '</a>' : '</span>'}</li>`;
      }).join('')}</ol>
      <div class="card wz__body" id="wzBody"></div>
    </div>`;
  ({ resume: stepResume, companies: stepCompanies, ai: stepAI, done: stepDone })[step]($('#wzBody'), cfg);
}
const go = step => { location.hash = `#/welcome/${step}`; };

// ---- 1. Résumé → profile, automatically -------------------------------
function summaryHTML(p, r) {
  const pr = p.preferences || {}, L = p.links || {};
  const row = (k, v) => v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : '';
  const chips = l => (l || []).map(x => `<span class="chip-s">${esc(x)}</span>`).join(' ');
  return `<dl class="found-profile">
    ${row('Name', esc(p.name))}${row('Email', esc(p.email))}${row('Phone', esc(p.phone))}${row('Location', esc(p.location))}
    ${row('Links', [L.linkedin, L.github, L.website].filter(Boolean).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, ''))}</a>`).join(' · '))}
    ${row('Current role', [p.currentTitle, p.currentCompany].filter(Boolean).map(esc).join(' at '))}
    ${row('Experience', p.yearsExperience ? `${p.yearsExperience} years` : '')}
    ${row('Looking for', chips(pr.titles))}${row('Level', chips(pr.seniority))}${row('Where', chips(pr.locations) + (pr.remoteOk !== false ? ' <span class="chip-s">remote</span>' : ''))}
    ${row('Skills', chips(pr.skills))}
  </dl>
  <p class="muted small">${r.source === 'ai' ? `Read by ${esc(r.provider)}.` : 'Read by the built-in parser. Connect Claude or OpenAI in the next steps for a more thorough reading.'} Anything wrong? You can change it later in Settings → Profile.</p>`;
}

function stepResume(el, cfg) {
  el.innerHTML = `
    <h2>Upload your résumé</h2>
    <p class="muted">That’s all applio needs. It reads your contact details, experience, skills and the kind of roles to look for from it${cfg.llm ? ` using ${esc(cfg.llm.label)}` : ''}. Your original PDF is kept, so employers can receive it exactly as you designed it.</p>
    <label class="drop" id="drop">
      <input type="file" accept="application/pdf,.pdf" id="wzPdf" hidden>
      <span class="drop__icon" aria-hidden="true">⇪</span>
      <b>${cfg.exists.resume ? 'Drop a new PDF to replace your résumé' : 'Drop your résumé PDF here'}</b><span class="muted">or click to choose a file</span>
    </label>
    <p class="small"><button type="button" class="linkbtn" id="pasteToggle">No PDF? Paste the text instead</button></p>
    <div id="pasteBox" hidden><textarea id="wzText" class="code" rows="12" placeholder="Paste your résumé text here"></textarea><button type="button" class="btn" id="pasteGo">Read this text</button></div>
    <div id="wzMsg"></div>
    <div id="wzFound">${cfg.exists.profile ? summaryHTML(cfg.profile, { source: 'saved' }).replace(/<p class="muted small">[\s\S]*<\/p>$/, '<p class="muted small">Change anything later in Settings → Profile.</p>') : ''}</div>
    <div class="wz__nav"><span></span><button class="btn btn--primary" id="wzNext" ${cfg.exists.resume && cfg.exists.profile ? '' : 'disabled'}>Continue</button></div>`;

  const msg = $('#wzMsg', el), found = $('#wzFound', el), next = $('#wzNext', el), drop = $('#drop', el);
  const handle = async (bodyInit, label, contentType) => {
    drop.classList.add('is-busy'); next.disabled = true; found.innerHTML = '';
    msg.innerHTML = `<p class="muted"><span class="spin"></span> Reading ${esc(label)}${cfg.llm ? ` with ${esc(cfg.llm.label)}` : ''}…</p>`;
    try {
      const res = await fetch('/api/setup/resume', { method: 'POST', headers: { 'content-type': contentType, 'x-applio': '1' }, body: bodyInit });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
      hooks.onChange();
      msg.innerHTML = `<div class="import-ok">✓ Got it${r.pages ? ` — read ${r.pages} page${r.pages === 1 ? '' : 's'}` : ''}. Here’s what applio found:</div>`
        + (r.note ? `<p class="note">${esc(r.note)}</p>` : '')
        + r.warnings.filter(w => !/Experience|bullet/i.test(w)).map(w => `<p class="note">${esc(w)}</p>`).join('');
      found.innerHTML = summaryHTML(r.profile, r);
      if (r.missing.length) askMissing(r); else next.disabled = false;
    } catch (err) { msg.innerHTML = `<p class="note">${esc(err.message)}</p>`; }
    finally { drop.classList.remove('is-busy'); }
  };
  // Only ask for what the résumé didn't contain.
  const askMissing = r => {
    const labels = { name: 'Your name', email: 'Your email address', titles: 'A job title to look for' };
    found.insertAdjacentHTML('afterbegin', `<form class="missing" id="wzMissing"><p><b>One thing applio couldn’t find in your résumé:</b></p>
      ${r.missing.map(k => `<div class="field"><label for="m-${k}">${labels[k]}</label><input id="m-${k}" ${k === 'email' ? 'type="email"' : ''} required placeholder="${k === 'titles' ? 'e.g. data analyst' : ''}"></div>`).join('')}
      <button class="btn btn--primary">Save</button></form>`);
    $('#wzMissing', el).onsubmit = async e => {
      e.preventDefault();
      const v = k => $(`#m-${k}`, el)?.value.trim();
      try {
        const out = await send('POST', '/api/setup/complete-profile', { name: v('name'), email: v('email'), titles: v('titles') ? [v('titles')] : undefined });
        hooks.onChange(); found.innerHTML = summaryHTML(out.profile, r); next.disabled = false;
      } catch (err) { hooks.toast(err.message, true); }
    };
  };

  $('#wzPdf', el).onchange = e => { const f = e.target.files[0]; if (f) handle(f, f.name, 'application/pdf'); };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('is-over'); };
  drop.ondragleave = () => drop.classList.remove('is-over');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('is-over');
    const f = e.dataTransfer.files[0];
    if (!f || !/\.pdf$/i.test(f.name)) { msg.innerHTML = '<p class="note">Please drop a PDF file.</p>'; return; }
    handle(f, f.name, 'application/pdf');
  };
  $('#pasteToggle', el).onclick = () => { $('#pasteBox', el).hidden = false; $('#wzText', el).focus(); };
  $('#pasteGo', el).onclick = () => { const t = $('#wzText', el).value; if (t.trim()) handle(JSON.stringify({ text: t }), 'your text', 'application/json'); };
  next.onclick = () => go('companies');
}

// ---- 3. Companies -------------------------------------------------------
const ATS = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday' };
const keyOf = c => `${c.ats}:${c.slug || c.host + '/' + c.site}`.toLowerCase();

async function stepCompanies(el, cfg) {
  const suggested = await api('/api/config/suggested-companies');
  const dirCount = (await api('/api/directory')).count;
  const chosen = new Map(cfg.companies.map(c => [keyOf(c), c]));
  const all = [...cfg.companies, ...suggested.filter(c => !chosen.has(keyOf(c)))];
  el.innerHTML = `
    <h2>Any companies you especially want?</h2>
    <p class="muted">You don’t have to pick any: every scan already searches <b>${dirCount} companies</b> for roles posted in the last 7 days that match your titles. Companies you tick here are also checked in full, every role, however old. Add others by name or careers link.</p>
    <form class="detect" id="wzFind">
      <input id="wzFindIn" placeholder="Add a company: paste its careers page link, or type its name" aria-label="Careers link or company name">
      <button class="btn">Find</button>
    </form>
    <div id="wzFound"></div>
    <div class="picks" id="wzPicks"></div>
    <div class="wz__nav"><a class="btn" href="#/welcome/resume">← Back</a><span class="muted small" id="wzCount"></span><button class="btn btn--primary" id="wzNext">Skip</button></div>`;

  const render = () => {
    $('#wzPicks', el).innerHTML = all.map(c => `<label class="pick ${chosen.has(keyOf(c)) ? 'is-on' : ''}"><input type="checkbox" data-k="${esc(keyOf(c))}" ${chosen.has(keyOf(c)) ? 'checked' : ''}><b>${esc(c.name || c.slug)}</b><span class="muted small">${ATS[c.ats]}</span></label>`).join('');
    el.querySelectorAll('.pick input').forEach(i => i.onchange = () => {
      const c = all.find(x => keyOf(x) === i.dataset.k);
      i.checked ? chosen.set(i.dataset.k, c) : chosen.delete(i.dataset.k);
      i.closest('.pick').classList.toggle('is-on', i.checked); count();
    });
    count();
  };
  const count = () => { $('#wzCount', el).textContent = chosen.size ? `${chosen.size} selected` : ''; $('#wzNext', el).textContent = chosen.size ? 'Continue' : 'Skip'; };
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
    try { if (chosen.size || cfg.companies.length) await send('PUT', '/api/config/companies', { companies: [...chosen.values()] }); hooks.onChange(); go('ai'); }
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
        const label = prov() === 'claude' ? 'Claude' : 'OpenAI';
        msg.className = 'muted'; msg.innerHTML = `<span class="spin"></span> Connected. Re-reading your résumé with ${label}…`;
        try { await send('POST', '/api/setup/reprofile'); hooks.toast(`Connected to ${label} and re-read your résumé.`); }
        catch { hooks.toast(`Connected to ${label}.`); }
        hooks.onChange(); go('done');
      }
    } catch (e) { msg.className = 'bad'; msg.textContent = '✕ ' + e.message; }
    finally { btn.disabled = false; }
  };
}

// ---- 5. Done ------------------------------------------------------------
async function stepDone(el, cfg) {
  const st = await api('/api/integrations');
  cfg.directory = (await api('/api/directory')).count;
  el.innerHTML = `
    <h2>You’re all set</h2>
    <ul class="wz__summary">
      <li>✓ Résumé saved${cfg.originalPdf ? ' (with your original PDF)' : ''}</li>
      <li>✓ Looking for: ${esc((cfg.profile.preferences?.titles || []).join(', ') || '—')}</li>
      <li>✓ Searching ${cfg.directory} companies for roles from the last ${cfg.profile.preferences?.recentDays ?? 7} days${cfg.companies.length ? `, plus every role at ${cfg.companies.length} you picked` : ''}</li>
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
