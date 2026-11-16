// Runs the conformance cases (../cases.json) against a client, through a
// running @tensorcost/admit-mock. A client is wrapped in an adapter:
//
//   {
//     capabilities: ['reroute', 'cancel'],      // or 'no_reroute'; see README.md
//     async start({ url, key, fail_mode, timeout_ms, models }) -> client
//   }
//   client.call({ caller, model, max_tokens }) -> { outcome: 'sent'|'blocked', model?, message? }
//   client.fail({ status } | { timeout: true }) -> resolves once any cancel it sends is answered
//   client.close?()
//
// `call` makes one model call through the client, with `caller` as the
// caller id it sends to admit. `fail` says the last call the client sent
// failed at the provider that way.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadCases(file = path.join(HERE, '..', 'cases.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function mockJson(url, p, body) {
  const res = await fetch(`${url}${p}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`admit-mock ${p} answered ${res.status}`);
  return res.json();
}

/** Runs one case. Returns { id, status: 'pass'|'fail'|'skip', problems: string[] }. */
export async function runCase(def, { url, key = 'tcgw_conformance', adapter, defaults }) {
  const missing = (def.needs ?? []).filter((n) => !adapter.capabilities.includes(n));
  if (missing.length) return { id: def.id, status: 'skip', problems: [`needs ${missing.join(', ')}`] };

  const problems = [];
  const clientMode = def.client.fail_mode;
  await mockJson(url, '/_mock/reset', { fail_mode: def.workspace_fail_mode ?? clientMode });
  const client = await adapter.start({ url, key, fail_mode: clientMode, timeout_ms: defaults.timeout_ms, models: defaults.models });
  let lastDecision = null;
  try {
    for (const [i, step] of def.steps.entries()) {
      const where = `step ${i + 1}`;
      if (step.wait_ms) {
        await new Promise((r) => setTimeout(r, step.wait_ms));
        continue;
      }
      const before = await mockJson(url, '/_mock/log');
      if (step.call) {
        const want = step.expect;
        const got = await client.call({ caller: step.call, model: defaults.model, max_tokens: defaults.max_tokens });
        const log = await mockJson(url, '/_mock/log');
        const asked = log.admits.length > before.admits.length;
        if (got.outcome !== want.outcome) problems.push(`${where} (${step.call}): the call was ${got.outcome}, wants ${want.outcome}`);
        if (want.model && got.outcome === 'sent' && got.model !== want.model) problems.push(`${where} (${step.call}): sent as ${got.model}, wants ${want.model}`);
        if (want.admit === 'asked' && !asked) problems.push(`${where} (${step.call}): admit was not asked`);
        if (want.admit === 'not_asked' && asked) problems.push(`${where} (${step.call}): admit was asked`);
        if (log.admits.length - before.admits.length > 1) problems.push(`${where} (${step.call}): admit was asked ${log.admits.length - before.admits.length} times for one call`);
        if (want.message_contains && !(got.message ?? '').includes(want.message_contains)) {
          problems.push(`${where} (${step.call}): the refusal shown doesn't carry TensorCost's message (wants "${want.message_contains}")`);
        }
        const sent = asked ? log.admits.at(-1) : null;
        for (const [field, value] of Object.entries(want.request_has ?? {})) {
          if (!sent || sent.body?.[field] !== value) problems.push(`${where} (${step.call}): the admit request doesn't send ${field}: ${JSON.stringify(value)}`);
        }
        if (asked) lastDecision = sent.answer?.decision_id ?? null;
        else if (got.outcome === 'sent') lastDecision = null; // a reused allow has no decision of its own
      } else if (step.fail) {
        await client.fail(step.fail);
        const log = await mockJson(url, '/_mock/log');
        const fresh = log.cancels.slice(before.cancels.length);
        const what = step.fail.timeout ? 'a timeout' : `a ${step.fail.status}`;
        if (step.expect.cancel === 'sent') {
          if (fresh.length !== 1) problems.push(`${where}: after ${what} the client sent ${fresh.length} cancels, wants 1`);
          else if (lastDecision && fresh[0].decision_id !== lastDecision) problems.push(`${where}: the cancel names ${fresh[0].decision_id}, not the call's decision ${lastDecision}`);
          else if (fresh[0].cancelled !== true) problems.push(`${where}: the cancel did not drop the call's hold`);
        } else if (fresh.length) {
          problems.push(`${where}: after ${what} the client cancelled the call's hold; the call may have been billed`);
        }
      } else {
        throw new Error(`${def.id} ${where}: a step must be call, fail or wait_ms`);
      }
    }
    const log = await mockJson(url, '/_mock/log');
    if (!log.spec) problems.push('the mock has no OpenAPI file to check requests against (start it with --openapi)');
    if (def.after?.admits !== undefined && log.admits.length !== def.after.admits) problems.push(`admit was asked ${log.admits.length} times, wants ${def.after.admits}`);
    if (def.after?.cancels !== undefined && log.cancels.length !== def.after.cancels) problems.push(`${log.cancels.length} cancels, wants ${def.after.cancels}`);
    for (const [i, a] of log.admits.entries()) {
      for (const e of a.request_errors ?? []) problems.push(`admit request ${i + 1} doesn't match the OpenAPI file: ${e}`);
      for (const e of a.response_errors ?? []) problems.push(`the mock's answer ${i + 1} doesn't match the OpenAPI file (a mock bug): ${e}`);
    }
  } finally {
    await client.close?.();
  }
  return { id: def.id, status: problems.length ? 'fail' : 'pass', problems };
}

/** Runs every case (or those named in `only`). */
export async function runCases({ url, key, adapter, cases = loadCases(), only }) {
  const out = [];
  for (const def of cases.cases) {
    if (only && !only.includes(def.id)) continue;
    out.push(await runCase(def, { url, key, adapter, defaults: cases.client }));
  }
  return out;
}
