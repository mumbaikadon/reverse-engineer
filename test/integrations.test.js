import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Scratch config dir; no real keys from the environment; both SDKs pointed at a local fake API.
const dir = mkdtempSync(join(tmpdir(), 'applio-int-'));
process.env.APPLIO_CONFIG_DIR = dir;
for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'APPLIO_MODEL', 'APPLIO_OPENAI_MODEL']) delete process.env[v];

const seen = [];
const fake = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : null;
  seen.push({ path: req.url, auth: req.headers.authorization || req.headers['x-api-key'], body: json });
  res.setHeader('content-type', 'application/json');
  const authed = (req.headers['x-api-key'] || req.headers.authorization || '').includes('good');
  if (!authed) { res.statusCode = 401; return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
  if (req.url.startsWith('/v1/models')) {
    return res.end(JSON.stringify(req.headers['x-api-key']
      ? { data: [{ id: 'claude-opus-5-5', type: 'model' }, { id: 'claude-sonnet-5-5', type: 'model' }], has_more: false, first_id: 'a', last_id: 'b' }
      : { object: 'list', data: [{ id: 'gpt-test-1', object: 'model' }, { id: 'text-embedding-3', object: 'model' }, { id: 'gpt-test-1-audio', object: 'model' }] }));
  }
  if (req.url.startsWith('/v1/messages')) {
    return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: json.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer":"from claude"}' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: json.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"answer":"from openai"}', refusal: null } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
  res.statusCode = 404; res.end('{}');
});

let I, L;
before(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.OPENAI_BASE_URL = base + '/v1';
  I = await import('../src/integrations.js');
  L = await import('../src/llm.js');
});
after(() => fake.close());

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const call = () => L.structured({ instructions: 'Do it.', context: 'Candidate.', prompt: 'Q?', schema: SCHEMA, effort: 'low' });

test('no provider until a key is saved', async () => {
  assert.equal(L.hasCredentials(), false);
  await assert.rejects(call(), /Settings → Integrations/);
  assert.throws(() => I.saveIntegrations({ provider: 'openai' }), /Add a OpenAI API key/);
  assert.throws(() => I.saveIntegrations({ claude: { apiKey: 'short' } }), /doesn't look like/);
});

test('saving a Claude key activates Claude and never exposes the key', async () => {
  const key = 'sk-ant-good-0123456789abcdef';
  const pub = I.saveIntegrations({ claude: { apiKey: key, model: 'claude-opus-5-5' }, provider: 'claude' });
  assert.equal(pub.active.name, 'claude');
  assert.equal(pub.claude.keyHint, 'sk-ant-…cdef');
  assert.ok(!JSON.stringify(I.publicIntegrations()).includes(key), 'full key must not appear in public settings');
  assert.equal(JSON.parse(readFileSync(join(dir, 'integrations.json'), 'utf8')).claude.apiKey, key);

  const r = await call();
  assert.equal(r.data.answer, 'from claude');
  const req = seen.findLast(s => s.path.startsWith('/v1/messages'));
  assert.equal(req.auth, key);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.deepEqual(req.body.output_config.format, { type: 'json_schema', schema: SCHEMA });
  assert.equal(req.body.system[1].cache_control.type, 'ephemeral');
});

test('switching to OpenAI uses chat completions with a strict JSON schema', async () => {
  I.saveIntegrations({ openai: { apiKey: 'sk-good-openai-0123456789', model: 'gpt-test-1' }, provider: 'openai' });
  assert.equal(L.providerInfo().name, 'openai');
  const r = await call();
  assert.equal(r.data.answer, 'from openai');
  const req = seen.findLast(s => s.path.startsWith('/v1/chat/completions'));
  assert.equal(req.auth, 'Bearer sk-good-openai-0123456789');
  assert.equal(req.body.model, 'gpt-test-1');
  assert.deepEqual(req.body.response_format, { type: 'json_schema', json_schema: { name: 'result', schema: SCHEMA, strict: true } });
  assert.equal(req.body.messages[0].role, 'system');
  assert.match(req.body.messages[0].content, /Do it\.\n\nCandidate\./);
});

test('test connection lists usable models and reports bad keys', async () => {
  assert.deepEqual((await L.testProvider('claude')).models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual((await L.testProvider('openai')).models, ['gpt-test-1'], 'embedding/audio models are filtered out');
  await assert.rejects(L.testProvider('openai', 'sk-bad-key-0123456789'), /rejected \(401\)/);
});

test('removing the active provider key and turning AI off', () => {
  I.saveIntegrations({ openai: { removeKey: true }, provider: 'claude' });
  assert.equal(I.publicIntegrations().openai.configured, false);
  assert.equal(L.providerInfo().name, 'claude');
  I.saveIntegrations({ provider: 'none' });
  assert.equal(L.hasCredentials(), false);
});
