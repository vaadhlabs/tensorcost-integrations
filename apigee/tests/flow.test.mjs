// The two shared flows run step by step in lib/flow.mjs's stand-in proxy:
// each step's Condition evaluated, each policy run as its XML says, the
// JavaScript in node:vm. TensorCost and the model target are stubs.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closedVariant, newEnv, readBundle, runCall, runSharedFlow } from './lib/flow.mjs';
import { findSpec, loadSpec, validate } from '../../admit-mock/src/openapi.mjs';

const admit = readBundle('tensorcost-admit');
const usage = readBundle('tensorcost-usage');
const admitClosed = closedVariant(admit);

const DECISION_ID = '3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10';
const allow = (over = {}) => ({ decision: 'allow', decision_id: DECISION_ID, reason: null, message: null, reservation_cents: 6.68, attribution: { team: null, developer: null, unmapped: [] }, fail_mode: 'open', cache_ttl_seconds: 0, ...over });
const refuse = (over = {}) => ({
  decision: 'refuse',
  decision_id: DECISION_ID,
  reason: 'budget_hard_cap',
  message: 'TensorCost: Search team has reached its monthly AI budget ($20,000). Ask ana@acme.com to raise it.',
  reservation_cents: 6.68,
  attribution: { team: 'search', developer: null, unmapped: [] },
  fail_mode: 'open',
  cache_ttl_seconds: 0,
  ...over,
});
const json = (status, body, headers = {}) => ({ status, body: JSON.stringify(body), headers });

// Every row any test below makes the flows send, checked against the
// contract's GatewayLogRow once they have all run.
const ROWS = [];

/** TensorCost's stub: admit answers `admitAnswer`; logs and cancel answer 200. */
function tensorcost(admitAnswer) {
  return (req) => {
    if (req.url.endsWith('/v1/gateway/admit')) return typeof admitAnswer === 'function' ? admitAnswer(req) : admitAnswer;
    if (req.url.includes('/v1/gateway/logs')) ROWS.push(...JSON.parse(req.body));
    return { status: 200, body: '{}' };
  };
}

after(() => {
  const spec = loadSpec(findSpec());
  const row = { $ref: '#/components/schemas/GatewayLogRow' };
  assert.ok(ROWS.length >= 5, `only ${ROWS.length} rows were sent`);
  for (const r of ROWS) {
    assert.deepEqual(validate(spec, row, r), [], JSON.stringify(r));
    // quota_used_count is the flows' own figure for the product quota; TensorCost ignores it.
    const extra = Object.keys(r).filter((k) => !(k in spec.components.schemas.GatewayLogRow.properties));
    assert.deepEqual(extra.filter((k) => k !== 'quota_used_count'), [], JSON.stringify(r));
  }
});

const OPENAI_OK = { status: 200, body: JSON.stringify({ id: 'chatcmpl-1', model: 'gpt-4o-2024-08-06', choices: [{ message: { content: 'SECRET ANSWER' } }], usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } } }) };
const target = (answer = OPENAI_OK) => () => answer;

// What VerifyAPIKey leaves behind. client_id is the app's API key: it must never leave the gateway.
const API_KEY = 'consumer-key-of-search-bot';
const VERIFIED = {
  client_id: API_KEY,
  'request.queryparam.apikey': API_KEY,
  'request.header.x-apikey': API_KEY,
  'verifyapikey.VerifyAPIKey.client_id': API_KEY,
  'verifyapikey.VerifyAPIKey.developer.app.name': 'search-bot',
  'developer.id': 'dev-uuid-1',
  'verifyapikey.VerifyAPIKey.apiproduct.name': 'search-product',
};

const admitsSent = (env) => env.sent.filter((r) => r.url.endsWith('/v1/gateway/admit'));
const rowsSent = (env) => env.sent.filter((r) => r.url.includes('/v1/gateway/logs')).map((r) => JSON.parse(r.body));
const cancelsSent = (env) => env.sent.filter((r) => r.url.endsWith('/cancel'));

test('a 200 refuse raises the 429 with TensorCost\'s message, and the target is never called', () => {
  const env = newEnv(tensorcost(json(200, refuse())));
  const out = runCall({ admit, usage, env, request: VERIFIED, target: target() });
  assert.equal(out.targetCalled, false);
  assert.equal(out.fault.status, 429);
  const body = JSON.parse(out.fault.body);
  assert.equal(body.error.type, 'budget_exceeded');
  assert.equal(body.error.message, refuse().message);
  assert.equal(body.error.reason, 'budget_hard_cap');
  assert.equal(out.fault.headers['Retry-After'], undefined);
  // Never reached the target: no log row, and a refusal holds nothing to cancel.
  assert.deepEqual(rowsSent(env), []);
  assert.deepEqual(cancelsSent(env), []);
});

test('a refusal is still a refusal under continueOnError="true" (fail open): decision decides, not the status', () => {
  // Review Focus 3: the same 200 body through the open bundle, whose callout swallows errors.
  const env = newEnv(tensorcost(json(200, refuse({ retry_after_seconds: 3600 }))));
  const out = runCall({ admit, usage, env, request: VERIFIED, target: target() });
  assert.equal(out.fault.status, 429);
  assert.equal(out.fault.headers['Retry-After'], '3600');
  assert.equal(JSON.parse(out.fault.body).error.retry_after_seconds, 3600);
});

test('a body that says refuse with a non-200 status is no answer: open lets the call through', () => {
  for (const status of [401, 429, 503]) {
    const env = newEnv(tensorcost(json(status, refuse())));
    const out = runCall({ admit, usage, env, request: VERIFIED, target: target() });
    assert.equal(out.fault, null, `status ${status}`);
    assert.equal(out.targetCalled, true);
  }
});

test('open: a timeout lets the call through; closed: the same timeout ends it before the target', () => {
  const env = newEnv(tensorcost({ timeout: true }));
  const out = runCall({ admit, usage, env, request: VERIFIED, target: target() });
  assert.equal(out.targetCalled, true);
  assert.equal(out.fault, null);

  const env2 = newEnv(tensorcost({ timeout: true }));
  const closed = runCall({ admit: admitClosed, usage, env: env2, request: VERIFIED, target: target() });
  assert.equal(closed.targetCalled, false);
  assert.ok(closed.fault, 'closed faults');
  assert.deepEqual(rowsSent(env2), []);
});

test('closed: a 200 that isn\'t a decision refuses with 503, and check_unavailable refuses with 503 and its Retry-After', () => {
  const env = newEnv(tensorcost({ status: 200, body: 'not json' }));
  const out = runCall({ admit: admitClosed, usage, env, request: VERIFIED, target: target() });
  assert.equal(out.fault.status, 503);
  assert.equal(JSON.parse(out.fault.body).error.type, 'budget_check_unavailable');

  const env2 = newEnv(tensorcost(json(200, refuse({ reason: 'check_unavailable', message: null, detail: 'throttled', retry_after_seconds: 12 }))));
  const out2 = runCall({ admit, usage, env: env2, request: VERIFIED, target: target() });
  assert.equal(out2.fault.status, 503);
  assert.equal(out2.fault.headers['Retry-After'], '12');
});

test('the fail mode TensorCost last sent decides a later call it can\'t answer', () => {
  let answer = json(200, allow({ fail_mode: 'closed' }), { 'x-tc-fail-mode': 'closed' });
  const env = newEnv(tensorcost(() => answer));
  assert.equal(runCall({ admit, usage, env, request: VERIFIED, target: target() }).fault, null);
  answer = { timeout: true };
  const out = runCall({ admit, usage, env, request: VERIFIED, target: target() });
  assert.equal(out.targetCalled, false);
  assert.equal(out.fault.status, 503);
});

test('a throttled 200 is a decision: an open allow goes through, a closed refusal refuses', () => {
  const env = newEnv(tensorcost(json(200, allow({ degraded: true, detail: 'throttled', reservation_cents: 0 }))));
  assert.equal(runCall({ admit, usage, env, request: VERIFIED, target: target() }).targetCalled, true);
  const env2 = newEnv(tensorcost(json(200, refuse({ reason: 'check_unavailable', detail: 'throttled', message: null }))));
  assert.equal(runCall({ admit, usage, env: env2, request: VERIFIED, target: target() }).fault.status, 503);
});

test('the correlation id is Apigee\'s messageid: the caller\'s header is overwritten, and admit and the row carry the same id', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  const out = runCall({ admit, usage, env, request: { ...VERIFIED, 'request.header.x-tensorcost-correlation-id': 'someone-elses-call' }, target: target() });
  const id = out.vars.messageid;
  assert.equal(out.targetRequest.headers['x-tensorcost-correlation-id'], id);
  assert.equal(JSON.parse(admitsSent(env)[0].body).correlation_id, id);
  const [[row]] = rowsSent(env);
  assert.equal(row.log_id, id);
  assert.equal(row.correlation_id, id);
});

test('admit is sent the callers, model, max_tokens and stream, and never the prompt', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  runCall({ admit, usage, env, request: VERIFIED, target: target() });
  const [req] = admitsSent(env);
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, 'Bearer tcgw_test_key');
  assert.equal(req.timeoutMs, 1000);
  const body = JSON.parse(req.body);
  assert.deepEqual(body.callers, [{ kind: 'app', id: 'dev-uuid-1/search-bot' }, { kind: 'developer', id: 'dev-uuid-1' }, { kind: 'product', id: 'search-product' }]);
  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.max_tokens, 256);
  assert.equal(body.gateway.kind, 'apigee');
  assert.equal(body.can_reroute, undefined);
  assert.doesNotMatch(req.body, /SECRET PROMPT|messages/);
});

test('x-tc-customer goes to admit and onto the row; one customer\'s cached allow never covers another\'s', () => {
  const env = newEnv(tensorcost(json(200, allow({ cache_ttl_seconds: 5, reservation_cents: 0 }))));
  runCall({ admit, usage, env, request: { ...VERIFIED, 'request.header.x-tc-customer': ' acme ' }, target: target() });
  runCall({ admit, usage, env, request: { ...VERIFIED, 'request.header.x-tc-customer': 'acme' }, target: target() });
  runCall({ admit, usage, env, request: { ...VERIFIED, 'request.header.x-tc-customer': 'globex' }, target: target() });
  runCall({ admit, usage, env, request: VERIFIED, target: target() });
  runCall({ admit, usage, env, request: { ...VERIFIED, 'request.header.x-tc-customer': 'x'.repeat(129) }, target: target() });
  // The second acme call reuses the first's cached allow; globex and no customer each ask. A
  // too-long customer is no customer, so it reuses the allow the call with none was given.
  assert.deepEqual(admitsSent(env).map((r) => JSON.parse(r.body).customer), ['acme', 'globex', undefined]);
  assert.deepEqual(rowsSent(env).map((rows) => rows[0].customer), ['acme', 'acme', 'globex', undefined, undefined]);
});

test('the API product is a caller on admit and on the row, so an apigee_product alias decides its team', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  runCall({ admit, usage, env, request: VERIFIED, target: target() });
  const admitProduct = JSON.parse(admitsSent(env)[0].body).callers.find((c) => c.kind === 'product');
  const rowProduct = rowsSent(env)[0][0].callers.find((c) => c.kind === 'product');
  assert.deepEqual(admitProduct, { kind: 'product', id: 'search-product' });
  assert.deepEqual(rowProduct, admitProduct);
});

test('one developer rule on both sides: the email when VerifyAPIKey has it, else developer.id', () => {
  for (const [extra, want] of [[{ 'verifyapikey.VerifyAPIKey.developer.email': 'ana@acme.com' }, 'ana@acme.com'], [{}, 'dev-uuid-1']]) {
    const env = newEnv(tensorcost(json(200, allow())));
    runCall({ admit, usage, env, request: { ...VERIFIED, ...extra }, target: target() });
    const admitDev = JSON.parse(admitsSent(env)[0].body).callers.find((c) => c.kind === 'developer').id;
    const rowDev = rowsSent(env)[0][0].callers.find((c) => c.kind === 'developer').id;
    assert.equal(admitDev, want);
    assert.equal(rowDev, want);
  }
});

test('reroute rewrites the body\'s model only; the row reports the model that ran', () => {
  const env = newEnv(tensorcost(json(200, { ...allow(), decision: 'reroute', model: 'gpt-4o-mini', route: { policy_id: 'p', from_model: 'gpt-4o', to_model: 'gpt-4o-mini' } })));
  const out = runCall({ admit, usage, env, request: VERIFIED, target: target() });
  const sent = JSON.parse(out.targetRequest.body);
  assert.equal(sent.model, 'gpt-4o-mini');
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'SECRET PROMPT' }]);
  assert.equal(rowsSent(env)[0][0].model, 'gpt-4o-mini');
});

test('a Vertex path names a fixed model: can_reroute false, and a reroute answer rewrites nothing', () => {
  const request = { ...VERIFIED, 'request.path': '/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent', 'request.content': JSON.stringify({ contents: [{ parts: [{ text: 'SECRET PROMPT' }] }], generationConfig: { maxOutputTokens: 512 } }) };
  const env = newEnv(tensorcost(json(200, { ...allow(), decision: 'reroute', model: 'gemini-2.5-flash-lite' })));
  const vertex = { status: 200, body: JSON.stringify({ responseId: 'r-1', candidates: [], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 10, cachedContentTokenCount: 30 } }) };
  const out = runCall({ admit, usage, env, request, target: target(vertex) });
  const body = JSON.parse(admitsSent(env)[0].body);
  assert.equal(body.model, 'gemini-2.5-flash');
  assert.equal(body.can_reroute, false);
  assert.equal(body.provider, 'gcp.vertex_ai');
  assert.equal(body.max_tokens, 512);
  assert.equal(out.targetRequest.body, request['request.content']);
  const [[row]] = rowsSent(env);
  assert.deepEqual([row.model, row.provider, row.input_tokens, row.output_tokens, row.cached_input_tokens, row.provider_response_id], ['gemini-2.5-flash', 'gcp.vertex_ai', 100, 50, 30, 'r-1']);
});

test('an allow is cached only for cache_ttl_seconds, and only when nothing was reserved or degraded', () => {
  const cases = [
    [allow({ cache_ttl_seconds: 5, reservation_cents: 0 }), 1],
    [allow({ cache_ttl_seconds: 5, reservation_cents: 0.5 }), 2],
    [allow({ cache_ttl_seconds: 0, reservation_cents: 0 }), 2],
    [allow({ cache_ttl_seconds: 5, reservation_cents: 0, degraded: true }), 2],
    [allow({ cache_ttl_seconds: 5, reservation_cents: 0, fail_mode_known: false }), 2],
  ];
  for (const [answer, admits] of cases) {
    const env = newEnv(tensorcost(json(200, answer)));
    runCall({ admit, usage, env, request: VERIFIED, target: target() });
    runCall({ admit, usage, env, request: VERIFIED, target: target() });
    assert.equal(admitsSent(env).length, admits, JSON.stringify(answer));
  }
  // A refusal is never cached.
  const env = newEnv(tensorcost(json(200, refuse({ cache_ttl_seconds: 5, reservation_cents: 0 }))));
  runCall({ admit, usage, env, request: VERIFIED, target: target() });
  runCall({ admit, usage, env, request: VERIFIED, target: target() });
  assert.equal(admitsSent(env).length, 2);
});

test('the usage row posts the six values in the tensorcost log format, and no content', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  runCall({ admit, usage, env, request: { ...VERIFIED, 'verifyapikey.VerifyAPIKey.apiproduct.tensorcost_llm_quota': '1000000' }, target: target() });
  const [log] = env.sent.filter((r) => r.url.includes('/v1/gateway/logs'));
  assert.equal(log.url, 'https://tensorcost.example.com/api/inference-proxy/v1/gateway/logs?format=tensorcost');
  assert.equal(log.waited, false);
  assert.equal(log.headers.authorization, 'Bearer tcgw_test_key');
  const [row] = JSON.parse(log.body);
  // ratelimit.TC-TokenCount.used.count, llmtokenquota.TC-TokenCount.model, the developer, the app, messageid, the target's status.
  assert.equal(row.quota_used_count, 1500);
  assert.equal(row.model, 'gpt-4o');
  assert.deepEqual(row.callers, [{ kind: 'app', id: 'dev-uuid-1/search-bot' }, { kind: 'developer', id: 'dev-uuid-1' }, { kind: 'product', id: 'search-product' }]);
  assert.match(row.log_id, /^rrt-/);
  assert.equal(row.upstream_status, 200);
  assert.equal(row.status, 200);
  // Tokens in the row convention: input_tokens counts cached input too.
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cached_input_tokens, row.cache_write_tokens], [1200, 300, 200, 0]);
  assert.equal(row.provider, 'openai');
  assert.equal(row.provider_response_id, 'chatcmpl-1');
  assert.ok(!Number.isNaN(Date.parse(row.started_at)) && !Number.isNaN(Date.parse(row.ended_at)));
  const allowed = ['log_id', 'correlation_id', 'provider', 'model', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'provider_response_id', 'started_at', 'ended_at', 'callers', 'status', 'upstream_status', 'quota_used_count', 'customer'];
  for (const k of Object.keys(row)) assert.ok(allowed.includes(k), k);
  assert.doesNotMatch(log.body, /SECRET/);
});

test('Anthropic usage: cache reads and writes are added to input_tokens', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  const body = { id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'SECRET ANSWER' }], usage: { input_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 80 } };
  runCall({ admit, usage, env, request: { ...VERIFIED, 'tensorcost.provider': 'anthropic' }, target: target({ status: 200, body: JSON.stringify(body) }) });
  const [[row]] = rowsSent(env);
  assert.deepEqual([row.input_tokens, row.cached_input_tokens, row.cache_write_tokens, row.output_tokens, row.provider], [1250, 1000, 200, 80, 'anthropic']);
});

test('a pushed product quota refuses before the check once the counter is full, and counts each call\'s tokens', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  const request = { ...VERIFIED, 'verifyapikey.VerifyAPIKey.apiproduct.tensorcost_llm_quota': '2000' };
  assert.equal(runCall({ admit, usage, env, request, target: target() }).fault, null); // 1,500 counted
  assert.equal(runCall({ admit, usage, env, request, target: target() }).fault, null); // 3,000 counted
  const out = runCall({ admit, usage, env, request, target: target() });
  // TensorCost's own refusal, naming the product and who can raise the budget, not Apigee's generic quota fault.
  assert.equal(out.fault.faultName, 'RaiseFault');
  assert.equal(out.fault.status, 429);
  const refusal = JSON.parse(out.fault.body).error;
  assert.equal(refusal.type, 'budget_exceeded');
  assert.equal(refusal.reason, 'gateway_quota');
  assert.match(refusal.message, /API product search-product has used the token quota .* A TensorCost admin, or the budget's owner, can raise the budget\./);
  assert.equal(admitsSent(env).length, 2, 'the refused call never asked TensorCost');
  // A new pushed value is a new count.
  const fresh = runCall({ admit, usage, env, request: { ...request, 'verifyapikey.VerifyAPIKey.apiproduct.tensorcost_llm_quota': '1999' }, target: target() });
  assert.equal(fresh.fault, null);
  // No attribute: nothing enforced.
  const env2 = newEnv(tensorcost(json(200, allow())));
  for (let i = 0; i < 3; i++) assert.equal(runCall({ admit, usage, env: env2, request: VERIFIED, target: target() }).fault, null);
});

test('an allowed call a later policy refuses never reached the target: its hold is cancelled and no row is sent', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  const out = runCall({ admit, usage, env, request: VERIFIED, target: target(), refuseAfterAdmit: true });
  assert.equal(out.targetCalled, false);
  const cancels = cancelsSent(env);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].url, `https://tensorcost.example.com/api/inference-proxy/v1/gateway/admit/${DECISION_ID}/cancel`);
  assert.equal(cancels[0].waited, false);
  assert.deepEqual(rowsSent(env), []);
});

test('a call that reached the target is never cancelled, whatever came back', () => {
  for (const answer of [{ timeout: true }, { status: 500, body: '{"error":"boom"}' }, OPENAI_OK]) {
    const env = newEnv(tensorcost(json(200, allow())));
    runCall({ admit, usage, env, request: VERIFIED, target: target(answer) });
    assert.deepEqual(cancelsSent(env), [], JSON.stringify(answer));
    assert.equal(rowsSent(env).length, 1);
  }
});

test('upstream_status is the target\'s own status, and absent when the target never answered', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  runCall({ admit, usage, env, request: VERIFIED, target: target({ status: 429, body: '{"error":{"type":"rate_limit"}}' }) });
  const [[limited]] = rowsSent(env);
  assert.equal(limited.upstream_status, 429);
  assert.equal(limited.input_tokens, 0);

  const env2 = newEnv(tensorcost(json(200, allow())));
  runCall({ admit, usage, env: env2, request: VERIFIED, target: target({ timeout: true }) });
  const [[timedOut]] = rowsSent(env2);
  assert.equal(timedOut.upstream_status, undefined);
  assert.equal(timedOut.status, 504);
});

test('the usage flow runs once a call even when both the response flow and the fault rule include it', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  const out = runCall({ admit, usage, env, request: VERIFIED, target: target() });
  // A policy after it in the response flow faults: the DefaultFaultRule includes the flow again.
  out.vars['fault.name'] = 'RaiseFault';
  const before = env.sent.length;
  runSharedFlow(usage, out.vars, env);
  assert.equal(env.sent.length, before);
});

test('nothing sent to TensorCost holds the app\'s API key, on any path through either flow', () => {
  const scenarios = [
    [json(200, allow({ cache_ttl_seconds: 5, reservation_cents: 0 })), target(), false],
    [json(200, refuse()), target(), false],
    [json(200, { ...allow(), decision: 'reroute', model: 'gpt-4o-mini' }), target(), false],
    [{ timeout: true }, target({ status: 500, body: '{"error":"x"}' }), false],
    [json(200, allow()), target({ timeout: true }), false],
    [json(200, allow()), target(), true],
  ];
  const sent = [];
  for (const [answer, tgt, refuseAfterAdmit] of scenarios) {
    const env = newEnv(tensorcost(answer));
    runCall({ admit, usage, env, request: VERIFIED, target: tgt, refuseAfterAdmit });
    sent.push(...env.sent);
  }
  // Six admits, four rows (a refused call sends none) and one cancel.
  assert.equal(sent.length, 11);
  for (const r of sent) {
    const all = r.url + ' ' + JSON.stringify(r.headers) + ' ' + r.body;
    assert.ok(!all.includes(API_KEY), `${r.policy} sent the API key: ${all.slice(0, 200)}`);
    assert.doesNotMatch(all, /client_id|(?<!verify)apikey/i, r.policy);
  }
});

test('the scripts never read client_id or an apikey variable', () => {
  for (const files of [admit, usage]) {
    for (const [p, c] of Object.entries(files)) {
      if (!p.endsWith('.js')) continue;
      // verifyapikey.{policy}.* are VerifyAPIKey's own variable names, not a key.
      assert.doesNotMatch(c.replace(/\/\*[\s\S]*?\*\//g, ''), /client_id|(?<!verify)apikey/i, p);
    }
  }
});

// ------------------------------------------------------------------ streamed responses

const sse = (events) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const OPENAI_STREAM = [
  { id: 'chatcmpl-9', object: 'chat.completion.chunk', choices: [{ delta: { content: 'SECRET' } }] },
  { id: 'chatcmpl-9', object: 'chat.completion.chunk', choices: [{ delta: { content: ' ANSWER' } }] },
  { id: 'chatcmpl-9', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 900, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 100 } } },
  '[DONE]',
];
const ANTHROPIC_STREAM = [
  { type: 'message_start', message: { id: 'msg_7', usage: { input_tokens: 40, cache_read_input_tokens: 600, cache_creation_input_tokens: 60, output_tokens: 1 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SECRET ANSWER' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 75 } },
  { type: 'message_stop' },
];
// Gemini's usageMetadata on each chunk is the total so far.
const GEMINI_STREAM = [
  { responseId: 'g-3', candidates: [{ content: { parts: [{ text: 'SECRET' }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 10 } },
  { responseId: 'g-3', candidates: [{ content: { parts: [{ text: 'ANSWER' }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 50, thoughtsTokenCount: 20, cachedContentTokenCount: 100 } },
];
const streamLogs = (env) => env.sent.filter((r) => r.policy === 'TC-StreamLog');

test('a buffered event stream (streaming off) is read for its usage: OpenAI with include_usage, Anthropic, and a Vertex chunk array', () => {
  const cases = [
    [{ status: 200, contentType: 'text/event-stream', body: sse(OPENAI_STREAM) }, [900, 120, 100, 0, 'chatcmpl-9']],
    [{ status: 200, contentType: 'text/event-stream', body: sse(ANTHROPIC_STREAM) }, [700, 75, 600, 60, 'msg_7']],
    [{ status: 200, body: JSON.stringify(GEMINI_STREAM) }, [300, 70, 100, 0, 'g-3']],
  ];
  for (const [answer, want] of cases) {
    const env = newEnv(tensorcost(json(200, allow())));
    runCall({ admit, usage, env, request: { ...VERIFIED, 'request.content': JSON.stringify({ model: 'gpt-4o', stream: true }) }, target: target(answer) });
    const [[row]] = rowsSent(env);
    assert.deepEqual([row.input_tokens, row.output_tokens, row.cached_input_tokens, row.cache_write_tokens, row.provider_response_id], want);
    assert.equal(row.upstream_status, 200);
    assert.deepEqual(streamLogs(env), [], 'a buffered stream is reported by the usage flow itself');
  }
});

test('streaming on: the EventFlow counts each event\'s usage, and the PostClientFlow sends one row with the totals', () => {
  for (const [events, want] of [[GEMINI_STREAM.map((e) => JSON.stringify(e)), [300, 70, 100, 0, 'g-3']], [ANTHROPIC_STREAM.map((e) => JSON.stringify(e)), [700, 75, 600, 60, 'msg_7']], [OPENAI_STREAM.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))), [900, 120, 100, 0, 'chatcmpl-9']]]) {
    const env = newEnv(tensorcost(json(200, allow())));
    const request = { ...VERIFIED, 'verifyapikey.VerifyAPIKey.apiproduct.tensorcost_llm_quota': '1000000', 'request.content': JSON.stringify({ model: 'gpt-4o', stream: true }) };
    const out = runCall({ admit, usage, env, request, target: target({ status: 200, events }) });
    assert.equal(out.events, events.length);
    // The usage flow sends nothing for a stream; the PostClientFlow sends the one row.
    assert.deepEqual(rowsSent(env).length, 1);
    const [log] = streamLogs(env);
    assert.equal(log.waited, false);
    assert.equal(log.url, 'https://tensorcost.example.com/api/inference-proxy/v1/gateway/logs?format=tensorcost');
    assert.equal(log.headers.authorization, 'Bearer tcgw_test_key');
    const [row] = JSON.parse(log.body);
    assert.deepEqual([row.input_tokens, row.output_tokens, row.cached_input_tokens, row.cache_write_tokens, row.provider_response_id], want);
    assert.equal(row.log_id, out.vars.messageid);
    assert.equal(row.upstream_status, 200);
    assert.deepEqual(row.callers.map((c) => c.kind), ['app', 'developer', 'product']);
    assert.doesNotMatch(log.body, /SECRET/);
    // The product quota counted the call's whole total once, event by event.
    assert.equal(env.counters.get('tensorcost-llm-tokens|tensorcost:search-product:1000000'), want[0] + want[1]);
  }
});

test('a stream with no usage in it still sends its row, so the call books the admit estimate rather than vanishing', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  runCall({ admit, usage, env, request: VERIFIED, target: target({ status: 200, events: ['{"choices":[{"delta":{"content":"hi"}}]}', '[DONE]'] }) });
  const [log] = streamLogs(env);
  const [row] = JSON.parse(log.body);
  assert.deepEqual([row.input_tokens, row.output_tokens, row.upstream_status], [0, 0, 200]);
});

test('a path that names the model is checked as it and never rerouted: Azure deployments and Bedrock model ids', () => {
  const cases = [
    ['/openai/deployments/gpt-4o-prod/chat/completions', JSON.stringify({ model: 'gpt-4o-mini', messages: [] }), 'gpt-4o-prod', 'azure.ai.openai'],
    ['/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse', JSON.stringify({ messages: [] }), 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'aws.bedrock'],
  ];
  for (const [path, body, model, provider] of cases) {
    const env = newEnv(tensorcost(json(200, { ...allow(), decision: 'reroute', model: 'cheaper-model' })));
    const out = runCall({ admit, usage, env, request: { ...VERIFIED, 'request.path': path, 'request.content': body }, target: target() });
    const sent = JSON.parse(admitsSent(env)[0].body);
    assert.deepEqual([sent.model, sent.can_reroute, sent.provider], [model, false, provider], path);
    assert.equal(out.targetRequest.body, body, 'the body is not rewritten');
  }
});

test('Bedrock Converse usage is read in the row convention', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  const body = { output: { message: { content: [{ text: 'SECRET ANSWER' }] } }, usage: { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 500, cacheWriteInputTokens: 20 } };
  runCall({ admit, usage, env, request: { ...VERIFIED, 'request.path': '/model/amazon.nova-pro-v1%3A0/converse' }, target: target({ status: 200, body: JSON.stringify(body) }) });
  const [[row]] = rowsSent(env);
  assert.deepEqual([row.input_tokens, row.cached_input_tokens, row.cache_write_tokens, row.output_tokens, row.provider], [550, 500, 20, 12, 'aws.bedrock']);
});

test('with no pushed quota the product counter isn\'t touched', () => {
  const env = newEnv(tensorcost(json(200, allow())));
  runCall({ admit, usage, env, request: VERIFIED, target: target() });
  assert.equal(env.counters.size, 0);
  assert.equal(rowsSent(env)[0][0].quota_used_count, undefined);
});

test('an app is named with its owner, so two developers\' same-named apps are two callers, on admit and on the row', () => {
  const ids = [];
  for (const email of ['ana@acme.com', 'bo@acme.com']) {
    const env = newEnv(tensorcost(json(200, allow())));
    runCall({ admit, usage, env, request: { ...VERIFIED, 'verifyapikey.VerifyAPIKey.developer.app.name': 'chatbot', 'verifyapikey.VerifyAPIKey.developer.email': email }, target: target() });
    const onAdmit = JSON.parse(admitsSent(env)[0].body).callers.find((c) => c.kind === 'app').id;
    const onRow = rowsSent(env)[0][0].callers.find((c) => c.kind === 'app').id;
    assert.equal(onAdmit, `${email}/chatbot`);
    assert.equal(onRow, onAdmit);
    ids.push(onAdmit);
  }
  assert.notEqual(ids[0], ids[1]);
  // With no owner known, no app caller at all rather than a name another developer's app shares.
  const env = newEnv(tensorcost(json(200, allow())));
  const { 'developer.id': _dropped, ...noOwner } = VERIFIED;
  runCall({ admit, usage, env, request: noOwner, target: target() });
  assert.equal(JSON.parse(admitsSent(env)[0].body).callers.find((c) => c.kind === 'app'), undefined);
});
