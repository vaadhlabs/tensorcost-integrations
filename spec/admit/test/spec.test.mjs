// The package's own checks: the OpenAPI file reads with the mock's reader,
// every $ref names something, the example rows fit GatewayLogRow, and the
// files the package ships are the ones its entry point names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadSpec, validate } from '../../../admit-mock/src/openapi.mjs';
import { specPath, readmePath, examplesDir, exampleRows, readSpec } from '../index.mjs';

const spec = loadSpec(specPath);

test('the entry point names files that exist', () => {
  for (const p of [specPath, readmePath, examplesDir]) assert.ok(fs.existsSync(p), p);
  assert.match(readSpec(), /^openapi: 3\.1\.0/);
});

test('every $ref in the OpenAPI file names a schema', () => {
  const refs = [...readSpec().matchAll(/\$ref: "#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 10);
  for (const r of refs) assert.ok(spec.components.schemas[r], r);
});

test('every operation has an operationId and the gateway key', () => {
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      assert.ok(op.operationId, `${method} ${route}`);
      assert.deepEqual(op.security, [{ gatewayKey: [] }], `${method} ${route}`);
    }
  }
});

test('each example row fits GatewayLogRow, strictly, and a push of them fits the request body', () => {
  const rows = exampleRows();
  assert.deepEqual(Object.keys(rows).sort(), ['apigee', 'power-platform', 'workato']);
  const row = { $ref: '#/components/schemas/GatewayLogRow' };
  for (const [name, r] of Object.entries(rows)) assert.deepEqual(validate(spec, row, r, { strict: true }), [], name);
  const push = spec.paths['/gateway/logs'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(validate(spec, push, Object.values(rows)), []);
  assert.deepEqual(validate(spec, push, { logs: Object.values(rows) }), []);
  assert.notDeepEqual(validate(spec, push, []), []);
});

test('a row missing a required field does not fit', () => {
  const row = { $ref: '#/components/schemas/GatewayLogRow' };
  for (const field of ['log_id', 'provider', 'model', 'started_at']) {
    const r = { ...exampleRows().workato };
    delete r[field];
    assert.notDeepEqual(validate(spec, row, r), [], field);
  }
});
