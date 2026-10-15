// Structured (JSON-schema) calls to whichever AI provider is active in Settings → Integrations.
// Stable instructions + candidate context come first in every request so both providers
// can reuse their prompt cache across a batch of jobs.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { activeProvider, keyFor } from './integrations.js';

export function hasCredentials() { return !!activeProvider(); }
export function providerInfo() { const a = activeProvider(); return a ? { name: a.name, label: a.label, model: a.model } : null; }

const clients = new Map();
function client(name, key, source) {
  const id = `${name}:${key}`;
  if (!clients.has(id)) {
    clients.clear(); // keys changed; drop old clients
    if (name === 'claude') clients.set(id, source === 'env' ? new Anthropic() : new Anthropic({ apiKey: key }));
    else clients.set(id, new OpenAI({ apiKey: key }));
  }
  return clients.get(id);
}

/**
 * @param {object} o
 * @param {string} o.instructions  stable task instructions
 * @param {string} o.context       stable candidate context
 * @param {string} o.prompt        per-request content (job posting, questions…)
 * @param {object} o.schema        JSON schema for the reply (additionalProperties: false, all properties required)
 * @param {'low'|'medium'|'high'} [o.effort]
 */
export async function structured(o) {
  const p = activeProvider();
  if (!p) throw new Error('No AI provider is set up. Add a Claude or OpenAI key in Settings → Integrations.');
  return p.name === 'claude' ? claudeCall(p, o) : openaiCall(p, o);
}

async function claudeCall(p, { instructions, context, prompt, schema, effort = 'medium', maxTokens = 16000 }) {
  const res = await client('claude', p.key, p.source).beta.messages.create({
    model: p.model,
    max_tokens: maxTokens,
    // Re-run on Anthropic's recommended fallback model if a safety classifier declines.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [
      { type: 'text', text: instructions },
      { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  });
  if (res.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ''}`);
  }
  if (res.stop_reason === 'max_tokens') throw new Error('The reply was cut off (max_tokens); try again with a shorter posting');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { data: JSON.parse(text), usage: res.usage };
}

async function openaiCall(p, { instructions, context, prompt, schema, maxTokens = 16000 }) {
  const res = await client('openai', p.key).chat.completions.create({
    model: p.model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: `${instructions}\n\n${context}` },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: true } },
  });
  const choice = res.choices[0];
  if (choice.message.refusal) throw new Error(`OpenAI declined this request: ${choice.message.refusal}`);
  if (choice.finish_reason === 'length') throw new Error('The reply was cut off (token limit); try again with a shorter posting');
  if (choice.finish_reason === 'content_filter') throw new Error('OpenAI filtered this reply');
  return { data: JSON.parse(choice.message.content), usage: res.usage };
}

/** Check a key works and list the models it can use. `apiKey` overrides the saved/env key. */
export async function testProvider(name, apiKey) {
  const { key, source } = apiKey ? { key: apiKey, source: 'input' } : keyFor(name);
  if (!key) throw Object.assign(new Error('No API key to test — paste one first'), { status: 400 });
  const c = name === 'claude' ? (source === 'env' ? new Anthropic() : new Anthropic({ apiKey: key })) : new OpenAI({ apiKey: key });
  const ids = [];
  try {
    for await (const m of c.models.list()) { ids.push(m.id); if (ids.length >= 500) break; }
  } catch (e) {
    const status = e.status === 401 || e.status === 403 ? 400 : 502;
    throw Object.assign(new Error(e.status === 401 ? 'The key was rejected (401). Check that you copied all of it.' : `Could not reach ${name === 'claude' ? 'Anthropic' : 'OpenAI'}: ${e.message}`), { status });
  }
  const models = name === 'claude'
    ? ids.filter(id => id.startsWith('claude'))
    : ids.filter(id => /^(gpt-|o\d|chatgpt)/.test(id) && !/audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation/.test(id)).sort().reverse();
  return { ok: true, models };
}
