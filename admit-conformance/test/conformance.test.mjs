// The cases checked against themselves: the reference client passes every
// case that applies to it, a client that breaks one rule fails the case for
// that rule, and every call step's caller gets the answer the case says.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from '../../admit-mock/src/server.mjs';
import { loadCases, runCase, runCases } from '../lib/runner.mjs';
import { referenceAdapter } from '../lib/reference-client.mjs';

const cases = loadCases();
let mock;
let url;

before(async () => {
  mock = createMock();
  assert.ok(mock.spec, 'the mock must find the admit OpenAPI file');
  url = await mock.listen(0);
});
after(() => mock.close());

function byId(results) {
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

test('the cases file is well formed', () => {
  const ids = new Set();
  for (const c of cases.cases) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(['must', 'should'].includes(c.level), c.id);
    assert.ok(['open', 'closed'].includes(c.client.fail_mode), c.id);
    assert.ok(c.rule && c.summary, c.id);
    for (const n of c.needs ?? []) assert.ok(['reroute', 'no_reroute', 'cancel'].includes(n), `${c.id}: ${n}`);
    for (const s of c.steps) {
      const kinds = ['call', 'fail', 'wait_ms'].filter((k) => k in s);
      assert.equal(kinds.length, 1, `${c.id}: a step is one of call, fail, wait_ms`);
      if (s.call) assert.ok(['sent', 'blocked'].includes(s.expect.outcome), `${c.id}: ${s.call}`);
      if (s.fail) assert.ok(['sent', 'not_sent'].includes(s.expect.cancel), c.id);
    }
  }
  // The three the task names.
  for (const id of ['refusal-arrives-as-200', 'timeout-fail-open-sends-the-call', 'timeout-fail-closed-blocks-the-call', 'allow-cached-no-longer-than-its-ttl']) {
    assert.ok(ids.has(id), id);
  }
});

test('a client that can reroute passes every case that applies to it', async () => {
  const results = await runCases({ url, adapter: referenceAdapter({ canReroute: true }), cases });
  for (const r of results) assert.notEqual(r.status, 'fail', `${r.id}: ${r.problems.join('; ')}`);
  assert.deepEqual(results.filter((r) => r.status === 'skip').map((r) => r.id), ['a-client-that-cannot-reroute-opts-out']);
});

test('a client that cannot reroute passes every case that applies to it', async () => {
  const results = await runCases({ url, adapter: referenceAdapter({ canReroute: false }), cases });
  for (const r of results) assert.notEqual(r.status, 'fail', `${r.id}: ${r.problems.join('; ')}`);
  assert.deepEqual(results.filter((r) => r.status === 'skip').map((r) => r.id), ['reroute-is-followed-by-a-client-that-can-rewrite-the-model']);
});

test('each broken rule fails its case', async () => {
  const expectFail = async (faults, ids) => {
    const results = byId(await runCases({ url, adapter: referenceAdapter({ faults }), cases, only: ids }));
    for (const id of ids) assert.equal(results[id].status, 'fail', `${JSON.stringify(faults)} should fail ${id}`);
  };
  await expectFail({ statusOnly: true }, ['refusal-arrives-as-200', 'closed-workspace-refusal-is-a-refusal', 'error-fail-closed-blocks-the-call']);
  await expectFail({ retryAdmit: true }, ['timeout-fail-open-sends-the-call', 'error-fail-open-sends-the-call']);
  await expectFail({ cacheAll: true }, ['ttl-zero-allow-is-never-reused', 'degraded-allow-sends-the-call-and-is-not-reused', 'allow-cached-no-longer-than-its-ttl']);
  await expectFail({ cancelAll: true }, ['no-cancel-and-no-resend-after-a-billed-or-unknown-answer']);
  await expectFail({ adoptUnknownMode: true }, ['fail-mode-unknown-is-not-adopted']);
});

test('a case that needs a capability the client lacks is skipped, not failed', async () => {
  const def = cases.cases.find((c) => c.id === 'cancel-a-call-that-never-ran');
  const r = await runCase(def, { url, adapter: { capabilities: [], start: () => assert.fail('not started') }, defaults: cases.client });
  assert.equal(r.status, 'skip');
});
