// AI provider settings (Claude / OpenAI): API keys, models and which one is active.
// Stored in the local database (data/, git-ignored). Keys are never sent back to the browser.
// Environment variables still work: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and OPENAI_API_KEY.
import { getJSON, setJSON } from './store.js';

export const PROVIDERS = {
  claude: { label: 'Claude', defaultModel: 'claude-opus-5-5', env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], keyPrefix: 'sk-ant-' },
  openai: { label: 'OpenAI', defaultModel: '', env: ['OPENAI_API_KEY'], keyPrefix: 'sk-' },
};

const bad = msg => Object.assign(new Error(msg), { status: 400 });

export function loadIntegrations() { return getJSON('integrations') || {}; }

/** Key for a provider: saved key first, then environment. */
export function keyFor(name, saved = loadIntegrations()) {
  const k = saved[name]?.apiKey;
  if (k) return { key: k, source: 'saved' };
  for (const v of PROVIDERS[name].env) if (process.env[v]) return { key: process.env[v], source: 'env', envVar: v };
  return { key: null, source: null };
}

/** The provider + model used for tailoring and answers, or null when none is set up. */
export function activeProvider(saved = loadIntegrations()) {
  let name = saved.provider;
  if (name === 'none') return null;
  if (!name || !PROVIDERS[name] || !keyFor(name, saved).key) name = Object.keys(PROVIDERS).find(n => keyFor(n, saved).key && (saved[n]?.model || PROVIDERS[n].defaultModel));
  if (!name) return null;
  const { key, source } = keyFor(name, saved);
  const model = saved[name]?.model || (name === 'claude' ? process.env.APPLIO_MODEL : process.env.APPLIO_OPENAI_MODEL) || PROVIDERS[name].defaultModel;
  if (!key || !model) return null;
  return { name, label: PROVIDERS[name].label, key, source, model };
}

const hint = k => k ? `${k.slice(0, 7)}…${k.slice(-4)}` : null;

/** What the settings page may see: no keys, only hints. */
export function publicIntegrations() {
  const saved = loadIntegrations();
  const active = activeProvider(saved);
  const out = { provider: saved.provider || null, active: active && { name: active.name, label: active.label, model: active.model } };
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const k = keyFor(name, saved);
    out[name] = { label: p.label, configured: !!k.key, source: k.source, envVar: k.envVar || null, keyHint: hint(k.key), model: saved[name]?.model || p.defaultModel, defaultModel: p.defaultModel };
  }
  return out;
}

/**
 * Apply an update from the settings page. For each provider: apiKey (new key, blank = keep),
 * removeKey (forget the saved key), model. provider: 'claude' | 'openai' | 'none'.
 */
export function saveIntegrations(update) {
  const saved = loadIntegrations();
  if (update.provider !== undefined) {
    if (![...Object.keys(PROVIDERS), 'none'].includes(update.provider)) throw bad('unknown provider');
    saved.provider = update.provider;
  }
  for (const name of Object.keys(PROVIDERS)) {
    const u = update[name];
    if (!u) continue;
    saved[name] ??= {};
    if (u.removeKey) delete saved[name].apiKey;
    if (typeof u.apiKey === 'string' && u.apiKey.trim()) {
      const k = u.apiKey.trim();
      if (/\s/.test(k) || k.length < 20) throw bad(`That doesn't look like a ${PROVIDERS[name].label} API key`);
      saved[name].apiKey = k;
    }
    if (typeof u.model === 'string') {
      if (u.model && !/^[A-Za-z0-9._:\/-]{2,100}$/.test(u.model)) throw bad('invalid model name');
      saved[name].model = u.model.trim();
    }
  }
  if (saved.provider && saved.provider !== 'none' && !keyFor(saved.provider, saved).key) throw bad(`Add a ${PROVIDERS[saved.provider].label} API key before making it the active provider`);
  setJSON('integrations', saved);
  return publicIntegrations();
}
