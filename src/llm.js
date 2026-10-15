// Thin wrapper around the Claude Messages API for structured (JSON-schema) calls.
// The candidate's résumé + profile go in a cached system block, so tailoring many
// jobs in a row only pays full price for that context once.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.APPLIO_MODEL || 'claude-opus-5-5';

let client;
export function hasCredentials() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
function getClient() {
  return (client ??= new Anthropic());
}

/**
 * @param {object} o
 * @param {string} o.instructions  stable task instructions (cached)
 * @param {string} o.context       stable candidate context (cached)
 * @param {string} o.prompt        per-request content (job posting, questions…)
 * @param {object} o.schema        JSON schema for the reply (additionalProperties: false everywhere)
 * @param {'low'|'medium'|'high'} [o.effort]
 */
export async function structured({ instructions, context, prompt, schema, effort = 'medium', maxTokens = 16000 }) {
  const res = await getClient().beta.messages.create({
    model: MODEL,
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
  if (res.stop_reason === 'max_tokens') throw new Error('Claude reply was cut off (max_tokens); try again with a shorter posting');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { data: JSON.parse(text), usage: res.usage };
}
