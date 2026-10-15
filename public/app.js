// applio dashboard — vanilla JS over the local JSON API.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-applio': '1', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

// Pipeline stages in order (one blue ramp), then exception states (reserved status colors + icon).
const STAGES = ['matched', 'tailored', 'approved', 'submitted', 'interview', 'offer'];
const EXCEPTIONS = { needs_input: { color: 'var(--warning)', icon: '⚠' }, failed: { color: 'var(--critical)', icon: '✕' } };
const LABEL = { matched: 'Matched', tailored: 'Tailored', approved: 'Approved', submitted: 'Submitted', interview: 'Interview', offer: 'Offer', needs_input: 'Needs you', failed: 'Failed', skipped: 'Skipped', rejected: 'Rejected', new: 'New' };
const colorOf = s => STAGES.includes(s) ? `var(--s-${s})` : EXCEPTIONS[s]?.color || 'var(--ink-3)';
const statusPill = s => `<span class="status status--${s}"><i style="background:${colorOf(s)}"></i>${EXCEPTIONS[s] ? EXCEPTIONS[s].icon + ' ' : ''}${LABEL[s] || s}</span>`;

const ago = iso => {
  if (!iso) return '—';
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  if (m < 60 * 24 * 60) return `${Math.round(m / 1440)}d ago`;
  return new Date(iso).toLocaleDateString();
};

// ---- theme --------------------------------------------------------------
const savedTheme = (() => { try { return localStorage.getItem('applio-theme'); } catch { return null; } })();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('applio-theme', document.documentElement.dataset.theme); } catch {}
};

// ---- tooltip ------------------------------------------------------------
const tip = $('#tooltip');
const showTip = (e, html) => { tip.innerHTML = html; tip.classList.add('show'); tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; };
const hideTip = () => tip.classList.remove('show');

// ---- state --------------------------------------------------------------
const state = { status: 'active', q: '', company: '', min: 0, sort: 'score', offset: 0, limit: 50, openId: null, summary: null };

// ---- summary: KPIs + pipeline ------------------------------------------
async function loadSummary() {
  const s = state.summary = await api('/api/summary');
  const c = s.counts;
  const sum = (...k) => k.reduce((a, x) => a + (c[x] || 0), 0);
  const kpis = [
    { label: 'Open roles', value: s.open, sub: `${s.boards} boards watched`, filter: 'active' },
    { label: 'Matched', value: sum(...STAGES, 'needs_input', 'failed'), sub: `score ≥ ${s.profile?.minScore ?? 60}`, filter: 'active', sw: 'matched' },
    { label: 'Tailored', value: c.tailored || 0, sub: 'awaiting review', filter: 'tailored', sw: 'tailored' },
    { label: 'Approved', value: c.approved || 0, sub: 'ready to send', filter: 'approved', sw: 'approved' },
    { label: 'Submitted', value: sum('submitted', 'interview', 'offer'), sub: `${sum('interview', 'offer')} interviewing`, filter: 'submitted', sw: 'submitted' },
    { label: 'Needs you', value: c.needs_input || 0, sub: c.failed ? `${c.failed} failed` : 'blocked on input', filter: 'needs_input', sw: 'needs_input' },
  ];
  $('#kpis').innerHTML = kpis.map(k => `<button class="kpi ${state.status === k.filter && k.filter !== 'active' ? 'is-active' : ''}" data-filter="${k.filter}">
    <div class="kpi__label">${k.sw ? `<span class="swatch" style="background:${colorOf(k.sw)}"></span>` : ''}${k.sw === 'needs_input' ? '⚠ ' : ''}${k.label}</div>
    <div class="kpi__value">${k.value.toLocaleString()}</div><div class="kpi__sub">${k.sub}</div></button>`).join('');
  $('#kpis').querySelectorAll('.kpi').forEach(b => b.onclick = () => setStatus(b.dataset.filter));

  const segs = [...STAGES, ...Object.keys(EXCEPTIONS)].map(k => ({ k, n: c[k] || 0 })).filter(x => x.n);
  const total = segs.reduce((a, x) => a + x.n, 0);
  $('#pipeTotal').textContent = total ? `${total.toLocaleString()} jobs in the pipeline` : '';
  const bar = $('#pipebar');
  bar.setAttribute('aria-label', segs.map(x => `${LABEL[x.k]} ${x.n}`).join(', ') || 'empty');
  bar.innerHTML = segs.map(x => `<div data-k="${x.k}" style="flex-grow:${x.n};background:${colorOf(x.k)}"></div>`).join('');
  bar.querySelectorAll('div').forEach(d => {
    const x = segs.find(s => s.k === d.dataset.k);
    d.onmousemove = e => showTip(e, `${LABEL[x.k]} <b>${x.n.toLocaleString()}</b> · ${(100 * x.n / total).toFixed(1)}%`);
    d.onmouseleave = hideTip;
    d.onclick = () => setStatus(x.k);
  });
  $('#legend').innerHTML = [...STAGES, ...Object.keys(EXCEPTIONS)].map(k => `<li data-k="${k}"><span class="swatch" style="background:${colorOf(k)}"></span>${EXCEPTIONS[k] ? EXCEPTIONS[k].icon + ' ' : ''}${LABEL[k]} <b>${(c[k] || 0).toLocaleString()}</b></li>`).join('');
  $('#legend').querySelectorAll('li').forEach(li => li.onclick = () => setStatus(li.dataset.k));

  const ls = s.lastScan;
  $('#scanMeta').textContent = ls ? `Last scan ${ago(ls.at)} · ${ls.open.toLocaleString()} roles across ${ls.boards} boards · ${ls.fresh} new · ${ls.matches} new matches` : 'No scan yet — press "Scan boards".';
  $('#llmPill').textContent = s.llm.enabled ? `Claude: on` : 'Claude: off';
  $('#llmPill').className = `pill ${s.llm.enabled ? 'on' : 'off'}`;
  $('#llmPill').title = s.llm.enabled ? `Tailoring and answers use ${s.llm.model}` : 'Set ANTHROPIC_API_KEY and restart to enable tailoring and AI answers';
  $('#tailorTopBtn').disabled = !s.llm.enabled || !c.matched;

  const sel = $('#company'), cur = sel.value;
  sel.innerHTML = '<option value="">All companies</option>' + s.companies.map(x => `<option ${x.company === cur ? 'selected' : ''}>${esc(x.company)}</option>`).join('');
}

// ---- jobs table ---------------------------------------------------------
const SEG = [['active', 'Active'], ['matched', 'Matched'], ['tailored', 'Tailored'], ['approved', 'Approved'], ['needs_input', 'Needs you'], ['submitted', 'Submitted'], ['interview', 'Interview'], ['skipped', 'Skipped'], ['all', 'All']];
function renderSeg() {
  $('#statusSeg').innerHTML = SEG.map(([k, l]) => `<button role="tab" aria-selected="${state.status === k}" class="${state.status === k ? 'is-active' : ''}" data-k="${k}">${l}</button>`).join('');
  $('#statusSeg').querySelectorAll('button').forEach(b => b.onclick = () => setStatus(b.dataset.k));
}
function setStatus(k) { state.status = k; state.offset = 0; renderSeg(); loadJobs(); loadSummary(); }

let jobsReq = 0;
async function loadJobs() {
  const my = ++jobsReq;
  const p = new URLSearchParams({ status: state.status, q: state.q, company: state.company, min: state.min, sort: state.sort, limit: state.limit, offset: state.offset });
  const { total, rows } = await api('/api/jobs?' + p);
  if (my !== jobsReq) return;
  $('#jobsCount').textContent = `${total.toLocaleString()} jobs`;
  $('#rows').innerHTML = rows.length ? rows.map(r => `<tr data-id="${esc(r.id)}" class="${r.id === state.openId ? 'is-open' : ''}">
      <td><div class="score"><span class="score__bar"><i style="width:${r.score ?? 0}%"></i></span>${r.score ?? '—'}</div></td>
      <td class="title">${esc(r.title)}${r.note ? `<small>⚠ ${esc(r.note.slice(0, 90))}</small>` : ''}</td>
      <td>${esc(r.company)}</td>
      <td class="muted">${esc((r.location || '').slice(0, 40))}${r.remote ? ' · remote' : ''}</td>
      <td>${statusPill(r.status)}</td>
      <td class="muted">${ago(r.posted_at)}</td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">${state.summary?.lastScan ? 'No jobs match these filters.' : 'No jobs yet. Press “Scan boards” to pull postings from your watchlist.'}</td></tr>`;
  $('#rows').querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openJob(tr.dataset.id));
  $('#pageInfo').textContent = total ? `${state.offset + 1}–${Math.min(state.offset + state.limit, total)} of ${total.toLocaleString()}` : '';
  $('#prev').disabled = state.offset === 0;
  $('#next').disabled = state.offset + state.limit >= total;
}
let qTimer;
$('#q').oninput = e => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; loadJobs(); }, 200); };
$('#company').onchange = e => { state.company = e.target.value; state.offset = 0; loadJobs(); };
$('#sort').onchange = e => { state.sort = e.target.value; state.offset = 0; loadJobs(); };
$('#min').oninput = e => { $('#minOut').textContent = e.target.value; };
$('#min').onchange = e => { state.min = Number(e.target.value); state.offset = 0; loadJobs(); };
$('#prev').onclick = () => { state.offset = Math.max(0, state.offset - state.limit); loadJobs(); };
$('#next').onclick = () => { state.offset += state.limit; loadJobs(); };

// ---- drawer -------------------------------------------------------------
async function openJob(id) {
  state.openId = id;
  document.querySelectorAll('#rows tr').forEach(tr => tr.classList.toggle('is-open', tr.dataset.id === id));
  $('#drawer').classList.add('is-open'); $('#scrim').classList.add('is-open'); $('#drawer').setAttribute('aria-hidden', 'false');
  await renderJob(id);
}
function closeDrawer() {
  state.openId = null;
  $('#drawer').classList.remove('is-open'); $('#scrim').classList.remove('is-open'); $('#drawer').setAttribute('aria-hidden', 'true');
  document.querySelectorAll('#rows tr').forEach(tr => tr.classList.remove('is-open'));
}
$('#closeDrawer').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;
addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

async function renderJob(id) {
  const d = await api('/api/jobs/' + encodeURIComponent(id));
  if (state.openId !== id) return;
  const { job, app, tailor, receipt, files } = d;
  const status = app?.status || 'new';
  const llm = state.summary?.llm.enabled;
  const busy = d.busy.length ? `<span class="muted"><span class="spin"></span> ${d.busy.join(', ')} running…</span>` : '';
  $('#dTitle').textContent = job.title;
  $('#dSub').innerHTML = `${esc(job.company)} · ${esc(job.location)}${job.remote ? ' · remote' : ''} · ${job.ats} · posted ${ago(job.posted_at)}${job.compensation ? ' · ' + esc(job.compensation) : ''}${job.closed ? ' · <b class="bad">closed</b>' : ''}`;
  const fileLink = (name, label) => files[name] ? `<a href="/files/${files[name].split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener">${label}</a>` : '';

  $('#dBody').innerHTML = `
    <div class="sec actions">
      ${statusPill(status)} ${app?.score != null ? `<span class="muted">score ${app.score}</span>` : ''}
      <span style="flex:1"></span>
      <button class="btn" data-act="tailor" ${!llm || d.busy.length ? 'disabled' : ''} title="${llm ? 'Rewrite résumé + cover letter for this job' : 'Needs ANTHROPIC_API_KEY'}">${tailor ? 'Re-tailor' : 'Tailor'}</button>
      <button class="btn" data-act="approve" ${status === 'approved' ? 'disabled' : ''}>Approve</button>
      <button class="btn" data-act="dry" ${d.busy.length ? 'disabled' : ''} title="Fill the form and screenshot it without sending">Dry run</button>
      <button class="btn btn--primary" data-act="submit" ${status !== 'approved' || d.busy.length ? 'disabled' : ''} title="${status === 'approved' ? 'Fill and submit the application' : 'Approve first'}">Submit</button>
      <select data-act="status" aria-label="Set status">${['', ...state.summary.statuses].map(s => `<option value="${s}">${s ? LABEL[s] || s : 'Set status…'}</option>`).join('')}</select>
    </div>
    ${busy}
    ${app?.note ? `<div class="note">${esc(app.note)}</div>` : ''}
    <div class="sec files"><a href="${esc(job.url)}" target="_blank" rel="noopener">Posting ↗</a><a href="${esc(job.apply_url)}" target="_blank" rel="noopener">Application form ↗</a>
      ${fileLink('resume.pdf', 'Tailored résumé PDF')}${fileLink('cover_letter.pdf', 'Cover letter PDF')}${fileLink('resume-base.pdf', 'Base résumé PDF')}${fileLink('apply/filled.png', 'Filled form screenshot')}${fileLink('apply/after-submit.png', 'After submit')}${fileLink('apply/receipt.json', 'Receipt JSON')}</div>
    ${app?.reasons?.length ? `<div class="sec"><h3>Why it matched</h3><ul class="reasons">${app.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    ${tailor ? `<div class="sec"><h3>Tailoring</h3>
      <p>${esc(tailor.summary)}</p>
      <div class="chips" style="margin:6px 0 10px">${tailor.keywords_matched.map(k => `<span>✓ ${esc(k)}</span>`).join('')}${tailor.keywords_missing.map(k => `<span class="muted">gap: ${esc(k)}</span>`).join('')}</div>
      <div class="diff">${tailor.accepted.map(e => `<p class="del">− ${esc(e.original)}</p><p class="add">+ ${esc(e.rewritten)}</p><p class="why">${esc(e.reason)}</p>`).join('')}
      ${tailor.rejected.length ? `<h3 style="margin-top:12px">Rejected by fact check</h3>${tailor.rejected.map(e => `<p class="del">${esc(e.rewritten)}</p><p class="why">${esc(e.why)}</p>`).join('')}` : ''}</div></div>` : ''}
    ${d.coverLetter ? `<div class="sec"><h3>Cover letter</h3><pre class="letter">${esc(d.coverLetter)}</pre></div>` : ''}
    ${receipt ? `<div class="sec"><h3>Application form · ${receipt.submitted ? '<span class="ok">submitted</span>' : 'not submitted'} · ${new Date(receipt.finishedAt || receipt.startedAt).toLocaleString()}</h3>
      <table class="receipt"><colgroup><col class="c-mark"><col class="c-label"><col><col class="c-src"></colgroup>${receipt.fields.map(f => {
        const missing = f.source === 'missing' || String(f.source).startsWith('error');
        const mark = missing ? (f.required ? '<span class="bad" title="required, unanswered">✕</span>' : '<span class="warn" title="optional, unanswered">○</span>') : '<span class="ok">✓</span>';
        return `<tr><td>${mark}</td><td>${esc(f.label || '(unlabelled)')}${f.required ? ' *' : ''}</td><td class="v">${esc(typeof f.value === 'string' ? f.value : f.value == null ? '' : String(f.value))}</td><td class="src">${esc(f.source)}</td></tr>`;
      }).join('')}</table>
      ${files['apply/filled.png'] ? `<a href="/files/${files['apply/filled.png'].split('/').map(encodeURIComponent).join('/')}" target="_blank"><img class="shot" loading="lazy" alt="Filled application form" src="/files/${files['apply/filled.png'].split('/').map(encodeURIComponent).join('/')}?t=${Date.now()}"></a>` : ''}</div>` : ''}
    <div class="sec"><h3>Description</h3><div class="desc">${esc(job.description || '(no description)')}</div></div>
    ${d.events.length ? `<div class="sec"><h3>History</h3><ul class="events">${d.events.map(e => `<li><time>${new Date(e.at).toLocaleString()}</time>${esc(e.kind)} · ${esc(e.detail)}</li>`).join('')}</ul></div>` : ''}`;

  const enc = encodeURIComponent(id);
  const act = async (fn) => { try { await fn(); } catch (e) { toast(e.message, true); } };
  $('#dBody').querySelector('[data-act=tailor]').onclick = () => act(async () => { track(await post(`/api/jobs/${enc}/tailor`)); renderJob(id); });
  $('#dBody').querySelector('[data-act=approve]').onclick = () => act(async () => { await post(`/api/jobs/${enc}/status`, { status: 'approved' }); refreshAll(); });
  $('#dBody').querySelector('[data-act=dry]').onclick = () => act(async () => { track(await post(`/api/jobs/${enc}/apply`, { submit: false })); renderJob(id); });
  $('#dBody').querySelector('[data-act=submit]').onclick = () => act(async () => {
    if (!confirm(`Submit your application to ${job.company} for "${job.title}"?\n\nThis sends it to the employer.`)) return;
    track(await post(`/api/jobs/${enc}/apply`, { submit: true })); renderJob(id);
  });
  $('#dBody').querySelector('[data-act=status]').onchange = e => e.target.value && act(async () => { await post(`/api/jobs/${enc}/status`, { status: e.target.value }); refreshAll(); });
}

// ---- background tasks ---------------------------------------------------
const watching = new Map(); // task id → task
function track(t) { for (const x of [].concat(t)) watching.set(x.id, x); renderTasks(); pollTasks(); }
function toast(msg, error = false) { const id = 'toast' + Date.now(); watching.set(id, { id, label: msg, status: error ? 'error' : 'done', log: [], toast: true }); renderTasks(); setTimeout(() => { watching.delete(id); renderTasks(); }, 5000); }
function renderTasks() {
  $('#tasks').innerHTML = [...watching.values()].map(t => `<div class="task ${t.status}">
    <header><span>${t.status === 'running' || t.status === 'queued' ? '<span class="spin"></span> ' : t.status === 'done' ? '<span class="ok">✓</span> ' : '<span class="bad">✕</span> '}${esc(t.label)}${t.status === 'queued' ? ' <span class="muted">(queued)</span>' : ''}</span>
    <button data-id="${t.id}" aria-label="Dismiss">✕</button></header>
    ${t.log?.length ? `<div class="log">${esc(t.log.slice(-3).join('\n'))}</div>` : ''}</div>`).join('');
  $('#tasks').querySelectorAll('button').forEach(b => b.onclick = () => { watching.delete(isNaN(b.dataset.id) ? b.dataset.id : Number(b.dataset.id)); renderTasks(); });
}
let polling = false;
async function pollTasks() {
  if (polling) return; polling = true;
  try {
    while ([...watching.values()].some(t => t.status === 'queued' || t.status === 'running')) {
      await new Promise(r => setTimeout(r, 1200));
      const all = await api('/api/tasks');
      let finished = false;
      for (const t of all) if (watching.has(t.id)) {
        const prev = watching.get(t.id);
        if (prev.status !== t.status && (t.status === 'done' || t.status === 'error')) {
          finished = true;
          setTimeout(() => { if (watching.get(t.id)?.status === 'done') { watching.delete(t.id); renderTasks(); } }, 8000);
        }
        watching.set(t.id, t);
      }
      renderTasks();
      if (finished) refreshAll();
    }
  } finally { polling = false; }
}
async function refreshAll() { await Promise.all([loadSummary(), loadJobs()]); if (state.openId) renderJob(state.openId); }

$('#scanBtn').onclick = async () => { try { track(await post('/api/scan')); } catch (e) { toast(e.message, true); } };
$('#tailorTopBtn').onclick = async () => { try { const t = await post('/api/tailor-top', { n: 5 }); t.length ? track(t) : toast('No matched jobs waiting.'); } catch (e) { toast(e.message, true); } };

// Resume watching tasks that were already running when the page loaded.
api('/api/tasks').then(all => { const live = all.filter(t => t.status === 'queued' || t.status === 'running'); if (live.length) track(live); });
renderSeg();
refreshAll();
setInterval(loadSummary, 60_000);
