// Settings view: edit profile.json, resume.md and companies.json from the dashboard.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-applio': '1' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};
const send = (method, path, body) => api(path, { method, body: JSON.stringify(body) });

const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const set = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => (a[k] ??= {}), o); if (v === undefined) delete t[last]; else t[last] = v; };

// ---- form schema for profile.json --------------------------------------
const SENIORITY = ['intern', 'junior', 'mid', 'senior', 'staff', 'manager'];
const PROFILE_SECTIONS = [
  { title: 'Contact', help: 'Used to fill the contact fields on every application.', fields: [
    ['name', 'Full name', 'text', { required: true }], ['firstName', 'First name'], ['lastName', 'Last name'],
    ['email', 'Email', 'email', { required: true }], ['phone', 'Phone', 'tel'],
    ['location', 'Location', 'text', { placeholder: 'City, region, country' }], ['country', 'Country'],
    ['links.linkedin', 'LinkedIn URL', 'url'], ['links.github', 'GitHub URL', 'url'], ['links.website', 'Website / portfolio', 'url'],
  ] },
  { title: 'Work & eligibility', help: 'Answers to the screening questions most forms ask.', fields: [
    ['currentCompany', 'Current or last company'], ['currentTitle', 'Current or last title'],
    ['yearsExperience', 'Years of experience', 'number'],
    ['workAuthorization.authorized', 'I am authorized to work where I am applying', 'bool'],
    ['workAuthorization.needsSponsorship', 'I need visa sponsorship', 'bool'],
    ['willingToRelocate', 'I am willing to relocate', 'bool'],
    ['salaryExpectation', 'Salary expectation', 'text', { placeholder: 'e.g. $150k base, or "Open"' }],
    ['availability', 'Availability / notice period', 'text', { placeholder: "e.g. Two weeks' notice" }],
    ['howDidYouHear', '“How did you hear about us?” answer'], ['pronouns', 'Pronouns (optional)'],
  ] },
  { title: 'What you are looking for', help: 'Drives the match score. Type and press Enter to add each item.', fields: [
    ['preferences.titles', 'Target job titles', 'tags', { placeholder: 'backend engineer' }],
    ['preferences.titleKeywords', 'Title keywords (partial credit)', 'tags', { placeholder: 'platform' }],
    ['preferences.excludeTitleKeywords', 'Skip titles containing', 'tags', { placeholder: 'intern' }],
    ['preferences.skills', 'Your skills', 'tags', { placeholder: 'python' }],
    ['preferences.locations', 'Preferred locations', 'tags', { placeholder: 'new york' }],
    ['preferences.excludeCompanies', 'Companies to skip', 'tags'],
    ['preferences.seniority', 'Seniority levels', 'multi', { options: SENIORITY }],
    ['preferences.remoteOk', 'Remote roles are fine', 'bool'],
    ['preferences.strictLocation', 'Only show jobs in my preferred locations', 'bool'],
    ['preferences.minScore', 'Minimum match score', 'range'],
    ['preferences.dailyTailorLimit', 'Most jobs to tailor in one batch', 'number'],
  ] },
  { title: 'Voluntary self-identification', help: 'Optional. Leave blank to answer “decline to self-identify” wherever the form allows it.', fields: [
    ['eeo.gender', 'Gender'], ['eeo.race', 'Race / ethnicity'], ['eeo.veteran', 'Veteran status'], ['eeo.disability', 'Disability status'],
  ] },
];

let cfg = null;          // last loaded config from the server
let draft = null;        // { profile, resume, companies } being edited
let dirty = { profile: false, resume: false, companies: false };
let onSaved = () => {};
let notify = () => {};

export function initSettings({ onSave, toast }) { onSaved = onSave; notify = toast; }

export async function showSettings(tab = 'profile') {
  if (!cfg || !Object.values(dirty).some(Boolean)) {
    cfg = await api('/api/config');
    draft = structuredClone({ profile: cfg.profile, resume: cfg.resume, companies: cfg.companies });
  }
  const root = $('#settings');
  root.innerHTML = `
    <div class="settings__head">
      <div><h1>Settings</h1><p class="muted">Saved to <span class="mono">${esc(cfg.paths.profile)}</span>, <span class="mono">${esc(cfg.paths.resume)}</span> and <span class="mono">${esc(cfg.paths.companies)}</span>.</p></div>
      <a class="btn" href="#/">← Back to jobs</a>
    </div>
    ${!Object.values(cfg.exists).every(Boolean) ? `<div class="setup-note">First-time setup: the forms below start from an example. Replace it with your details and press <b>Save</b> on each tab: ${['profile', 'resume', 'companies'].map(k => `<span class="${cfg.exists[k] ? 'ok' : 'bad'}">${cfg.exists[k] ? '✓' : '○'} ${k === 'resume' ? 'résumé' : k}</span>`).join(' · ')}</div>` : ''}
    <div class="seg settings__tabs" role="tablist">
      ${[['profile', 'Profile'], ['resume', 'Résumé'], ['companies', 'Companies']].map(([k, l]) => `<a role="tab" href="#/settings/${k}" class="${tab === k ? 'is-active' : ''}">${l}${dirty[k] ? ' •' : ''}</a>`).join('')}
    </div>
    <div id="settingsBody"></div>`;
  ({ profile: renderProfile, resume: renderResume, companies: renderCompanies })[tab]?.($('#settingsBody'));
}

function markDirty(k) {
  dirty[k] = true;
  const tab = document.querySelector(`.settings__tabs a[href="#/settings/${k}"]`);
  if (tab && !tab.textContent.endsWith('•')) tab.textContent += ' •';
  const btn = document.querySelector(`[data-save="${k}"]`);
  if (btn) btn.disabled = false;
}
addEventListener('beforeunload', e => { if (Object.values(dirty).some(Boolean)) e.preventDefault(); });

async function save(kind, body) {
  try {
    cfg = await send('PUT', `/api/config/${kind}`, body);
    dirty[kind] = false;
    notify(`${kind === 'resume' ? 'Résumé' : kind[0].toUpperCase() + kind.slice(1)} saved.`);
    onSaved(kind);
    showSettings(kind);
  } catch (e) { notify(e.message, true); }
}

// ---- Profile -----------------------------------------------------------
function renderProfile(el) {
  const p = draft.profile;
  p.preferences ??= {};
  const field = ([path, label, type = 'text', o = {}]) => {
    const v = get(p, path);
    const id = 'pf-' + path.replace(/\./g, '-');
    if (type === 'bool') return `<label class="check"><input type="checkbox" data-path="${path}" data-type="bool" ${v ? 'checked' : ''}> ${esc(label)}</label>`;
    if (type === 'tags') return `<div class="field field--wide"><label for="${id}">${esc(label)}</label><div class="tags" data-path="${path}">${(v || []).map(t => `<span class="tag">${esc(t)}<button type="button" aria-label="Remove ${esc(t)}">×</button></span>`).join('')}<input id="${id}" placeholder="${esc(o.placeholder || 'Type and press Enter')}"></div></div>`;
    if (type === 'multi') return `<div class="field field--wide"><span class="label">${esc(label)}</span><div class="multi" data-path="${path}">${o.options.map(x => `<label class="check"><input type="checkbox" value="${x}" ${(v || []).includes(x) ? 'checked' : ''}> ${x}</label>`).join('')}</div></div>`;
    if (type === 'range') return `<div class="field"><label for="${id}">${esc(label)}: <output>${v ?? 60}</output></label><input id="${id}" type="range" min="0" max="100" step="5" value="${v ?? 60}" data-path="${path}" data-type="number"></div>`;
    return `<div class="field"><label for="${id}">${esc(label)}${o.required ? ' *' : ''}</label><input id="${id}" type="${type}" value="${esc(v ?? '')}" data-path="${path}" data-type="${type === 'number' ? 'number' : 'text'}" placeholder="${esc(o.placeholder || '')}" ${o.required ? 'required' : ''}></div>`;
  };
  el.innerHTML = `
    <form class="pform" novalidate>
      ${PROFILE_SECTIONS.map(s => `<fieldset class="card"><legend>${s.title}</legend><p class="muted small">${s.help}</p><div class="grid">${s.fields.map(field).join('')}</div></fieldset>`).join('')}
      <fieldset class="card"><legend>Standing answers</legend>
        <p class="muted small">Your fixed answers to questions that come up often. The pattern is matched against the question text (not case-sensitive), e.g. <span class="mono">ever worked for</span> → <span class="mono">No</span>. Questions not covered here or above are answered by Claude from your résumé, or left for you.</p>
        <div id="answers"></div><button type="button" class="btn" id="addAnswer">+ Add answer</button>
      </fieldset>
      <details class="card"><summary>Advanced: edit profile.json directly</summary>
        <textarea id="rawProfile" class="code" rows="16" spellcheck="false"></textarea>
        <button type="button" class="btn" id="applyRaw">Apply JSON to the form</button>
      </details>
      <div class="savebar"><span class="muted" id="pfMsg"></span><button type="submit" class="btn btn--primary" data-save="profile" ${dirty.profile ? '' : 'disabled'}>Save profile</button></div>
    </form>`;

  const form = $('.pform', el);
  const renderAnswers = () => {
    $('#answers', el).innerHTML = (p.answers || []).map((a, i) => `<div class="answer-row" data-i="${i}">
      <input placeholder="Question contains…" value="${esc(a.match)}" data-k="match" aria-label="Question pattern">
      <span class="muted">→</span><input placeholder="Answer" value="${esc(a.answer)}" data-k="answer" aria-label="Answer">
      <button type="button" class="icon-btn" aria-label="Remove">×</button></div>`).join('') || '<p class="muted small">None yet.</p>';
    el.querySelectorAll('.answer-row').forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelectorAll('input').forEach(inp => inp.oninput = () => { p.answers[i][inp.dataset.k] = inp.value; markDirty('profile'); });
      row.querySelector('button').onclick = () => { p.answers.splice(i, 1); renderAnswers(); markDirty('profile'); };
    });
  };
  renderAnswers();
  $('#addAnswer', el).onclick = () => { (p.answers ??= []).push({ match: '', answer: '' }); renderAnswers(); markDirty('profile'); el.querySelector('.answer-row:last-child input')?.focus(); };

  form.querySelectorAll('input[data-path]').forEach(inp => inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
    const t = inp.dataset.type;
    if (inp.dataset.path === 'name') {
      // Keep first/last name in step with the full name unless they've been set to something else.
      const split = n => { const [f, ...r] = (n || '').trim().split(/\s+/); return [f || '', r.join(' ')]; };
      const [oldF, oldL] = split(p.name), [newF, newL] = split(inp.value);
      for (const [k, oldV, newV] of [['firstName', oldF, newF], ['lastName', oldL, newL]]) {
        if (!p[k] || p[k] === oldV) { p[k] = newV || undefined; const box = $('#pf-' + k, form); if (box) box.value = newV; }
      }
    }
    let v = t === 'bool' ? inp.checked : t === 'number' ? (inp.value === '' ? undefined : Number(inp.value)) : inp.value;
    if (t === 'text' && v === '') v = undefined;
    set(p, inp.dataset.path, v);
    if (inp.type === 'range') inp.previousElementSibling.querySelector('output').textContent = inp.value;
    markDirty('profile');
  }));
  form.querySelectorAll('.multi').forEach(box => box.addEventListener('change', () => {
    set(p, box.dataset.path, [...box.querySelectorAll('input:checked')].map(i => i.value)); markDirty('profile');
  }));
  form.querySelectorAll('.tags').forEach(box => {
    const path = box.dataset.path, input = box.querySelector('input');
    const list = () => get(p, path) || [];
    const redraw = () => { box.querySelectorAll('.tag').forEach(t => t.remove()); input.insertAdjacentHTML('beforebegin', list().map(t => `<span class="tag">${esc(t)}<button type="button" aria-label="Remove ${esc(t)}">×</button></span>`).join('')); wire(); };
    const wire = () => box.querySelectorAll('.tag button').forEach((b, i) => b.onclick = () => { const l = list(); l.splice(i, 1); set(p, path, l); redraw(); markDirty('profile'); });
    const add = () => {
      const vals = input.value.split(',').map(s => s.trim()).filter(Boolean);
      if (!vals.length) return;
      set(p, path, [...new Set([...list(), ...vals])]); input.value = ''; redraw(); markDirty('profile');
    };
    input.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
      else if (e.key === 'Backspace' && !input.value && list().length) { const l = list(); l.pop(); set(p, path, l); redraw(); markDirty('profile'); }
    };
    input.onblur = add;
    box.onclick = e => { if (e.target === box) input.focus(); };
    wire();
  });

  const raw = $('#rawProfile', el);
  raw.value = JSON.stringify(p, null, 2);
  $('#applyRaw', el).onclick = () => {
    try { draft.profile = JSON.parse(raw.value); markDirty('profile'); renderProfile(el); notify('JSON applied — review and save.'); }
    catch (e) { notify('That JSON has an error: ' + e.message, true); }
  };

  form.onsubmit = e => {
    e.preventDefault();
    // Keep the matcher's sponsorship flag in step with the eligibility answer; drop blank self-ID answers and empty standing answers.
    p.preferences.needsSponsorship = !!p.workAuthorization?.needsSponsorship;
    if (p.eeo) for (const k of Object.keys(p.eeo)) if (!p.eeo[k]) delete p.eeo[k];
    p.answers = (p.answers || []).filter(a => a.match.trim() && a.answer.trim());
    const [first, ...rest] = (p.name || '').trim().split(/\s+/);
    if (!p.firstName && first) p.firstName = first;
    if (!p.lastName && rest.length) p.lastName = rest.join(' ');
    save('profile', { profile: p });
  };
}

// ---- Résumé ------------------------------------------------------------
function mdToHtml(md) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  const out = []; let list = false;
  for (const line of md.split('\n')) {
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (!li && list) { out.push('</ul>'); list = false; }
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); }
    else if (/^#\s/.test(line)) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (/^##\s/.test(line)) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (/^###\s/.test(line)) out.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
function resumeChecks(md) {
  const has = re => re.test(md);
  return [
    [has(/^#\s+\S/m), 'Name as a top heading (# Your Name)'],
    [has(/^##\s*Summary/im), '## Summary section (rewritten per job)'],
    [has(/^##\s*Experience/im), '## Experience section'],
    [(md.match(/^\s*-\s+\S/gm) || []).length >= 3, 'Experience bullets start with "- "'],
    [has(/^##\s*Skills/im), '## Skills section, comma-separated (re-ordered per job)'],
  ];
}

function renderResume(el) {
  el.innerHTML = `
    <div class="card">
      <p class="muted small">Write your résumé in Markdown. Tailoring rewrites the bullets under <b>## Experience</b>, the <b>## Summary</b>, and the order of <b>## Skills</b>, and never adds facts that aren't here. Copy and paste from Word or a PDF, then add the <span class="mono">#</span>, <span class="mono">##</span> and <span class="mono">-</span> markers.</p>
      <div class="resume-tools">
        <label class="btn">Open .md / .txt file<input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" id="resumeFile" hidden></label>
        <button type="button" class="btn" id="resumeExample">Insert example layout</button>
        <button type="button" class="btn" id="resumePdf">Preview as PDF</button>
        <span style="flex:1"></span>
        <button type="button" class="btn btn--primary" data-save="resume" ${dirty.resume ? '' : 'disabled'}>Save résumé</button>
      </div>
      <ul class="checks" id="resumeChecks"></ul>
      <div class="resume-split">
        <textarea id="resumeText" class="code" spellcheck="true" aria-label="Résumé Markdown"></textarea>
        <div class="resume-preview" id="resumePreview" aria-label="Preview"></div>
      </div>
    </div>`;
  const ta = $('#resumeText', el);
  ta.value = draft.resume;
  const update = () => {
    $('#resumePreview', el).innerHTML = mdToHtml(ta.value);
    $('#resumeChecks', el).innerHTML = resumeChecks(ta.value).map(([ok, t]) => `<li class="${ok ? 'ok' : 'warn'}">${ok ? '✓' : '○'} ${t}</li>`).join('');
  };
  update();
  ta.oninput = () => { draft.resume = ta.value; update(); markDirty('resume'); };
  $('#resumeFile', el).onchange = async e => { const f = e.target.files[0]; if (!f) return; ta.value = draft.resume = await f.text(); update(); markDirty('resume'); };
  $('#resumeExample', el).onclick = () => {
    if (ta.value.trim() && !confirm('Replace the editor contents with the example layout?')) return;
    ta.value = draft.resume = `# Your Name\nCity, Country · you@example.com · linkedin.com/in/you · github.com/you\n\n## Summary\nOne or two sentences about what you do and what you're looking for.\n\n## Experience\n\n### Job Title — Company (2022 – present)\n- What you did, with the result and a number if you have one.\n- Another accomplishment.\n\n### Job Title — Company (2019 – 2022)\n- Accomplishment.\n\n## Education\nDegree — School (Year)\n\n## Skills\nSkill one, Skill two, Skill three\n`;
    update(); markDirty('resume');
  };
  $('#resumePdf', el).onclick = async () => {
    try { const r = await send('POST', '/api/config/resume/preview', { markdown: ta.value }); open(`/files/${r.file}?t=${Date.now()}`, '_blank'); }
    catch (e) { notify(e.message, true); }
  };
  el.querySelector('[data-save=resume]').onclick = () => save('resume', { markdown: ta.value });
}

// ---- Companies ---------------------------------------------------------
const boardId = c => c.ats === 'workday' ? `${c.host}/${c.site}` : c.slug;
const boardUrl = c => ({
  greenhouse: `https://job-boards.greenhouse.io/${c.slug}`, lever: `https://jobs.lever.co/${c.slug}`,
  ashby: `https://jobs.ashbyhq.com/${c.slug}`, workday: `https://${c.host}/${c.site}`,
})[c.ats];
const ATS = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday' };

function renderCompanies(el) {
  const list = draft.companies;
  el.innerHTML = `
    <div class="card">
      <h2>Add a company</h2>
      <p class="muted small">Paste the company's careers page or job board link, or just type its name. applio works out which job board it uses (Greenhouse, Lever, Ashby or Workday) and checks it has open roles.</p>
      <form class="detect" id="detectForm">
        <input id="detectInput" placeholder="e.g. https://boards.greenhouse.io/stripe, jobs.lever.co/spotify, or Notion" aria-label="Careers URL or company name" required>
        <input id="detectName" placeholder="Display name (optional)" aria-label="Display name">
        <button class="btn btn--primary" id="detectBtn">Find board</button>
      </form>
      <div id="detectResult"></div>
      <details><summary class="muted small">Add manually</summary>
        <form class="manual" id="manualForm">
          <select id="mAts">${Object.entries(ATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <input id="mName" placeholder="Name" required>
          <input id="mSlug" placeholder="Board slug (e.g. stripe)">
          <input id="mHost" placeholder="Workday host (acme.wd5.myworkdayjobs.com)" hidden>
          <input id="mSite" placeholder="Workday site (External)" hidden>
          <button class="btn">Add</button>
        </form>
      </details>
    </div>
    <div class="card">
      <div class="card__head"><h2>Watchlist <span class="muted">(${list.length})</span></h2>
        <button type="button" class="btn btn--primary" data-save="companies" ${dirty.companies ? '' : 'disabled'}>Save companies</button></div>
      ${list.length ? `<table class="jobs companies"><thead><tr><th>Name</th><th>Board</th><th>Identifier</th><th></th></tr></thead><tbody>
        ${list.map((c, i) => `<tr data-i="${i}">
          <td><input class="inline" value="${esc(c.name || '')}" aria-label="Name"></td>
          <td>${ATS[c.ats]}</td>
          <td class="mono"><a href="${esc(boardUrl(c))}" target="_blank" rel="noopener">${esc(boardId(c))}</a></td>
          <td class="row-actions"><span class="muted small" data-count></span><button type="button" class="btn" data-test>Test</button><button type="button" class="icon-btn" data-remove aria-label="Remove">×</button></td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">No companies yet. Add one above.</p>'}
    </div>`;

  const res = $('#detectResult', el);
  $('#detectForm', el).onsubmit = async e => {
    e.preventDefault();
    const btn = $('#detectBtn', el); btn.disabled = true; btn.textContent = 'Looking…';
    res.innerHTML = '<p class="muted small"><span class="spin"></span> Checking job boards…</p>';
    try {
      const r = await send('POST', '/api/config/detect', { input: $('#detectInput', el).value, name: $('#detectName', el).value.trim() || undefined });
      if (!r.found.length) { res.innerHTML = `<p class="note">No public Greenhouse, Lever, Ashby or Workday board found for that. Open the company's careers page, click a job, and paste the link of the page with the application form.</p>`; return; }
      res.innerHTML = `<ul class="found">${r.found.map((f, i) => {
        const already = list.some(c => c.ats === f.entry.ats && boardId(c) === boardId(f.entry));
        return `<li><span><b>${esc(f.entry.name)}</b> · ${ATS[f.entry.ats]} · <span class="mono">${esc(boardId(f.entry))}</span> · ${f.jobs} open roles</span>
          <button type="button" class="btn" data-add="${i}" ${already ? 'disabled' : ''}>${already ? 'Already added' : 'Add'}</button></li>`;
      }).join('')}</ul>`;
      res.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
        list.push(r.found[Number(b.dataset.add)].entry); markDirty('companies'); renderCompanies(el);
        $('#detectInput', el).value = ''; notify('Added — press “Save companies” to keep it.');
      });
    } catch (err) { res.innerHTML = `<p class="note">${esc(err.message)}</p>`; }
    finally { btn.disabled = false; btn.textContent = 'Find board'; }
  };

  const ats = $('#mAts', el);
  ats.onchange = () => { const wd = ats.value === 'workday'; $('#mSlug', el).hidden = wd; $('#mHost', el).hidden = !wd; $('#mSite', el).hidden = !wd; };
  $('#manualForm', el).onsubmit = e => {
    e.preventDefault();
    const c = { ats: ats.value, name: $('#mName', el).value.trim() };
    if (c.ats === 'workday') { c.host = $('#mHost', el).value.trim(); c.tenant = c.host.split('.')[0]; c.site = $('#mSite', el).value.trim(); if (!c.host || !c.site) return notify('Workday needs host and site', true); }
    else { c.slug = $('#mSlug', el).value.trim(); if (!c.slug) return notify('Enter the board slug', true); }
    list.push(c); markDirty('companies'); renderCompanies(el);
  };

  el.querySelectorAll('tbody tr').forEach(tr => {
    const i = Number(tr.dataset.i), c = list[i];
    tr.querySelector('input.inline').oninput = e => { c.name = e.target.value; markDirty('companies'); };
    tr.querySelector('[data-remove]').onclick = () => { list.splice(i, 1); markDirty('companies'); renderCompanies(el); };
    tr.querySelector('[data-test]').onclick = async e => {
      const out = tr.querySelector('[data-count]'); e.target.disabled = true; out.innerHTML = '<span class="spin"></span>';
      try { const r = await send('POST', '/api/config/detect', { input: boardUrl(c), name: c.name }); out.textContent = r.found.length ? `${r.found[0].jobs} open roles` : 'not reachable'; out.className = r.found.length ? 'small ok' : 'small bad'; }
      catch (err) { out.textContent = err.message; out.className = 'small bad'; }
      finally { e.target.disabled = false; }
    };
  });
  el.querySelector('[data-save=companies]').onclick = () => save('companies', { companies: list });
}
