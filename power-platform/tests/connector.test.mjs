// Checks the TensorCost Power Platform connector with nothing installed: no
// paconn, no Microsoft tooling, no network. Three things.
//
//   1. apiDefinition.swagger.json is OpenAPI 2.0 in the shape Power
//      Platform reads (paconn validate is the real check, and is a separate
//      step in the Makefile when it is installed).
//   2. Every operation's request and answer fit the admit contract
//      (@tensorcost/admit-spec, spec/admit/ in this repository), the log
//      push's rows included, so the two can't drift.
//   3. The requests a flow would send are replayed against the admit mock on
//      localhost, which checks them against the contract again and answers
//      the way TensorCost does.
//
// Node built-ins plus the admit mock and its YAML reader from this repository.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createMock, CALLER_KINDS } from '../../admit-mock/src/server.mjs';
import { findSpec, loadSpec, validate } from '../../admit-mock/src/openapi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '../TensorCost');
const swagger = JSON.parse(fs.readFileSync(path.join(DIR, 'apiDefinition.swagger.json'), 'utf8'));
const props = JSON.parse(fs.readFileSync(path.join(DIR, 'apiProperties.json'), 'utf8'));

// The contract is read again here, not cached from another test: it can change under us.
const SPEC_PATH = findSpec();
assert.ok(SPEC_PATH, 'the admit OpenAPI file was not found; set TENSORCOST_ADMIT_OPENAPI');
const contract = loadSpec(SPEC_PATH);

/** The contract's operation for a swagger operationId. The log push is the one with none. */
const CONTRACT_ROUTE = {
  CheckBudget: { method: 'post', path: '/gateway/admit', id: 'gatewayAdmit' },
  CancelCheck: { method: 'post', path: '/gateway/admit/{decision_id}/cancel', id: 'gatewayAdmitCancel' },
  GetHeadroom: { method: 'post', path: '/gateway/headroom', id: 'gatewayHeadroom' },
  OnBudgetThresholdCrossed: { method: 'post', path: '/gateway/subscriptions', id: 'gatewaySubscribe' },
};
const LOG_PUSH = { method: 'post', path: '/gateway/logs' };

/** The tensorcost log format's fields: GatewayLogRow in the contract. */
const LOG_FIELDS = Object.keys(contract.components.schemas.GatewayLogRow.properties);
const LOG_REQUIRED = contract.components.schemas.GatewayLogRow.required;

// ------------------------------------------------------------ helpers

function deref(root, node) {
  let n = node;
  const seen = new Set();
  while (n && n.$ref) {
    assert.ok(!seen.has(n.$ref), `$ref loop at ${n.$ref}`);
    seen.add(n.$ref);
    assert.ok(n.$ref.startsWith('#/'), `only local refs: ${n.$ref}`);
    n = n.$ref.slice(2).split('/').reduce((o, k) => o?.[k], root);
    assert.ok(n, `$ref names nothing`);
  }
  return n;
}

const typesOf = (s) => (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []).filter((t) => t !== 'null');

/** Every [method, path, operation] in the swagger. */
function operations() {
  return Object.entries(swagger.paths).flatMap(([p, item]) => Object.entries(item).map(([m, op]) => [m, p, op]));
}
const opById = (id) => {
  const hit = operations().find(([, , op]) => op.operationId === id);
  assert.ok(hit, `operation ${id}`);
  return hit;
};
const bodyOf = (op) => deref(swagger, op.parameters.find((p) => p.in === 'body')?.schema);

/**
 * Compares a connector schema with the contract's: every property the
 * connector sends exists in the contract, with a type the contract has, enum
 * values the contract allows and limits no looser than the contract's.
 * `side` is 'request' (the connector must not require more than the
 * contract does) or 'response' (it may not name a field the contract lacks).
 */
function fits(ours, theirs, where, side, problems) {
  ours = deref(swagger, ours);
  theirs = deref(contract, theirs);
  if (!theirs) return problems.push(`${where}: the contract has no schema here`);
  const t = typesOf(theirs);
  const o = typesOf(ours);
  for (const type of o) {
    const ok = t.includes(type) || (type === 'integer' && t.includes('number')) || (type === 'number' && t.includes('integer') && side === 'response');
    if (!ok) problems.push(`${where}: type ${type}, the contract has ${t.join('|') || 'none'}`);
  }
  if (ours.enum && theirs.enum) {
    for (const v of ours.enum) if (!theirs.enum.includes(v)) problems.push(`${where}: enum value ${JSON.stringify(v)} is not in the contract`);
  }
  if (side === 'request') {
    if (theirs.maxLength !== undefined && ours.maxLength !== undefined && ours.maxLength > theirs.maxLength) problems.push(`${where}: maxLength ${ours.maxLength} is over the contract's ${theirs.maxLength}`);
    if (theirs.maxItems !== undefined && ours.maxItems !== undefined && ours.maxItems > theirs.maxItems) problems.push(`${where}: maxItems ${ours.maxItems} is over the contract's ${theirs.maxItems}`);
    if (theirs.minItems !== undefined && ours.minItems !== undefined && ours.minItems < theirs.minItems) problems.push(`${where}: minItems ${ours.minItems} is under the contract's ${theirs.minItems}`);
    if (theirs.minimum !== undefined && ours.minimum !== undefined && ours.minimum < theirs.minimum) problems.push(`${where}: minimum ${ours.minimum} is under the contract's ${theirs.minimum}`);
    if (theirs.maximum !== undefined && ours.maximum !== undefined && ours.maximum > theirs.maximum) problems.push(`${where}: maximum ${ours.maximum} is over the contract's ${theirs.maximum}`);
    // A default the contract wouldn't accept.
    if (ours.default !== undefined && theirs.enum && !theirs.enum.includes(ours.default) && !Array.isArray(ours.default)) problems.push(`${where}: default ${JSON.stringify(ours.default)} is not in the contract's enum`);
  }
  if (ours.type === 'object' && ours.properties) {
    if (!theirs.properties) return problems.push(`${where}: the contract lists no properties`);
    for (const [k, v] of Object.entries(ours.properties)) {
      if (!theirs.properties[k]) problems.push(`${where}.${k}: the contract has no such field`);
      else fits(v, theirs.properties[k], `${where}.${k}`, side, problems);
    }
    if (side === 'request') {
      const theirsRequired = new Set(theirs.required ?? []);
      for (const r of ours.required ?? []) if (!theirsRequired.has(r)) problems.push(`${where}: requires ${r}, the contract doesn't`);
      for (const r of theirs.required ?? []) {
        if (!(ours.required ?? []).includes(r)) problems.push(`${where}: the contract requires ${r}, the connector doesn't`);
      }
    }
  }
  if (ours.type === 'array' && ours.items) {
    if (!theirs.items) return problems.push(`${where}: the contract lists no items`);
    fits(ours.items, theirs.items, `${where}[]`, side, problems);
  }
}

// ------------------------------------------------------------ 1. OpenAPI 2.0 structure

test('the swagger is OpenAPI 2.0 with a host, base path, https and a title', () => {
  assert.equal(swagger.swagger, '2.0');
  assert.ok(swagger.info.title && swagger.info.version, 'info.title and info.version');
  assert.ok(swagger.info.title.length <= 30, 'connector titles are at most 30 characters');
  assert.ok(!/powerplatform|power platform|microsoft/i.test(swagger.info.title), 'a title may not carry a Microsoft product name');
  assert.match(swagger.host, /^[a-z0-9.-]+$/);
  assert.match(swagger.basePath, /^\/[a-z0-9/]*$/);
  assert.deepEqual(swagger.schemes, ['https']);
  assert.ok(swagger.paths && Object.keys(swagger.paths).length > 0);
  for (const k of Object.keys(swagger)) assert.ok(!['openapi', 'servers', 'components'].includes(k), `${k} is OpenAPI 3, not 2.0`);
});

test('every $ref resolves, and every definition is used', () => {
  const used = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (k === '$ref') {
          assert.match(v, /^#\/definitions\/[A-Za-z0-9_]+$/, `ref ${v}`);
          assert.ok(swagger.definitions[v.split('/')[2]], `${v} names nothing`);
          used.add(v.split('/')[2]);
        } else walk(v);
      }
    }
  };
  walk(swagger.paths);
  // A definition used only by another definition counts when that one is used.
  for (let again = true; again; ) {
    again = false;
    for (const name of [...used]) {
      const before = used.size;
      walk(swagger.definitions[name]);
      if (used.size !== before) again = true;
    }
  }
  for (const name of Object.keys(swagger.definitions)) assert.ok(used.has(name), `definition ${name} is never used`);
});

test('each operation has a unique operationId, a summary, a description, a body or path shape that matches its path, and a success response', () => {
  const ids = new Set();
  for (const [method, p, op] of operations()) {
    const where = `${method} ${p}`;
    assert.ok(['get', 'post', 'put', 'patch', 'delete'].includes(method), where);
    assert.match(op.operationId, /^[A-Za-z][A-Za-z0-9]*$/, where);
    assert.ok(!ids.has(op.operationId), `${where}: duplicate operationId`);
    ids.add(op.operationId);
    assert.ok(op.summary && op.description, `${where}: summary and description`);
    assert.ok(op.summary.length <= 80, `${where}: summary over 80 characters`);
    assert.ok(/[.:?]$/.test(op.description.trim()), `${where}: description should be a sentence`);
    const params = op.parameters ?? [];
    assert.ok(params.filter((x) => x.in === 'body').length <= 1, `${where}: one body parameter at most`);
    const inPath = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(params.filter((x) => x.in === 'path').map((x) => x.name).sort(), inPath, `${where}: path parameters`);
    for (const x of params) {
      assert.ok(['path', 'query', 'header', 'body'].includes(x.in), where);
      if (x.in === 'path') assert.equal(x.required, true, `${where}: path parameter ${x.name} must be required`);
      if (x.in !== 'body') assert.ok(x.type, `${where}: ${x.name} needs a type`);
    }
    const codes = Object.keys(op.responses);
    assert.ok(codes.some((c) => /^2\d\d$/.test(c)), `${where}: a 2xx response`);
    assert.ok(codes.includes('default'), `${where}: a default response`);
  }
});

test('the connector has exactly the five operations, CheckBudget is important, and every x-ms-visibility is a known value', () => {
  assert.deepEqual(
    operations().map(([, , op]) => op.operationId).sort(),
    ['CancelCheck', 'CheckBudget', 'GetHeadroom', 'OnBudgetThresholdCrossed', 'RecordAiSpend'],
  );
  const [, p, check] = opById('CheckBudget');
  assert.equal(p, '/gateway/admit');
  assert.equal(check['x-ms-visibility'], 'important');
  const known = new Set(['important', 'advanced', 'internal']);
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (k === 'x-ms-visibility') assert.ok(known.has(v), `x-ms-visibility ${v}`);
        else walk(v);
      }
    }
  };
  walk(swagger);
  assert.equal(opById('RecordAiSpend')[1], '/gateway/logs');
  assert.equal(opById('GetHeadroom')[1], '/gateway/headroom');
});

test('schemas stay inside what OpenAPI 2.0 allows: no nullable, no oneOf, no type arrays', () => {
  const walk = (n, where) => {
    if (Array.isArray(n)) return n.forEach((v, i) => walk(v, `${where}[${i}]`));
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        assert.ok(!['nullable', 'oneOf', 'anyOf', 'const', 'examples'].includes(k), `${where}.${k} is not OpenAPI 2.0`);
        if (k === 'type') assert.equal(typeof v, 'string', `${where}.type must be a string`);
        walk(v, `${where}.${k}`);
      }
    }
  };
  walk(swagger.paths, 'paths');
  walk(swagger.definitions, 'definitions');
  for (const [name, d] of Object.entries(swagger.definitions)) {
    for (const r of d.required ?? []) assert.ok(d.properties?.[r], `${name}: required ${r} isn't a property`);
  }
});

test('the trigger is a single webhook: a notification URL parameter, a 201 with Location, and a notification schema', () => {
  const [method, , op] = opById('OnBudgetThresholdCrossed');
  assert.equal(method, 'post');
  assert.equal(op['x-ms-trigger'], 'single');
  const body = bodyOf(op);
  assert.equal(body.properties.url['x-ms-notification-url'], true);
  assert.equal(body.properties.url['x-ms-visibility'], 'internal');
  assert.deepEqual(body.properties.event_types.default, ['budget.threshold_crossed']);
  assert.equal(body.properties.event_types['x-ms-visibility'], 'internal');
  const created = op.responses['201'];
  assert.ok(created.headers.Location, 'the platform deletes the subscription at the 201 Location');
  const content = op['x-ms-notification-content'];
  assert.ok(content?.schema, 'x-ms-notification-content with a schema');
  const note = deref(swagger, content.schema);
  assert.deepEqual(Object.keys(note.properties), ['event', 'budget', 'threshold_pct', 'spent_cents', 'crossed_at', 'scope']);
  assert.deepEqual(Object.keys(note.properties.budget.properties), ['id', 'name', 'period', 'cap_cents']);
  assert.deepEqual(Object.keys(note.properties.scope.properties), ['team', 'developer', 'provider']);
});

test('authentication is an API key in the Authorization header, with "Bearer" in the help text', () => {
  assert.deepEqual(swagger.securityDefinitions.api_key, {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description: swagger.securityDefinitions.api_key.description,
  });
  assert.match(swagger.securityDefinitions.api_key.description, /Bearer tcgw_/);
  assert.deepEqual(swagger.security, [{ api_key: [] }]);
  const key = props.properties.connectionParameters.api_key;
  assert.equal(key.type, 'securestring');
  assert.match(key.uiDefinition.description, /Bearer/);
  assert.equal(key.uiDefinition.constraints.clearText, false, 'the key is never shown in clear text');
  assert.equal(key.uiDefinition.constraints.required, 'true');
});

test('apiProperties.json: the host is a connection parameter, the capabilities name actions and triggers', () => {
  const p = props.properties;
  assert.ok(p.connectionParameters.api_host, 'a self-hosted TensorCost needs its own host');
  assert.equal(p.connectionParameters.api_host.defaultValue, undefined, 'every install has its own host, so there is no default');
  assert.equal(p.connectionParameters.api_host.uiDefinition.constraints.required, 'true');
  assert.equal(swagger.host, 'tensorcost.example.com', 'the swagger host is a placeholder the connection replaces');
  const policy = p.policyTemplateInstances.find((t) => t.templateId === 'dynamichosturl');
  assert.ok(policy, 'a dynamichosturl policy');
  assert.match(policy.parameters['x-ms-apimTemplateParameter.urlTemplate'], /^https:\/\/@connectionParameters\('api_host'\)$/);
  assert.deepEqual(p.capabilities, ['actions', 'triggers']);
  assert.match(p.iconBrandColor, /^#[0-9A-Fa-f]{6}$/);
  assert.notEqual(p.iconBrandColor.toLowerCase(), '#007ee5', 'Microsoft refuses the default brand colour');
  assert.notEqual(p.iconBrandColor.toLowerCase(), '#ffffff', 'Microsoft refuses white');
});

test('apiProperties.json: every request names TensorCost in its User-Agent, so the WAF never blocks it as nameless', () => {
  const ua = props.properties.policyTemplateInstances.find((t) => t.templateId === 'setheader' && t.parameters['x-ms-apimTemplateParameter.name'] === 'User-Agent');
  assert.ok(ua, 'a setheader policy for User-Agent');
  assert.match(ua.parameters['x-ms-apimTemplateParameter.value'], /^TensorCost-PowerPlatform\/\d+\.\d+\.\d+$/);
  assert.equal(ua.parameters['x-ms-apimTemplateParameter.existsAction'], 'override');
  assert.equal(ua.parameters['x-ms-apimTemplate-policySection'], 'Request');
});

test('icon.png is a real PNG, square, opaque, between 1 KB and 1 MB', () => {
  const png = fs.readFileSync(path.join(DIR, 'icon.png'));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length >= 1024 && png.length <= 1024 * 1024, `${png.length} bytes`);
  let off = 8;
  let ihdr = null;
  const idat = [];
  let ended = false;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') ended = true;
    off += 12 + len;
  }
  assert.ok(ended && ihdr, 'IHDR and IEND');
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  assert.equal(w, h, 'square');
  assert.equal(w, 256);
  assert.equal(ihdr[9], 6, 'RGBA');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (w * 4 + 1) * h);
  for (let y = 0; y < h; y += 17) for (let x = 0; x < w; x += 19) assert.equal(raw[y * (w * 4 + 1) + 1 + x * 4 + 3], 255, 'no transparency');
});

// ------------------------------------------------------------ 2. against the contract

test('the base path is the contract server URL path, and every contract operation the connector uses exists there', () => {
  const server = new URL(contract.servers[0].url.replace('{host}', swagger.host));
  assert.equal(swagger.basePath, server.pathname);
  for (const [id, want] of Object.entries(CONTRACT_ROUTE)) {
    const [method, p] = opById(id);
    assert.equal(method, want.method, id);
    assert.equal(p, want.path, id);
    assert.equal(contract.paths[p]?.[method]?.operationId, want.id, `${id} is not ${want.id} in the contract`);
  }
});

for (const [id, want] of Object.entries(CONTRACT_ROUTE)) {
  const hasBody = id !== 'CancelCheck';
  test(`${id}: the request fits ${want.id}`, () => {
    const [, , op] = opById(id);
    const theirs = contract.paths[want.path][want.method];
    const problems = [];
    if (hasBody) {
      assert.ok(theirs.requestBody, 'the contract takes a body');
      fits(bodyOf(op), theirs.requestBody.content['application/json'].schema, id, 'request', problems);
    } else {
      assert.equal(theirs.requestBody, undefined, 'the contract takes no body');
      assert.equal((op.parameters ?? []).some((p) => p.in === 'body'), false);
      const ours = op.parameters.find((p) => p.in === 'path');
      const their = theirs.parameters.find((p) => p.in === 'path');
      assert.equal(ours.name, their.name);
      assert.equal(ours.format, their.schema.format);
      assert.equal(ours.type, their.schema.type);
    }
    assert.deepEqual(problems, []);
  });

  test(`${id}: the success answer is one ${want.id} gives, and names no field it doesn't`, () => {
    const [, , op] = opById(id);
    const theirs = contract.paths[want.path][want.method];
    const ok = Object.keys(op.responses).find((c) => /^2\d\d$/.test(c));
    assert.ok(theirs.responses[ok], `the contract answers ${ok}`);
    const problems = [];
    fits(op.responses[ok].schema, theirs.responses[ok].content['application/json'].schema, `${id} ${ok}`, 'response', problems);
    assert.deepEqual(problems, []);
  });
}

test('RecordAiSpend: a row carries only fields the tensorcost log format reads, requires what it requires, and goes in {logs: [...]} with format=tensorcost', () => {
  const [method, p, op] = opById('RecordAiSpend');
  assert.equal(method, LOG_PUSH.method);
  assert.equal(p, LOG_PUSH.path);
  const format = op.parameters.find((x) => x.name === 'format');
  assert.equal(format.in, 'query');
  assert.equal(format.default, 'tensorcost');
  assert.deepEqual(format.enum, ['tensorcost']);
  assert.equal(format['x-ms-visibility'], 'internal');
  const body = bodyOf(op);
  assert.deepEqual(Object.keys(body.properties), ['logs'], 'an array or { logs }, never a bare row');
  assert.equal(body.properties.logs.maxItems, contract.components.schemas.GatewayLogPush.oneOf[1].properties.logs.maxItems, 'the contract\'s batch limit');
  const row = deref(swagger, body.properties.logs.items);
  for (const k of Object.keys(row.properties)) assert.ok(LOG_FIELDS.includes(k), `${k} is not a field of the tensorcost log format`);
  for (const k of LOG_REQUIRED) assert.ok(row.required.includes(k), `a row needs ${k}`);
  assert.equal(row.properties.log_id.maxLength, contract.components.schemas.GatewayLogRow.properties.log_id.maxLength, 'the contract\'s log_id limit');
  assert.equal(row.properties.correlation_id['x-ms-summary'], 'Decision ID', 'correlation_id is the check\'s Decision ID');
});

test('CheckBudget, RecordAiSpend and GetHeadroom take the same callers definition, so a call\'s spend lands on the team its check was made for', () => {
  const callersOf = (id) => {
    const [, , op] = opById(id);
    const b = bodyOf(op);
    const props2 = id === 'RecordAiSpend' ? deref(swagger, b.properties.logs.items).properties : b.properties;
    return props2.callers;
  };
  for (const id of ['CheckBudget', 'RecordAiSpend', 'GetHeadroom']) assert.deepEqual(callersOf(id), { $ref: '#/definitions/Callers' }, id);
  const kinds = swagger.definitions.Caller.properties.kind.enum;
  const sendable = new Set([...Object.keys(CALLER_KINDS.power_platform), 'tag', 'user']);
  for (const k of kinds) assert.ok(sendable.has(k), `a Power Platform connection doesn't read caller kind ${k}; the route would drop it`);
  assert.ok(kinds.includes('environment'), 'the flow\'s environment ID is how the connection maps to power_platform_env');
  assert.ok(!kinds.includes('team'), 'a Power Platform connection has no team caller kind: a team goes as a team=<name> tag');
  assert.equal(CALLER_KINDS.power_platform.environment, 'power_platform_env');
});

// ------------------------------------------------------------ 3. replayed against the mock

const KEY = 'tcgw_powerplatform_test';
let mock;
let base;

before(async () => {
  mock = createMock({ spec: SPEC_PATH, gatewayKind: 'power_platform', slowMs: 100 });
  base = await mock.listen(0);
});
after(() => mock?.close());

/** What a flow sends: the swagger's own query defaults, the connection's header, the body it was given. */
async function send(id, { body, path: pathParams = {} } = {}) {
  const [method, p, op] = opById(id);
  const schema = op.parameters.find((x) => x.in === 'body')?.schema;
  if (schema) {
    const problems = validate(swagger, schema, body, { strict: true });
    assert.deepEqual(problems, [], `${id}: the sample doesn't fit the swagger's own request schema`);
  }
  let url = swagger.basePath + p.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(pathParams[k]));
  const query = op.parameters.filter((x) => x.in === 'query').map((x) => `${x.name}=${x.default}`).join('&');
  if (query) url += `?${query}`;
  const res = await fetch(`${base}${url}`, {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: schema ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null, op };
}

const callers = (environment, extra = []) => [
  { kind: 'environment', id: environment },
  { kind: 'user', id: 'ana@acme.com' },
  { kind: 'tag', id: 'team=search' },
  ...extra,
];

/** The validator reads JSON Schema; OpenAPI 2.0 spells "may be null" x-nullable. */
function nullable(n) {
  if (Array.isArray(n)) return n.map(nullable);
  if (!n || typeof n !== 'object') return n;
  const out = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, nullable(v)]));
  if (out['x-nullable'] && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}
const asJsonSchema = nullable(swagger);

function answerFits(res, code) {
  const schema = res.op.responses[code].schema;
  assert.deepEqual(validate(asJsonSchema, nullable(deref(swagger, schema)), res.json), [], 'the answer fits the connector\'s own response schema');
}

test('mock: CheckBudget allows, names no dropped caller, and the unmapped environment is power_platform_env', async () => {
  const res = await send('CheckBudget', { body: { model: 'gpt-4o', provider: 'openai', max_tokens: 1000, input_tokens: 2000, callers: callers('Default-1a2b3c'), workflow_id: 'flow-1', can_reroute: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.decision, 'allow');
  assert.ok(!/ignored/.test(res.json.detail ?? ''), `a caller was dropped: ${res.json.detail}`);
  assert.deepEqual(res.json.attribution.unmapped, ['power_platform_env:Default-1a2b3c']);
  assert.equal(res.json.attribution.developer, 'ana@acme.com');
  answerFits(res, '200');
});

test('mock: a refusal is a 200 with decision refuse and a message', async () => {
  const res = await send('CheckBudget', { body: { model: 'gpt-4o', callers: callers('refuse-env') } });
  assert.equal(res.status, 200);
  assert.equal(res.json.decision, 'refuse');
  assert.ok(res.json.message);
  answerFits(res, '200');
});

test('mock: a caller kind a Power Platform connection doesn\'t read is dropped and named, which is why team goes as a tag', async () => {
  const res = await fetch(`${base}/v1/gateway/admit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'gpt-4o', callers: [{ kind: 'team', id: 'search' }] }),
  });
  assert.match((await res.json()).detail, /ignored: callers\[0\] \(kind "team"/);
});

test('mock: CancelCheck on the decision CheckBudget returned answers 200 with cancelled', async () => {
  const check = await send('CheckBudget', { body: { model: 'gpt-4o', max_tokens: 1000, input_tokens: 2000, callers: callers('Default-1a2b3c') } });
  const res = await send('CancelCheck', { path: { decision_id: check.json.decision_id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.decision_id, check.json.decision_id);
  assert.equal(res.json.cancelled, true);
  answerFits(res, '200');
  const again = await send('CancelCheck', { path: { decision_id: check.json.decision_id } });
  assert.equal(again.json.cancelled, false, 'a second cancel is a no-op');
});

test('mock: GetHeadroom answers with budgets and the connector\'s response schema fits them', async () => {
  const res = await send('GetHeadroom', { body: { team: 'search', estimate_cents: 50, callers: callers('Default-1a2b3c') } });
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.allowed, 'boolean');
  assert.ok(res.json.budgets.length >= 1);
  answerFits(res, '200');
  const empty = await send('GetHeadroom', { body: {} });
  assert.equal(empty.status, 200);
});

test('mock: the trigger subscribes with the platform\'s callback URL, answers 201 with a Location, and the platform deletes at that Location', async () => {
  const res = await send('OnBudgetThresholdCrossed', { body: { url: 'https://example.invalid/callback/abc', event_types: ['budget.threshold_crossed'] } });
  assert.equal(res.status, 201);
  const location = res.headers.get('location');
  assert.ok(location?.startsWith('/v1/gateway/subscriptions/'), location);
  assert.ok(location.endsWith(res.json.id));
  answerFits(res, '201');
  const del = await fetch(`${base}${location}`, { method: 'DELETE', headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(del.status, 204);
});

test('RecordAiSpend: a sample row fits the connector\'s schema and carries the check\'s callers and Decision ID', async () => {
  const check = await send('CheckBudget', { body: { model: 'gpt-4o', callers: callers('Default-1a2b3c') } });
  const [, , op] = opById('RecordAiSpend');
  const sample = {
    logs: [{
      log_id: `pp:${check.json.decision_id}`,
      provider: 'openai',
      model: 'gpt-4o',
      input_tokens: 1200,
      output_tokens: 300,
      started_at: '2026-11-16T09:30:00Z',
      correlation_id: check.json.decision_id,
      callers: callers('Default-1a2b3c'),
    }],
  };
  assert.deepEqual(validate(swagger, op.parameters.find((x) => x.in === 'body').schema, sample, { strict: true }), []);
  const row = sample.logs[0];
  assert.deepEqual(validate(contract, { $ref: '#/components/schemas/GatewayLogRow' }, row, { strict: true }), []);
  const checkCallers = JSON.stringify(callers('Default-1a2b3c'));
  assert.equal(JSON.stringify(row.callers), checkCallers, 'the same callers, kinds and values');
  assert.equal(row.log_id, `pp:${row.correlation_id}`, 'a retry sends the same log_id');
});
