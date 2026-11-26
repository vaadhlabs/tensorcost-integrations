// The mock's answers are checked against the admit OpenAPI file this
// repository exports (spec/admit/openapi.yaml), with every field it sends
// required to be one the file names.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from '../src/server.mjs';
import { findSpec, loadSpec, operationSchemas, parseYaml, validate } from '../src/openapi.mjs';

const KEY = 'tcgw_mock_key';
const SPEC_PATH = findSpec();
let spec;
let admitOp;
let cancelOp;
let mock;
let url;

before(async () => {
  assert.ok(SPEC_PATH, 'the admit OpenAPI file must be findable for these tests');
  spec = loadSpec(SPEC_PATH);
  admitOp = operationSchemas(spec, 'gatewayAdmit');
  cancelOp = operationSchemas(spec, 'gatewayAdmitCancel');
  mock = createMock({ spec: SPEC_PATH, slowMs: 300 });
  url = await mock.listen(0);
});

after(() => mock.close());
beforeEach(() => mock.reset('open'));

function body(callerId, extra = {}) {
  return {
    gateway: { kind: 'litellm', instance: 'prod-eu' },
    callers: [{ kind: 'team', id: callerId }, { kind: 'user', id: 'ana@acme.com' }],
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    input_tokens: 2000,
    accepts_models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    ...extra,
  };
}

async function admit(b, { key = KEY, path = '/v1/gateway/admit', raw } = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: raw ?? JSON.stringify(b),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

async function cancel(id, key = KEY) {
  const res = await fetch(`${url}/v1/gateway/admit/${id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
  return { status: res.status, json: await res.json() };
}

function assertValidAnswer(json) {
  assert.deepEqual(validate(spec, admitOp.responses['200'], json, { strict: true }), []);
  const last = mock.log.admits.at(-1);
  assert.deepEqual(last.response_errors, []);
  assert.deepEqual(last.request_errors, []);
}

test('the reader takes the OpenAPI file as YAML would, and the file\'s own examples validate', () => {
  assert.equal(spec.openapi, '3.1.0');
  const examples = spec.paths['/gateway/admit'].post.responses['200'].content['application/json'].examples;
  assert.deepEqual(Object.keys(examples).sort(), ['allow', 'degraded', 'refuse', 'reroute']);
  for (const [name, ex] of Object.entries(examples)) {
    assert.deepEqual(validate(spec, admitOp.responses['200'], ex.value, { strict: true }), [], name);
  }
  const reqExample = spec.paths['/gateway/admit'].post.requestBody.content['application/json'].example;
  assert.deepEqual(validate(spec, admitOp.request, reqExample, { strict: true }), []);
});

test('the reader refuses YAML it does not cover instead of guessing', () => {
  assert.throws(() => parseYaml('a: &x 1\nb: *x\n'), /unsupported/);
  assert.throws(() => parseYaml('a: one\n  two\n'), /multi-line/);
  assert.throws(() => parseYaml('a: { b: c, d }\n'), /expected ":"/);
  assert.throws(() => validate({}, { anyOf: [] }, 1), /not supported/);
  assert.throws(() => validate({}, { oneOf: [], type: 'string' }, 1), /not supported/);
});

test('a plain caller gets an allow that holds its reservation and is never cacheable', async () => {
  const r = await admit(body('team-search'));
  assert.equal(r.status, 200);
  assert.equal(r.json.decision, 'allow');
  assert.equal(r.json.reservation_cents, 2.1); // (2000 x 0.3 + 1000 x 1.5) / 1000
  assert.equal(r.json.reservation_kind, 'worst_case');
  assert.equal(r.json.cache_ttl_seconds, 0);
  assert.equal(r.headers.get('x-tc-fail-mode'), 'open');
  assert.equal(r.headers.get('x-tc-decision'), 'layer=govern; action=allow');
  assert.deepEqual(r.json.attribution, { team: null, developer: 'ana@acme.com', unmapped: ['litellm_team:prod-eu/team-search'] });
  assertValidAnswer(r.json);
});

test('refuse-* is a 200 refusal that names the budget and who can raise it', async () => {
  const r = await admit(body('refuse-search'));
  assert.equal(r.status, 200);
  assert.equal(r.json.decision, 'refuse');
  assert.equal(r.json.reason, 'budget_hard_cap');
  assert.match(r.json.message, /Search team/);
  assert.match(r.json.message, /ana@acme\.com/);
  assert.equal(r.json.cache_ttl_seconds, 0);
  assert.equal(r.headers.get('x-tc-decision'), 'layer=govern; action=refuse; reason=budget_hard_cap');
  assertValidAnswer(r.json);

  const gov = await admit(body('refuse-model_governance_denied'));
  assert.equal(gov.json.reason, 'model_governance_denied');
  assertValidAnswer(gov.json);
});

test('reroute-* names a model the gateway listed, and only to a gateway that can follow it', async () => {
  const r = await admit(body('reroute-claude-haiku-4-5'));
  assert.equal(r.json.decision, 'reroute');
  assert.equal(r.json.model, 'claude-haiku-4-5');
  assert.deepEqual({ from: r.json.route.from_model, to: r.json.route.to_model }, { from: 'claude-sonnet-4-5', to: 'claude-haiku-4-5' });
  assert.equal(r.json.cache_ttl_seconds, 0);
  assertValidAnswer(r.json);

  // can_reroute false, a gateway kind that can't rewrite the model, or no listed model: allowed as asked.
  for (const b of [
    body('reroute-claude-haiku-4-5', { can_reroute: false }),
    body('reroute-claude-haiku-4-5', { gateway: { kind: 'kong' }, callers: [{ kind: 'consumer', id: 'reroute-claude-haiku-4-5' }] }),
    body('reroute-claude-haiku-4-5', { accepts_models: ['claude-sonnet-4-5'] }),
  ]) {
    const a = await admit(b);
    assert.equal(a.json.decision, 'allow');
    assert.equal(a.json.cache_ttl_seconds, 0);
    assertValidAnswer(a.json);
  }
});

test('accepts_models may name deployments: a reroute answers the name, and the request still validates', async () => {
  const deployments = [
    { name: 'prod-sonnet', model: 'claude-sonnet-4-5', provider: 'anthropic' },
    { name: 'prod-haiku', model: 'claude-haiku-4-5', provider: 'anthropic' },
    'prod-sonnet',
    'prod-haiku',
  ];
  const r = await admit(body('reroute-claude-haiku-4-5', { accepts_models: deployments }));
  assert.equal(r.json.decision, 'reroute');
  assert.equal(r.json.model, 'prod-haiku');
  assert.equal(r.json.route.to_model, 'claude-haiku-4-5');
  assertValidAnswer(r.json);
  assert.deepEqual(mock.log.admits.at(-1).request_errors, []);

  await admit(body('team-search', { accepts_models: [{ model: 'claude-haiku-4-5' }, 7] }));
  const { request_errors: errs } = mock.log.admits.at(-1);
  assert.ok(errs.some((e) => /accepts_models\[0\]: matches none/.test(e) && /missing name/.test(e)), errs.join('; '));
  assert.ok(errs.some((e) => /accepts_models\[1\]: matches none/.test(e)), errs.join('; '));
});

test('slow-* answers after the time it names', async () => {
  const t0 = Date.now();
  const r = await admit(body('slow-400'));
  assert.ok(Date.now() - t0 >= 380, 'answered too soon');
  assert.equal(r.json.decision, 'allow');
  assertValidAnswer(r.json);
});

test('error-* fails the way TensorCost failing does: a non-2xx, or a body that is not a decision', async () => {
  assert.equal((await admit(body('error-503'))).status, 503);
  assert.equal((await admit(body('error-500'))).status, 500);
  assert.equal((await admit(body('error-401'))).status, 401);
  assert.equal((await admit(body('error-anything'))).status, 503);
  const nj = await admit(body('error-not-json'));
  assert.equal(nj.status, 200);
  assert.equal(nj.json, null);
});

test('degraded-*, unavailable-*, throttled-* and unknown-mode-* answer as the fail mode would, as 200s', async () => {
  const d = await admit(body('degraded-x'));
  assert.equal(d.json.decision, 'allow');
  assert.equal(d.json.degraded, true);
  assert.equal(d.json.cache_ttl_seconds, 0);
  assertValidAnswer(d.json);

  const u = await admit(body('unavailable-x'));
  assert.equal(u.json.decision, 'refuse');
  assert.equal(u.json.reason, 'check_unavailable');
  assert.equal(u.headers.get('x-tc-fail-mode'), 'closed');
  assertValidAnswer(u.json);

  const tOpen = await admit(body('throttled-x'));
  assert.equal(tOpen.json.decision, 'allow');
  assert.equal(tOpen.json.detail, 'throttled');
  assertValidAnswer(tOpen.json);
  mock.reset('closed');
  const tClosed = await admit(body('throttled-x'));
  assert.equal(tClosed.json.decision, 'refuse');
  assert.equal(tClosed.json.reason, 'check_unavailable');
  assert.ok(tClosed.json.retry_after_seconds >= 1 && tClosed.json.retry_after_seconds <= 60);
  assertValidAnswer(tClosed.json);

  const k = await admit(body('unknown-mode-x'));
  assert.equal(k.json.fail_mode_known, false);
  assert.equal(k.json.fail_mode, 'open');
  assert.equal(k.headers.get('x-tc-fail-mode'), null);
  assertValidAnswer(k.json);
});

test('cache-* is the one allow with a cache_ttl_seconds above 0, and it holds nothing', async () => {
  const r = await admit(body('cache-2'));
  assert.equal(r.json.cache_ttl_seconds, 2);
  assert.equal(r.json.reservation_cents, 0);
  assertValidAnswer(r.json);
  assert.equal((await cancel(r.json.decision_id)).json.cancelled, false);
  assert.equal((await admit(body('cache-x'))).json.cache_ttl_seconds, 5);
});

test('a model TensorCost cannot read is decided by the fail mode, not refused as an error', async () => {
  const { model, ...noModel } = body('team-search');
  const open = await admit(noModel);
  assert.equal(open.status, 200);
  assert.equal(open.json.decision, 'allow');
  assert.equal(open.json.degraded, true);
  assert.deepEqual(validate(spec, admitOp.responses['200'], open.json, { strict: true }), []);
  assert.deepEqual(mock.log.admits.at(-1).request_errors, ['request: missing model']);
  mock.reset('closed');
  const closed = await admit({ ...noModel, model: 42 });
  assert.equal(closed.json.decision, 'refuse');
  assert.equal(closed.json.reason, 'invalid_request');
  assert.equal(mock.log.admits.at(-1).response_errors.length, 0);
  assert.ok(mock.log.admits.at(-1).request_errors.some((e) => /model/.test(e)), 'the wrong-typed model is named as a request problem');
});

test('a caller kind the gateway does not send is dropped and named in detail', async () => {
  const r = await admit(body('team-search', { callers: [{ kind: 'consumer', id: 'refuse-x' }, { kind: 'team', id: 'team-search' }] }));
  assert.equal(r.json.decision, 'allow', 'a dropped caller does not pick the answer');
  assert.match(r.json.detail, /ignored: callers\[0\] \(kind "consumer" isn't one litellm sends\)/);
  assertValidAnswer(r.json);
});

test('the mock checks requests against the OpenAPI file and logs what is wrong', async () => {
  await admit(body('team-search', { max_tokens: '512', callers: Array.from({ length: 33 }, (_, i) => ({ kind: 'tag', id: `t${i}` })) }));
  const { request_errors: errs } = mock.log.admits.at(-1);
  assert.ok(errs.some((e) => /max_tokens/.test(e)), errs.join('; '));
  assert.ok(errs.some((e) => /callers: more than 32/.test(e)), errs.join('; '));
});

test('no key is a 401, a body that is not an object is a 400, and the prefixed path is served', async () => {
  assert.equal((await admit(body('team-search'), { key: null })).status, 401);
  assert.equal((await admit(null, { raw: '[1,2]' })).status, 400);
  assert.equal((await admit(null, { raw: 'not json' })).status, 400);
  const p = await admit(body('team-search'), { path: '/api/inference-proxy/v1/gateway/admit' });
  assert.equal(p.json.decision, 'allow');
});

test('cancel drops a held allow once, only for the key that was answered', async () => {
  const r = await admit(body('team-search'));
  const id = r.json.decision_id;
  assert.equal((await cancel(id, 'tcgw_other_key')).json.cancelled, false);
  const first = await cancel(id);
  assert.equal(first.status, 200);
  assert.equal(first.json.cancelled, true);
  assert.deepEqual(validate(spec, cancelOp.responses['200'], first.json, { strict: true }), []);
  assert.equal((await cancel(id)).json.cancelled, false);
  assert.equal((await cancel('not-a-uuid')).status, 400);
  const refused = await admit(body('refuse-search'));
  assert.equal((await cancel(refused.json.decision_id)).json.cancelled, false, 'a refusal held nothing');
});

test('--key limits the mock to one gateway key', async () => {
  const strict = createMock({ key: KEY, spec: false });
  const u = await strict.listen(0);
  try {
    const call = (k) => fetch(`${u}/v1/gateway/admit`, { method: 'POST', headers: { authorization: `Bearer ${k}` }, body: JSON.stringify(body('team-search')) });
    assert.equal((await call('tcgw_wrong')).status, 401);
    assert.equal((await call(KEY)).status, 200);
  } finally {
    await strict.close();
  }
});

test('every operation\'s server URL plus path is a route the mock serves, bare and under /api/inference-proxy', async () => {
  const { route } = await import('../src/server.mjs');
  assert.equal(spec.servers.length, 1);
  const server = spec.servers[0];
  const base = server.url.replace(/\{(\w+)\}/g, (_, name) => {
    const v = server.variables?.[name]?.default;
    assert.ok(v, `server variable ${name} needs a default`);
    return v;
  });
  const basePath = new URL(base).pathname.replace(/\/$/, '');
  assert.equal(basePath, '/v1');
  let n = 0;
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op?.operationId) continue;
      n++;
      const path = basePath + p.replace(/\{[^}]+\}/g, 'sample-id');
      assert.equal(route(method.toUpperCase(), path)?.operationId, op.operationId, `${method.toUpperCase()} ${path}`);
      assert.equal(route(method.toUpperCase(), `/api/inference-proxy${path}`)?.operationId, op.operationId);
    }
  }
  assert.equal(n, 6);
  // Without the server's /v1 the path is not a route: that was the bug.
  assert.equal(route('POST', '/gateway/admit'), null);
});

async function call(method, path, body, key = KEY) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json };
}

test('headroom: $97 of a $100 hard cap refuses a $5 step and allows a $2 one, both answers valid', async () => {
  const op = operationSchemas(spec, 'gatewayHeadroom');
  const no = await call('POST', '/v1/gateway/headroom', { team: 'search', estimate_cents: 500 });
  assert.equal(no.status, 200);
  assert.equal(no.json.allowed, false);
  assert.equal(no.json.binding.name, 'Search team');
  assert.equal(no.json.binding.remaining_cents, 300);
  assert.deepEqual(validate(spec, op.responses['200'], no.json, { strict: true }), []);
  const yes = await call('POST', '/api/inference-proxy/v1/gateway/headroom', { estimate_cents: 200 });
  assert.equal(yes.json.allowed, true);
  assert.equal(yes.json.counted_spend_scope, 'workspace');
  assert.deepEqual(mock.log.headrooms.map((h) => h.response_errors), [[], []]);
  assert.equal((await call('POST', '/v1/gateway/headroom', {}, null)).status, 401);
});

test('subscriptions: 201 with a Location, deletable at it only by the key that subscribed', async () => {
  const op = operationSchemas(spec, 'gatewaySubscribe');
  const sub = await call('POST', '/v1/gateway/subscriptions', { url: 'https://hooks.example.com/tc', event_types: ['budget.threshold_crossed'] });
  assert.equal(sub.status, 201);
  assert.equal(sub.headers.get('location'), `/v1/gateway/subscriptions/${sub.json.id}`);
  assert.deepEqual(validate(spec, op.responses['201'], sub.json, { strict: true }), []);
  assert.ok(sub.json.signing_secret);
  // Another connection's key can't delete it.
  assert.equal((await call('DELETE', sub.headers.get('location'), undefined, 'tcgw_other_key')).status, 404);
  assert.equal((await call('DELETE', sub.headers.get('location'))).status, 204);
  assert.equal((await call('DELETE', sub.headers.get('location'))).status, 404);

  const under = await call('POST', '/api/inference-proxy/v1/gateway/subscriptions', { url: 'https://hooks.example.com/tc', event_types: ['budget.threshold_crossed'] });
  assert.equal(under.headers.get('location'), `/api/inference-proxy/v1/gateway/subscriptions/${under.json.id}`);
  assert.equal((await call('POST', '/v1/gateway/subscriptions', { url: 'https://x.example', event_types: ['budget.renamed'] })).status, 400);
});

async function pushLogs(rows, { format = 'tensorcost', key = KEY, path = '/v1/gateway/logs' } = {}) {
  const res = await fetch(`${url}${path}?format=${format}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(rows),
  });
  return { status: res.status, json: await res.json() };
}

const ROW = { log_id: 'row-1', provider: 'openai', model: 'gpt-4o', input_tokens: 10, output_tokens: 2, started_at: '2026-11-26T00:00:00Z' };

test('a log push stores the rows that fit GatewayLogRow, names the rest, and answers as the contract says', async () => {
  const res = await pushLogs({ logs: [ROW, { ...ROW, log_id: 'row-2', model: undefined }, 'nope'] });
  assert.equal(res.status, 200);
  assert.deepEqual(validate(spec, operationSchemas(spec, 'gatewayLogs').responses['200'], res.json, { strict: true }), []);
  assert.equal(res.json.inserted, 1);
  assert.deepEqual(res.json.parse_errors.map((e) => e.index), [1, 2]);
  assert.match(res.json.parse_errors[0].reason, /missing model/);
  assert.equal(res.json.parse_errors[1].reason, 'not_an_object');
});

test('a resent row is deduped by log_id, per key, and the push is also served under /api/inference-proxy', async () => {
  assert.equal((await pushLogs([ROW])).json.inserted, 1);
  const again = await pushLogs([ROW], { path: '/api/inference-proxy/v1/gateway/logs' });
  assert.deepEqual([again.json.inserted, again.json.deduped], [0, 1]);
  assert.equal((await pushLogs([ROW], { key: 'tcgw_other' })).json.inserted, 1);
});

test('a log push without a key, a format or rows is refused, and more than 500 rows is a 413', async () => {
  assert.equal((await pushLogs([ROW], { key: null })).status, 401);
  assert.equal((await pushLogs([ROW], { format: 'csv' })).status, 400);
  assert.equal((await pushLogs([])).status, 400);
  assert.equal((await pushLogs(Array.from({ length: 501 }, (_, i) => ({ ...ROW, log_id: `r${i}` })))).status, 413);
});
