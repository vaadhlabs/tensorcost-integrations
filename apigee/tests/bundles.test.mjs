// The two bundles as files: well-formed XML, the shape Apigee imports, and
// the settings the admit contract (spec/admit/openapi.yaml) asks of
// a gateway client. Run with `node --test` from apigee/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readBundle } from './lib/flow.mjs';
import { child, children, parseXml, textAt } from './lib/xml.mjs';

const admit = readBundle('tensorcost-admit');
const usage = readBundle('tensorcost-usage');
const final = readBundle('tensorcost-usage-final');
const proxy = readBundle('tensorcost-proxy-example');
const hasXmllint = !spawnSync('xmllint', ['--version']).error;
const policy = (files, name) => parseXml(files[`sharedflowbundle/policies/${name}.xml`]);

test('every ServiceCallout names itself in a User-Agent, so the WAF\'s NoUserAgent_HEADER rule never blocks it', () => {
  const callouts = [];
  for (const files of [admit, usage, final, proxy]) {
    for (const [p, xml] of Object.entries(files)) {
      if (!p.endsWith('.xml') || !/<ServiceCallout\b/.test(xml)) continue;
      callouts.push(p);
      assert.match(xml, /<Header name="User-Agent">TensorCost-Apigee\/\d+\.\d+\.\d+<\/Header>/, p);
    }
  }
  // Admit, the usage row, the cancel and the streamed call's row.
  assert.deepEqual(callouts.map((p) => p.split('/').pop()).sort(), ['TC-Admit.xml', 'TC-Cancel.xml', 'TC-StreamLog.xml', 'TC-UsageLog.xml']);
});

test('every XML file in every bundle is well-formed', () => {
  for (const files of [admit, usage, final, proxy]) {
    for (const [p, xml] of Object.entries(files)) {
      if (!p.endsWith('.xml')) continue;
      assert.doesNotThrow(() => parseXml(xml), p);
      if (hasXmllint) {
        const lint = spawnSync('xmllint', ['--noout', '-'], { input: xml, encoding: 'utf8' });
        assert.equal(lint.status, 0, `${p}: ${lint.stderr}`);
      }
    }
  }
});

test('each bundle lists exactly the policies and scripts it carries, and every step names one', () => {
  for (const [files, name] of [[admit, 'tensorcost-admit'], [usage, 'tensorcost-usage'], [final, 'tensorcost-usage-final']]) {
    const d = parseXml(files[`sharedflowbundle/${name}.xml`]);
    assert.equal(d.name, 'SharedFlowBundle');
    assert.equal(d.attrs.name, name);
    const listed = children(child(d, 'Policies'), 'Policy').map((p) => p.text.trim()).sort();
    const present = Object.keys(files).filter((p) => p.startsWith('sharedflowbundle/policies/')).map((p) => p.slice(26, -4)).sort();
    assert.deepEqual(listed, present, name);
    const scripts = children(child(d, 'Resources'), 'Resource').map((r) => r.text.trim()).sort();
    const js = Object.keys(files).filter((p) => p.includes('/resources/jsc/')).map((p) => `jsc://${p.split('/').pop()}`).sort();
    assert.deepEqual(scripts, js, name);
    const flow = parseXml(files['sharedflowbundle/sharedflows/default.xml']);
    const steps = children(flow, 'Step').map((s) => textAt(s, 'Name'));
    assert.deepEqual([...steps].sort(), present, `${name}: every policy is a step, once`);
  }
});

test('every bundle carries the same common script, so callers and usage are read one way', () => {
  assert.equal(admit['sharedflowbundle/resources/jsc/tensorcost-common.js'], usage['sharedflowbundle/resources/jsc/tensorcost-common.js']);
  assert.equal(proxy['apiproxy/resources/jsc/tensorcost-common.js'], usage['sharedflowbundle/resources/jsc/tensorcost-common.js']);
});

test('the example proxy lists exactly its policies and scripts, and every step names one', () => {
  const d = parseXml(proxy['apiproxy/tensorcost-proxy-example.xml']);
  assert.equal(d.name, 'APIProxy');
  const listed = children(child(d, 'Policies'), 'Policy').map((p) => p.text.trim()).sort();
  const present = Object.keys(proxy).filter((p) => p.startsWith('apiproxy/policies/')).map((p) => p.slice(18, -4)).sort();
  assert.deepEqual(listed, present);
  const steps = [];
  const walk = (el) => {
    if (el.name === 'Step') steps.push(textAt(el, 'Name'));
    el.children.forEach(walk);
  };
  walk(parseXml(proxy['apiproxy/proxies/default.xml']));
  walk(parseXml(proxy['apiproxy/targets/default.xml']));
  for (const st of steps) assert.ok(present.includes(st), st);
});

test('the attachments: admit after VerifyAPIKey, usage first in the target response, the EventFlow, the PostClientFlow and the fault rule', () => {
  const pe = parseXml(proxy['apiproxy/proxies/default.xml']);
  const te = parseXml(proxy['apiproxy/targets/default.xml']);
  const names = (el) => children(el, 'Step').map((x) => textAt(x, 'Name'));
  assert.deepEqual(names(child(child(pe, 'PreFlow'), 'Request')), ['VerifyAPIKey', 'FC-TensorCostAdmit']);
  assert.equal(names(child(child(te, 'PreFlow'), 'Response'))[0], 'FC-TensorCostUsage');
  assert.deepEqual(names(child(pe, 'DefaultFaultRule')), ['FC-TensorCostUsage']);
  assert.equal(textAt(pe, 'DefaultFaultRule', 'AlwaysEnforce'), 'true');
  assert.deepEqual(names(child(child(pe, 'PostClientFlow'), 'Response')), ['FC-TensorCostUsageFinal']);
  const ef = child(te, 'EventFlow');
  assert.equal(ef.attrs['content-type'], 'text/event-stream');
  // An EventFlow takes at most four policies, of a few types (the server-sent events reference).
  const efSteps = names(child(ef, 'Response'));
  assert.ok(efSteps.length <= 4);
  for (const st of efSteps) assert.ok(['Javascript', 'LLMTokenQuota'].includes(parseXml(proxy[`apiproxy/policies/${st}.xml`]).name), st);
  // A PostClientFlow takes FlowCallout, MessageLogging and ServiceCallout, and a shared flow it calls holds only those.
  for (const [p, c] of Object.entries(final)) if (p.includes('/policies/')) assert.equal(parseXml(c).name, 'ServiceCallout', p);
});

test('the admit callout: 1,000 ms, continueOnError true (open), the answer in tcAdmit, the key from the KVM', () => {
  const sc = policy(admit, 'TC-Admit');
  assert.equal(sc.attrs.continueOnError, 'true');
  assert.equal(textAt(sc, 'Timeout'), '1000');
  assert.equal(textAt(sc, 'Response'), 'tcAdmit');
  assert.match(textAt(sc, 'HTTPTargetConnection', 'URL'), /^https:\/\/[^/]+\/api\/inference-proxy\/v1\/gateway\/admit$/);
  const auth = children(child(child(child(sc, 'Request'), 'Set'), 'Headers'), 'Header').find((h) => h.attrs.name === 'Authorization');
  assert.equal(auth.text, 'Bearer {private.tensorcost.key}');
  const kvm = policy(admit, 'TC-Key');
  assert.equal(kvm.attrs.mapIdentifier, 'tensorcost');
  assert.equal(child(kvm, 'Get').attrs.assignTo, 'private.tensorcost.key');
  // The key itself is never in a bundle.
  for (const files of [admit, usage]) for (const [p, c] of Object.entries(files)) assert.doesNotMatch(c, /tcgw_[A-Za-z0-9]/, p);
});

test('ExtractVariables reads decision, model and message from tcAdmit', () => {
  const ev = policy(admit, 'TC-ReadAnswer');
  assert.equal(textAt(ev, 'Source'), 'tcAdmit');
  assert.equal(textAt(ev, 'VariablePrefix'), 'tcAnswer');
  const got = Object.fromEntries(children(child(ev, 'JSONPayload'), 'Variable').map((v) => [v.attrs.name, textAt(v, 'JSONPath')]));
  assert.deepEqual(got, { decision: '$.decision', model: '$.model', message: '$.message' });
});

test('the 429 branches test decision = "refuse", never a status code', () => {
  const flow = parseXml(admit['sharedflowbundle/sharedflows/default.xml']);
  for (const name of ['TC-Refuse', 'TC-Refuse-RetryAfter']) {
    const s = children(flow, 'Step').find((x) => textAt(x, 'Name') === name);
    const cond = textAt(s, 'Condition');
    assert.match(cond, /tcAnswer\.decision = "refuse"/);
    assert.doesNotMatch(cond, /status/i);
    const rf = policy(admit, name);
    assert.equal(textAt(rf, 'FaultResponse', 'Set', 'StatusCode'), '429');
  }
  const retry = child(child(child(policy(admit, 'TC-Refuse-RetryAfter'), 'FaultResponse'), 'Set'), 'Headers');
  assert.equal(children(retry, 'Header')[0].attrs.name, 'Retry-After');
  // No condition anywhere in the admit flow reads a status code.
  assert.doesNotMatch(admit['sharedflowbundle/sharedflows/default.xml'], /status\.code/);
});

test('on reroute AssignMessage sets the request body that has its model rewritten', () => {
  const am = policy(admit, 'TC-Reroute');
  assert.equal(child(am, 'AssignTo').attrs.type, 'request');
  assert.equal(textAt(am, 'Set', 'Payload'), '{tensorcost.rerouted_body}');
});

test('the product quota: EnforceOnly before the check, CountOnly in the usage flow, one counter, the pushed attribute', () => {
  const enforce = policy(admit, 'TC-TokenQuota');
  const count = policy(usage, 'TC-TokenCount');
  for (const q of [enforce, count]) {
    assert.equal(child(q, 'Allow').attrs.countRef, 'verifyapikey.VerifyAPIKey.apiproduct.tensorcost_llm_quota');
    assert.equal(textAt(q, 'SharedName'), 'tensorcost-llm-tokens');
    assert.equal(child(q, 'Identifier').attrs.ref, 'tensorcost.quota_identifier');
  }
  assert.equal(textAt(enforce, 'EnforceOnly'), 'true');
  assert.equal(textAt(count, 'CountOnly'), 'true');
  const steps = children(parseXml(admit['sharedflowbundle/sharedflows/default.xml']), 'Step').map((s) => textAt(s, 'Name'));
  assert.ok(steps.indexOf('TC-TokenQuota') < steps.indexOf('TC-Admit'));
});

test('the usage callouts are fire and forget (no <Response>), to the tensorcost log format and the cancel route', () => {
  const log = policy(usage, 'TC-UsageLog');
  assert.equal(child(log, 'Response'), undefined);
  assert.match(textAt(log, 'HTTPTargetConnection', 'URL'), /\/v1\/gateway\/logs\?format=tensorcost$/);
  const cancel = policy(usage, 'TC-Cancel');
  assert.equal(child(cancel, 'Response'), undefined);
  assert.match(textAt(cancel, 'HTTPTargetConnection', 'URL'), /\/v1\/gateway\/admit\/\{tensorcost\.decision_id\}\/cancel$/);
  const steps = children(parseXml(usage['sharedflowbundle/sharedflows/default.xml']), 'Step').map((s) => textAt(s, 'Name'));
  assert.deepEqual(steps, ['TC-UsageKey', 'TC-UsageRead', 'TC-TokenCount', 'TC-UsageRow', 'TC-UsageLog', 'TC-Cancel']);
});

test('the only host any shared flow names is the placeholder', () => {
  for (const files of [admit, usage, final]) {
    for (const [p, c] of Object.entries(files)) {
      if (!p.endsWith('.xml')) continue;
      const hosts = [...c.matchAll(/https:\/\/([^/"'<]+)/g)].map((m) => m[1]);
      for (const h of hosts) assert.equal(h, 'tensorcost.example.com', p);
    }
  }
});

test('the scripts are ES5 that Apigee Rhino runs: no arrow functions, let, const or template literals', () => {
  for (const files of [admit, usage, proxy]) {
    for (const [p, c] of Object.entries(files)) {
      if (!p.endsWith('.js')) continue;
      assert.doesNotMatch(c, /=>|\blet\s|\bconst\s|`/, p);
    }
  }
});
