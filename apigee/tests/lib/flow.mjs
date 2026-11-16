// A stand-in for an Apigee proxy, enough to run the two shared flows step by
// step: it reads each Step and Condition from sharedflows/default.xml, runs
// each policy as its XML says (the JavaScript ones in node:vm), and models
// only what the flows rely on. It is not Apigee: what it assumes about
// Apigee is written next to each policy type below, and the README lists
// what only a real Apigee can confirm.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { evaluate } from './condition.mjs';
import { child, children, parseXml, textAt } from './xml.mjs';

export const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

/** A bundle's files from disk, keyed like the zip: sharedflowbundle/... */
export function readBundle(name) {
  const dir = path.join(HERE, name);
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return files;
}

/** The open bundle as it would be rendered closed: the two values the renderer changes. */
export function closedVariant(files) {
  const out = {};
  for (const [p, c] of Object.entries(files)) {
    let s = c;
    if (p.endsWith('/TC-Admit.xml')) s = s.replace('continueOnError="true"', 'continueOnError="false"').replace(/<!-- Fail open:[^>]*-->/, '<!-- Fail closed: a timeout or error faults the proxy here, and the target is never called. -->');
    s = s.replace('<Property name="failMode">open</Property>', '<Property name="failMode">closed</Property>');
    s = s.replace("Fail mode when TensorCost can't answer: open.", "Fail mode when TensorCost can't answer: closed.");
    out[p] = s;
  }
  return out;
}

class Fault extends Error {
  constructor(name, status, headers = {}, body = '') {
    super(name);
    this.faultName = name;
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

function template(s, vars, ignoreUnresolved) {
  return s.replace(/\{([A-Za-z_][\w.-]*)\}/g, (_, name) => {
    const v = vars[name];
    if (v === undefined || v === null) {
      if (!ignoreUnresolved) throw new Error(`unresolved variable ${name}`);
      return '';
    }
    return String(v);
  });
}

function jsonPath(content, p) {
  const m = /^\$\.([A-Za-z_]\w*)$/.exec(p);
  if (!m) throw new Error(`JSONPath ${p} isn't one this stand-in reads`);
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    return undefined;
  }
  const v = doc?.[m[1]];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Runs one shared flow. `env` holds what outlives a call: the KVM, the
 * cache, the quota counters, the shared flows a FlowCallout names, and
 * `callout(request)`, which answers a ServiceCallout ({ status, body,
 * headers } or { timeout: true }).
 */
export function runSharedFlow(files, vars, env) {
  const flow = parseXml(files['sharedflowbundle/sharedflows/default.xml']);
  runSteps(children(flow, 'Step'), files, 'sharedflowbundle/', vars, env);
}

/** Steps in order, each run when its Condition holds; `root` is sharedflowbundle/ or apiproxy/. */
export function runSteps(steps, files, root, vars, env) {
  for (const s of steps) {
    const name = textAt(s, 'Name');
    const cond = textAt(s, 'Condition');
    if (cond && !evaluate(cond, vars)) continue;
    const xml = files[`${root}policies/${name}.xml`];
    if (!xml) throw new Error(`no policy ${name}`);
    const policy = parseXml(xml);
    if (policy.attrs.name !== name) throw new Error(`${name}.xml names ${policy.attrs.name}`);
    const keepGoing = policy.attrs.continueOnError === 'true';
    try {
      runPolicy(policy, files, root, vars, env);
    } catch (err) {
      if (err instanceof Fault) throw err;
      // A policy that fails: Apigee faults unless continueOnError is true.
      if (!keepGoing) throw new Fault('PolicyFailed:' + name, 500, {}, String(err.message));
    }
  }
}

function runPolicy(p, files, root, vars, env) {
  const ignore = textAt(p, 'IgnoreUnresolvedVariables') === 'true';
  switch (p.name) {
    case 'KeyValueMapOperations': {
      const get = child(p, 'Get');
      const key = textAt(get, 'Key', 'Parameter');
      vars[get.attrs.assignTo] = env.kvm?.[p.attrs.mapIdentifier]?.[key] ?? null;
      return;
    }
    case 'AssignMessage': {
      if (child(p, 'AssignTo')?.attrs.type !== 'request') throw new Error('AssignMessage on something other than the request');
      const set = child(p, 'Set');
      for (const h of children(child(set, 'Headers') ?? { children: [] }, 'Header')) vars[`request.header.${h.attrs.name.toLowerCase()}`] = template(h.text, vars, ignore);
      const payload = child(set, 'Payload');
      if (payload) vars['request.content'] = template(payload.text, vars, ignore);
      return;
    }
    case 'Javascript': {
      const props = {};
      for (const pr of children(child(p, 'Properties'), 'Property')) props[pr.attrs.name] = pr.text;
      const src = (u) => files[`${root}resources/jsc/${u.replace(/^jsc:\/\//, '')}`];
      const code = children(p, 'IncludeURL').map((i) => src(i.text.trim())).join('\n') + '\n' + src(textAt(p, 'ResourceURL'));
      const context = {
        getVariable: (n) => (vars[n] === undefined ? null : vars[n]),
        setVariable: (n, v) => {
          vars[n] = v === null || v === undefined ? null : String(v);
        },
      };
      vm.runInNewContext(code, { context, properties: props }, { timeout: 1000 });
      return;
    }
    case 'LLMTokenQuota': {
      const allowEl = child(p, 'Allow');
      const ref = allowEl.attrs.countRef ? vars[allowEl.attrs.countRef] : null;
      const allow = ref !== null && ref !== undefined && /^\d+$/.test(String(ref)) ? Number(ref) : Number(allowEl.attrs.count);
      const id = vars[child(p, 'Identifier').attrs.ref] ?? '';
      const key = `${textAt(p, 'SharedName')}|${id}`;
      const used = env.counters.get(key) ?? 0;
      const name = p.attrs.name;
      const model = template(textAt(p, 'LLMModelSource') ?? '', vars, true);
      if (textAt(p, 'EnforceOnly') === 'true') {
        vars[`ratelimit.${name}.used.count`] = String(used);
        vars[`ratelimit.${name}.allowed.count`] = String(allow);
        vars[`ratelimit.${name}.failed`] = 'false';
        if (used >= allow) {
          // policies.llmtokenquota.LLMTokenQuotaViolation (429): under continueOnError the flow goes on with failed set.
          vars[`ratelimit.${name}.failed`] = 'true';
          if (p.attrs.continueOnError !== 'true') throw new Fault('LLMTokenQuotaViolation', 429, {}, '{"fault":"quota"}');
        }
        return;
      }
      const add = Number(template(textAt(p, 'LLMTokenUsageSource'), vars, false));
      if (!Number.isFinite(add)) throw new Error('LLMTokenUsageSource is not a number');
      env.counters.set(key, used + add);
      vars[`ratelimit.${name}.used.count`] = String(used + add);
      vars[`ratelimit.${name}.allowed.count`] = String(allow);
      vars[`llmtokenquota.${name}.model`] = model;
      return;
    }
    case 'LookupCache':
    case 'PopulateCache': {
      const ck = child(p, 'CacheKey');
      const frag = child(ck, 'KeyFragment');
      const key = `${textAt(ck, 'Prefix')}__${frag.attrs.ref ? vars[frag.attrs.ref] : frag.text.trim()}`;
      if (p.name === 'LookupCache') {
        if (env.cache.has(key)) vars[textAt(p, 'AssignTo')] = env.cache.get(key).value;
        return;
      }
      const t = child(child(p, 'ExpirySettings'), 'TimeoutInSeconds');
      const ttl = Number(t.attrs.ref ? vars[t.attrs.ref] : t.text);
      env.cache.set(key, { value: vars[textAt(p, 'Source')], ttl });
      return;
    }
    case 'ServiceCallout': {
      const name = p.attrs.name;
      const req = child(p, 'Request');
      const set = child(req, 'Set');
      const reqIgnore = textAt(req, 'IgnoreUnresolvedVariables') === 'true';
      const headers = {};
      for (const h of children(child(set, 'Headers'), 'Header')) headers[h.attrs.name.toLowerCase()] = template(h.text, vars, reqIgnore);
      const payload = child(set, 'Payload');
      if (payload) headers['content-type'] = payload.attrs.contentType;
      const request = {
        policy: name,
        method: textAt(set, 'Verb'),
        url: template(textAt(p, 'HTTPTargetConnection', 'URL'), vars, reqIgnore),
        headers,
        body: payload ? template(payload.text, vars, reqIgnore) : '',
        timeoutMs: Number(textAt(p, 'Timeout')),
      };
      const responseVar = textAt(p, 'Response');
      env.sent.push({ ...request, waited: responseVar !== undefined });
      const answer = env.callout(request);
      if (responseVar === undefined) return; // fire and forget: nothing comes back to the flow
      vars[`servicecallout.${name}.failed`] = 'false';
      if (answer.timeout) {
        vars[`servicecallout.${name}.failed`] = 'true';
        throw new Error('ServiceCallout timed out');
      }
      vars[`${responseVar}.status.code`] = String(answer.status);
      vars[`${responseVar}.content`] = answer.body ?? '';
      for (const [h, v] of Object.entries(answer.headers ?? {})) vars[`${responseVar}.header.${h.toLowerCase()}`] = v;
      // By default a 4xx or 5xx is a failure (steps.servicecallout.ExecutionFailed).
      if (answer.status >= 400) {
        vars[`servicecallout.${name}.failed`] = 'true';
        throw new Error(`ServiceCallout answered ${answer.status}`);
      }
      return;
    }
    case 'ExtractVariables': {
      const src = textAt(p, 'Source');
      const content = vars[`${src}.content`];
      if (content === undefined || content === null) throw new Error(`no message ${src}`);
      const prefix = textAt(p, 'VariablePrefix');
      for (const v of children(child(p, 'JSONPayload'), 'Variable')) {
        const got = jsonPath(content, textAt(v, 'JSONPath'));
        if (got !== undefined) vars[`${prefix}.${v.attrs.name}`] = got;
      }
      return;
    }
    case 'RaiseFault': {
      const set = child(child(p, 'FaultResponse'), 'Set');
      const headers = {};
      for (const h of children(child(set, 'Headers') ?? { children: [] }, 'Header')) headers[h.attrs.name] = template(h.text, vars, ignore);
      const payload = child(set, 'Payload');
      throw new Fault('RaiseFault', Number(textAt(set, 'StatusCode')), { ...headers, 'Content-Type': payload.attrs.contentType }, template(payload.text, vars, ignore));
    }
    case 'FlowCallout': {
      const flow = env.sharedFlows?.[textAt(p, 'SharedFlowBundle')];
      if (!flow) throw new Error(`no shared flow ${textAt(p, 'SharedFlowBundle')}`);
      runSharedFlow(flow, vars, env);
      return;
    }
    case 'VerifyAPIKey':
      // The call's request variables stand for what VerifyAPIKey sets.
      return;
    default:
      throw new Error(`no stand-in for ${p.name}`);
  }
}

let seq = 0;

const PROXY = readBundle('tensorcost-proxy-example');
const FINAL = readBundle('tensorcost-usage-final');
const stepsOf = (el, ...path) => {
  let at = el;
  for (const n of path) at = at && child(at, n);
  return at ? children(at, 'Step') : [];
};

/**
 * One call through the example proxy (tensorcost-proxy-example), its
 * attachments read from its own proxies/default.xml and targets/default.xml:
 * the ProxyEndpoint request PreFlow (VerifyAPIKey, then tensorcost-admit),
 * the target, the TargetEndpoint response PreFlow (tensorcost-usage), the
 * EventFlow for each event of a stream, and the PostClientFlow; the
 * DefaultFaultRule when anything faulted.
 *
 *   target(vars): { status, body, contentType? } | { status, events: [data...] } (streaming on) | { timeout: true }
 *   refuseAfterAdmit: a later request-flow policy of the proxy's own refuses the call.
 */
export function runCall({ admit, usage, final = FINAL, proxy = PROXY, env, request = {}, target, refuseAfterAdmit = false }) {
  env.sharedFlows = { 'tensorcost-admit': admit, 'tensorcost-usage': usage, 'tensorcost-usage-final': final };
  const pe = parseXml(proxy['apiproxy/proxies/default.xml']);
  const te = parseXml(proxy['apiproxy/targets/default.xml']);
  const t0 = 1_763_200_000_000 + seq * 1000;
  const vars = {
    messageid: `rrt-${++seq}-0123456789abcdef`,
    'client.received.start.timestamp': String(t0),
    'system.timestamp': String(t0 + 900),
    'request.path': '/v1/chat/completions',
    'request.content': JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'SECRET PROMPT' }], max_tokens: 256 }),
    ...request,
  };
  const out = { vars, fault: null, targetCalled: false, targetRequest: null, response: null, events: 0 };
  const postClient = () => {
    try {
      runSteps(stepsOf(pe, 'PostClientFlow', 'Response'), proxy, 'apiproxy/', vars, env);
    } catch {
      /* the client already has its answer */
    }
  };
  const faultFlow = (f) => {
    out.fault = f;
    vars['fault.name'] = f.faultName;
    vars['error.status.code'] = String(f.status);
    const rule = child(pe, 'DefaultFaultRule');
    runSteps(children(rule, 'Step'), proxy, 'apiproxy/', vars, env);
    postClient();
    return out;
  };
  try {
    runSteps(stepsOf(pe, 'PreFlow', 'Request'), proxy, 'apiproxy/', vars, env);
    if (refuseAfterAdmit) throw new Fault('SpikeArrestViolation', 429);
  } catch (f) {
    if (!(f instanceof Fault)) throw f;
    return faultFlow(f);
  }
  out.targetCalled = true;
  out.targetRequest = { headers: Object.fromEntries(Object.entries(vars).filter(([k]) => k.startsWith('request.header.')).map(([k, v]) => [k.slice(15), v])), body: vars['request.content'] };
  vars['target.sent.start.timestamp'] = String(t0 + 10);
  vars['target.url'] = vars['target.url'] ?? 'https://api.openai.com/v1/chat/completions';
  const answer = target(vars);
  if (answer.timeout) return faultFlow(new Fault('GatewayTimeout', 504));
  const streamed = Array.isArray(answer.events);
  vars['target.received.start.timestamp'] = String(t0 + 500);
  if (!streamed) vars['target.received.end.timestamp'] = String(t0 + 800);
  vars['message.status.code'] = String(answer.status);
  vars['response.status.code'] = String(answer.status);
  vars['response.header.content-type'] = streamed ? 'text/event-stream' : (answer.contentType ?? 'application/json');
  // Streaming on: the body goes to the client event by event, never into response.content.
  vars['response.content'] = streamed ? '' : answer.body;
  if (answer.status >= 400) return faultFlow(new Fault('ErrorResponseCode', answer.status));
  try {
    runSteps(stepsOf(te, 'PreFlow', 'Response'), proxy, 'apiproxy/', vars, env);
    runSteps(stepsOf(pe, 'PreFlow', 'Response'), proxy, 'apiproxy/', vars, env);
    if (streamed) {
      const ef = child(te, 'EventFlow');
      if (!ef || ef.attrs['content-type'] !== 'text/event-stream') throw new Error('no text/event-stream EventFlow on the target');
      for (const [i, data] of answer.events.entries()) {
        vars['response.event.current.data'] = data;
        vars['response.event.current.content'] = `data: ${data}\n\n`;
        vars['response.event.current.count'] = String(i + 1);
        runSteps(stepsOf(ef, 'Response'), proxy, 'apiproxy/', vars, env);
        out.events++;
      }
      vars['target.received.end.timestamp'] = String(t0 + 800);
    }
  } catch (f) {
    if (!(f instanceof Fault)) throw f;
    return faultFlow(f);
  }
  out.response = { status: answer.status, body: answer.body };
  postClient();
  return out;
}

/** A fresh gateway environment: KVM with the key, an empty cache and counters, and TensorCost's answers. */
export function newEnv(tensorcost) {
  return {
    kvm: { tensorcost: { 'tensorcost-gateway-key': 'tcgw_test_key' } },
    cache: new Map(),
    counters: new Map(),
    sent: [],
    callout: tensorcost,
  };
}
