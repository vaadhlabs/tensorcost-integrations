// Checks the recorded cassettes against the admit contract, and runs the
// stand-alone Ruby harness when Ruby is installed. Standard-library Node only:
// it needs no gem and no Workato SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CASSETTES = path.join(ROOT, 'fixtures/vcr_cassettes');
// In this repository the contract sits with its source; in the public one next to the protocol text.
const SPEC = [
  path.resolve(ROOT, '../spec/admit/openapi.yaml'),
  path.resolve(ROOT, '../../packages/contracts/specs/gateway-admit.openapi.yaml'),
].find((p) => fs.existsSync(p));
assert.ok(SPEC, 'the admit openapi.yaml was not found');
const yaml = fs.readFileSync(SPEC, 'utf8');

const cassettes = fs.readdirSync(CASSETTES).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(fs.readFileSync(path.join(CASSETTES, f), 'utf8'))]);

/** The property names of a component schema, read from the YAML's indentation. */
function schemaProps(name) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `    ${name}:`);
  assert.ok(start >= 0, `schema ${name}`);
  const props = [];
  let inProps = false;
  for (const l of lines.slice(start + 1)) {
    if (/^    \S/.test(l)) break;
    if (l === '      properties:') { inProps = true; continue; }
    if (inProps) {
      const m = /^        ([a-z_]+):/.exec(l);
      if (m) props.push(m[1]);
    }
  }
  return props;
}

/** Operations as `method path`, from the paths block. The server URL ends in /v1. */
function operations() {
  const ops = new Set();
  let current = null;
  for (const l of yaml.split('\n')) {
    const p = /^  (\/[^:]+):$/.exec(l);
    if (p) current = p[1];
    const m = /^    (get|post|delete|put):$/.exec(l);
    if (m && current) ops.add(`${m[1]} ${current}`);
  }
  return ops;
}

const interactions = cassettes.flatMap(([file, c]) => c.http_interactions.map((i) => ({ file, ...i })));
const bodyOf = (s) => (s === '' ? null : JSON.parse(s));

test('every request in the cassettes is an operation the contract has, under /v1', () => {
  const ops = operations();
  for (const i of interactions) {
    const u = new URL(i.request.uri);
    assert.ok(u.pathname.startsWith('/v1/'), `${i.file}: ${u.pathname}`);
    const route = u.pathname.slice('/v1'.length).replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/, '{id}').replace('{id}/cancel', '{decision_id}/cancel');
    if (route.startsWith('/gateway/logs')) continue; // the log push is documented in the log format, not in the admit contract
    assert.ok(ops.has(`${i.request.method} ${route}`), `${i.file}: ${i.request.method} ${route}`);
  }
});

test('admit requests carry only fields the contract names, and only the caller kinds Workato sends', () => {
  const known = new Set(schemaProps('GatewayAdmitRequest'));
  const kinds = new Set(['team', 'user', 'key', 'tag']);
  let seen = 0;
  for (const i of interactions.filter((x) => x.request.uri.endsWith('/v1/gateway/admit'))) {
    seen++;
    const body = bodyOf(i.request.body.string);
    for (const k of Object.keys(body)) assert.ok(known.has(k), `${i.file}: ${k}`);
    assert.equal(typeof body.model, 'string');
    assert.equal(body.can_reroute, false);
    assert.equal('correlation_id' in body, false);
    for (const c of body.callers) assert.ok(kinds.has(c.kind), `${i.file}: caller kind ${c.kind}`);
  }
  assert.ok(seen >= 3);
});

test('admit answers are 200 with a decision, even a refusal; a failure is the only non-2xx', () => {
  const decisions = new Set(['allow', 'refuse', 'reroute']);
  for (const i of interactions.filter((x) => x.request.uri.endsWith('/v1/gateway/admit'))) {
    if (i.response.status.code === 200) assert.ok(decisions.has(bodyOf(i.response.body.string).decision), i.file);
    else assert.ok(i.response.status.code >= 400, i.file);
  }
  const refuse = cassettes.find(([f]) => f === 'check_budget_refuse.json')[1].http_interactions[0].response;
  assert.equal(refuse.status.code, 200);
  assert.equal(bodyOf(refuse.body.string).decision, 'refuse');
});

test('headroom requests carry only fields the contract names', () => {
  const known = new Set(schemaProps('GatewayHeadroomRequest'));
  for (const i of interactions.filter((x) => x.request.uri.endsWith('/v1/gateway/headroom'))) {
    for (const k of Object.keys(bodyOf(i.request.body.string))) assert.ok(known.has(k), `${i.file}: ${k}`);
  }
});

test('subscribe asks for budget.threshold_crossed, answers 201 with a Location, and unsubscribe deletes that path', () => {
  const [sub, del] = cassettes.find(([f]) => f === 'trigger_subscribe.json')[1].http_interactions;
  const known = new Set(schemaProps('GatewaySubscriptionRequest'));
  const req = bodyOf(sub.request.body.string);
  for (const k of Object.keys(req)) assert.ok(known.has(k), k);
  assert.deepEqual(req.event_types, ['budget.threshold_crossed']);
  assert.equal(sub.response.status.code, 201);
  assert.equal(sub.response.headers.Location[0], new URL(del.request.uri).pathname);
  assert.equal(del.request.method, 'delete');
});

test('a log row carries a log_id and only fields the tensorcost log format reads, and the same caller kinds as the check', () => {
  const fields = new Set(['log_id', 'provider', 'model', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'provider_response_id', 'correlation_id', 'started_at', 'ended_at', 'callers', 'gateway_cost_cents', 'status', 'upstream_status']);
  const check = bodyOf(cassettes.find(([f]) => f === 'check_budget_allow.json')[1].http_interactions[0].request.body.string);
  for (const i of interactions.filter((x) => x.request.uri.includes('/v1/gateway/logs'))) {
    assert.match(i.request.uri, /\?format=tensorcost$/);
    const body = bodyOf(i.request.body.string);
    assert.deepEqual(Object.keys(body), ['logs'], 'an array or { logs }, never a bare row');
    assert.equal(body.logs.length, 1);
    const row = body.logs[0];
    for (const k of Object.keys(row)) assert.ok(fields.has(k), `${i.file}: ${k}`);
    assert.match(row.log_id, /^wk:[0-9a-f-]{36}$/, 'derived from the decision, so a retried job dedupes');
    assert.equal(row.correlation_id, row.log_id.slice(3));
    assert.deepEqual(row.callers, check.callers);
    assert.ok(row.callers.some((c) => c.kind === 'tag' && c.id === 'team=search'), 'a team is also a team= tag');
  }
});

test('cancel posts to the fenced cancel route with no body, once', () => {
  const [{ request, response }] = cassettes.find(([f]) => f === 'cancel_check.json')[1].http_interactions;
  assert.equal(request.method, 'post');
  assert.match(new URL(request.uri).pathname, /^\/v1\/gateway\/admit\/[0-9a-f-]{36}\/cancel$/);
  assert.equal(request.body.string, '');
  assert.equal(bodyOf(response.body.string).cancelled, true);
});

test('connector.rb carries the exact texts and routes the brief names', () => {
  const rb = fs.readFileSync(path.join(ROOT, 'connector.rb'), 'utf8');
  for (const text of [
    'https://api.tensorcost.com',
    'Your TensorCost gateway key was refused',
    "Only for calls made with your own provider keys. Workato's built-in AI is billed by Workato and isn't counted here.",
    '/v1/gateway/logs?format=tensorcost',
    '/v1/gateway/headroom',
    '/v1/gateway/subscriptions',
    'budget.threshold_crossed',
    'workato.uuid',
  ]) assert.ok(rb.includes(text), text);
  assert.equal(/"log_id" => input/.test(rb), false, 'log_id is never taken from the recipe input');
});

const ruby = spawnSync('ruby', ['-v'], { encoding: 'utf8' });
test('connector.rb is valid Ruby and passes the stand-alone harness', { skip: ruby.status !== 0 && 'ruby is not installed' }, () => {
  for (const f of ['connector.rb', 'spec/connector_spec.rb', 'spec/spec_helper.rb', 'tests/connector_harness_test.rb']) {
    const c = spawnSync('ruby', ['-c', f], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(c.status, 0, `${f}: ${c.stderr}`);
  }
  const run = spawnSync('ruby', ['tests/connector_harness_test.rb'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /0 failures, 0 errors/);
});
