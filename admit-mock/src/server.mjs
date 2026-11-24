// A local stand-in for TensorCost's gateway admit route, for testing a
// gateway client against the admit protocol (spec/admit in this repository).
// The answer is picked by the caller ids in the request, so a client's own
// configuration (a team, a key, a tag) chooses what it gets back. Node
// built-ins only.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { findSpec, loadSpec, operationSchemas, validate } from './openapi.mjs';

/** Gateway kinds TensorCost answers `reroute` to: the ones that can rewrite a call's model. */
export const REROUTE_KINDS = new Set(['litellm', 'azure_apim', 'apigee']);

/** Each gateway kind's caller kinds and the alias kind each is mapped under. `tag`, `user` and `developer` are taken from every gateway. */
export const CALLER_KINDS = {
  litellm: { team: 'litellm_team', user: 'litellm_user', key: 'litellm_key' },
  azure_apim: { subscription: 'apim_subscription', user: 'apim_user', product: 'apim_product' },
  apigee: { app: 'apigee_app', developer: 'apigee_developer', product: 'apigee_product' },
  kong: { consumer: 'kong_consumer' },
  workato: { key: 'workato_key', team: 'workato_team' },
  power_platform: { environment: 'power_platform_env' },
  generic: {},
};
const PERSON_KINDS = ['user', 'developer'];

const REFUSAL_REASONS = new Set([
  'budget_hard_cap',
  'budget_spend_not_known_yet',
  'period_budget_exceeded',
  'run_stopped',
  'model_governance_denied',
  'compliance_denied',
  'customer_limit_reached',
  'margin_floor_reached',
]);
const CUSTOMER_REASONS = new Set(['customer_limit_reached', 'margin_floor_reached']);

/** The mock's one price, in cents per 1,000 tokens, for every model. */
const RATE = { input: 0.3, output: 1.5 };
/** The output allowance a reservation uses when the call sends no usable max_tokens. */
const MODEL_MAX_OUTPUT = 8192;
const HOLD_SECONDS = 300;
const DEFAULT_SLOW_MS = 1500;

const BUDGET = {
  id: '2f5c8e1a-6b4d-4a9e-b3f7-0c1d2e3f4a5b',
  name: 'Search team',
  period: 'month',
  cap_cents: 2000000,
  spent_cents: 2000412,
};

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Which behaviour the callers ask for: the first caller id, in order, that starts with a known prefix. */
export function behaviourFor(callers) {
  const prefixes = ['refuse-', 'reroute-', 'slow-', 'error-', 'degraded-', 'unavailable-', 'throttled-', 'cache-', 'unknown-mode-'];
  for (const c of callers) {
    if (typeof c.id !== 'string') continue;
    for (const p of prefixes) {
      if (c.id.startsWith(p)) return { kind: p.slice(0, -1), arg: c.id.slice(p.length) };
    }
  }
  return { kind: 'allow', arg: '' };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function reservationFor(body) {
  const maxOk = Number.isInteger(body.max_tokens) && body.max_tokens >= 0 && body.max_tokens <= MODEL_MAX_OUTPUT;
  const output = maxOk ? body.max_tokens : MODEL_MAX_OUTPUT;
  const input = Number.isInteger(body.input_tokens) && body.input_tokens > 0 ? body.input_tokens : 0;
  return {
    reservation_cents: round3((input * RATE.input + output * RATE.output) / 1000),
    reservation_basis: maxOk ? 'max_tokens' : 'model_default',
    reservation_kind: maxOk && input > 0 ? 'worst_case' : 'estimated',
  };
}

function attributionFor(kind, instance, callers) {
  let developer = null;
  let team = null;
  const unmapped = [];
  for (const c of callers) {
    const id = c.id.trim();
    if (!id) continue;
    const person = PERSON_KINDS.includes(c.kind) && EMAIL.test(id);
    if (person && developer === null) developer = id.toLowerCase();
    if (c.kind === 'tag') {
      const m = /^team=(.+)$/i.exec(id);
      if (m) {
        team ??= m[1].trim().toLowerCase();
        continue;
      }
    }
    const aliasKind = c.kind === 'tag' ? 'gateway_tag' : CALLER_KINDS[kind]?.[c.kind];
    if (!aliasKind || person) continue;
    // The mock has no aliases, so every caller id that could have one is unmapped.
    const entry = `${aliasKind}:${instance ? `${instance}/${id}` : id}`;
    if (!unmapped.includes(entry)) unmapped.push(entry);
  }
  return { team, developer, unmapped };
}

function decisionHeader(answer) {
  if (answer.decision === 'reroute') return 'layer=route; action=route; reason=routed';
  const why = answer.reason ?? (answer.degraded ? 'admit_unavailable' : null);
  return `layer=govern; action=${answer.decision}${why ? `; reason=${why}` : ''}`;
}

function secondsToNextMinute(now) {
  return 60 - Math.floor((now / 1000) % 60);
}

/**
 * Builds the mock. Options:
 *   failMode    the workspace's fail mode the answers carry: open (default) or closed.
 *   gatewayKind the connection's gateway kind. Unset, it is the request's gateway.kind
 *               when that is a known kind, else generic.
 *   key         the gateway key to accept. Unset, any bearer token is accepted.
 *   slowMs      how long a slow-* caller waits when its id names no time (1,500 ms).
 *   spec        a path to the admit OpenAPI file, or false for none. Unset, it is
 *               looked up next to this package. With a spec, every request and
 *               answer is checked against it and the problems are in the log.
 */
/**
 * The routes the mock serves, by the OpenAPI file's operationId. Each is
 * also served under /api/inference-proxy. The tests check that every
 * operation's server URL plus path lands on its own route here.
 */
export const ROUTES = [
  { method: 'POST', pattern: /^\/v1\/gateway\/admit$/, operationId: 'gatewayAdmit' },
  { method: 'POST', pattern: /^\/v1\/gateway\/admit\/([^/]+)\/cancel$/, operationId: 'gatewayAdmitCancel' },
  { method: 'POST', pattern: /^\/v1\/gateway\/headroom$/, operationId: 'gatewayHeadroom' },
  { method: 'POST', pattern: /^\/v1\/gateway\/subscriptions$/, operationId: 'gatewaySubscribe' },
  { method: 'DELETE', pattern: /^\/v1\/gateway\/subscriptions\/([^/]+)$/, operationId: 'gatewayUnsubscribe' },
];

/** The one budget the mock's headroom answers about: "Search team", $97.00 of a $100.00 hard cap. */
export const HEADROOM_BUDGET = { id: '7f1c2d3e-0000-4000-8000-00000000b001', name: 'Search team', period: 'month', mode: 'hard_cap', cap_cents: 10000, spent_cents: 9700 };

/** The event types a subscription may name. */
export const SUBSCRIPTION_EVENT_TYPES = ['budget.threshold_crossed'];

/** A path parameter, decoded; one that isn't valid percent-encoding is kept as sent. */
function decodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The route a request's method and path land on, with its decoded path parameters, or null. */
export function route(method, pathname) {
  const p = pathname.replace(/^\/api\/inference-proxy(?=\/v1\/)/, '');
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(p);
    if (m) return { operationId: r.operationId, params: m.slice(1).map(decodeParam) };
  }
  return null;
}

export function createMock(options = {}) {
  const checkMode = (m) => {
    if (m !== 'open' && m !== 'closed') throw new Error('fail mode must be open or closed');
    return m;
  };
  let failMode = checkMode(options.failMode ?? 'open');
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  const specPath = options.spec === false ? null : (options.spec ?? findSpec());
  const spec = specPath ? loadSpec(specPath) : null;
  const admitOp = spec ? operationSchemas(spec, 'gatewayAdmit') : null;
  const cancelOp = spec ? operationSchemas(spec, 'gatewayAdmitCancel') : null;
  const headroomOp = spec ? operationSchemas(spec, 'gatewayHeadroom') : null;
  const subscribeOp = spec ? operationSchemas(spec, 'gatewaySubscribe') : null;
  const now = options.now ?? (() => Date.now());

  const holds = new Map();
  const subscriptions = new Map();
  let log = { admits: [], cancels: [], headrooms: [], subscriptions: [] };
  const timers = new Set();

  function gatewayOf(body) {
    if (options.gatewayKind) return options.gatewayKind;
    const k = body?.gateway?.kind;
    return typeof k === 'string' && Object.hasOwn(CALLER_KINDS, k) ? k : 'generic';
  }

  function base(decisionId, extra = {}) {
    return { decision_id: decisionId, fail_mode: failMode, ...extra };
  }

  // The callers TensorCost would keep: a caller kind the gateway doesn't send is dropped and named.
  function keptCallers(body) {
    const kind = gatewayOf(body);
    const ignored = [];
    const callers = [];
    (Array.isArray(body.callers) ? body.callers : []).forEach((c, i) => {
      if (!c || typeof c.kind !== 'string' || typeof c.id !== 'string' || !c.id.trim()) {
        ignored.push(`callers[${i}] (no usable kind or id)`);
      } else if (c.kind === 'tag' || PERSON_KINDS.includes(c.kind) || CALLER_KINDS[kind]?.[c.kind]) {
        callers.push(c);
      } else {
        ignored.push(`callers[${i}] (kind "${c.kind}" isn't one ${kind} sends)`);
      }
    });
    return { kind, callers, ignored };
  }

  // The answer TensorCost's admit route would give, for a body that is a JSON object.
  function answer(body, token) {
    const decisionId = randomUUID();
    const { kind, callers, ignored } = keptCallers(body);
    const instance = typeof body.gateway?.instance === 'string' ? body.gateway.instance : null;
    const attribution = attributionFor(kind, instance, callers);
    const headers = { 'x-tc-fail-mode': failMode };
    const hold = (cents) => {
      if (cents > 0) holds.set(decisionId, { token, cancelled: false, until: now() + HOLD_SECONDS * 1000 });
    };

    if (typeof body.model !== 'string' || !body.model.trim()) {
      const what = `model ${body.model === undefined ? 'is missing' : 'is not a model name'}`;
      const b = base(decisionId, { reservation_cents: 0, attribution: { team: null, developer: null, unmapped: [] } });
      const a = failMode === 'open'
        ? { decision: 'allow', ...b, reason: null, detail: `invalid_request: ${what}`, message: null, degraded: true, cache_ttl_seconds: 0 }
        : {
            decision: 'refuse',
            ...b,
            reason: 'invalid_request',
            detail: what,
            message: `TensorCost: this gateway's request couldn't be read (${what}), and this workspace refuses calls it can't check. Fix the gateway's TensorCost policy.`,
            cache_ttl_seconds: 0,
          };
      return { answer: a, headers, behaviour: 'invalid', ignored };
    }

    const behaviour = behaviourFor(callers);
    const r = reservationFor(body);
    const allow = (extra = {}) => ({ decision: 'allow', ...base(decisionId), reason: null, message: null, ...r, attribution, cache_ttl_seconds: 0, ...extra });
    let a;
    switch (behaviour.kind) {
      case 'refuse': {
        const reason = REFUSAL_REASONS.has(behaviour.arg) ? behaviour.arg : 'budget_hard_cap';
        a = {
          decision: 'refuse',
          ...base(decisionId),
          reason,
          message: reason === 'model_governance_denied' || reason === 'compliance_denied'
            ? `TensorCost: ${body.model} isn't allowed for this team. Ask a TensorCost admin to allow it.`
            : CUSTOMER_REASONS.has(reason)
              ? `TensorCost: Customer "${typeof body.customer === 'string' && body.customer ? body.customer : 'acme'}" has reached its $500 monthly limit: its AI spend this month is $500. Ask a TensorCost admin to raise it.`
              : 'TensorCost: Search team has reached its monthly AI budget ($20,000). Ask ana@acme.com to raise it.',
          ...(reason === 'model_governance_denied' || reason === 'compliance_denied' || CUSTOMER_REASONS.has(reason) ? {} : { budget: BUDGET, retry_after_seconds: 3600 }),
          reservation_cents: r.reservation_cents,
          reservation_basis: r.reservation_basis,
          attribution,
          cache_ttl_seconds: 0,
        };
        break;
      }
      case 'reroute': {
        // A bare name is its own model; an object is answered by its name and judged by its model.
        const accepts = (Array.isArray(body.accepts_models) ? body.accepts_models : [])
          .map((m) => (typeof m === 'string' ? { name: m, model: m }
            : m && typeof m === 'object' && typeof m.name === 'string' ? { name: m.name, model: typeof m.model === 'string' ? m.model : m.name } : null))
          .filter((m) => m !== null);
        const pick = accepts.find((m) => (m.name === behaviour.arg || m.model === behaviour.arg) && m.model !== body.model)
          ?? accepts.find((m) => m.model !== body.model);
        if (pick && body.can_reroute !== false && REROUTE_KINDS.has(kind)) {
          a = {
            ...allow(),
            decision: 'reroute',
            model: pick.name,
            route: { policy_id: '9e7c5a3b-1d2f-4a6e-8b0c-2d4f6a8c0e1b', from_model: body.model, to_model: pick.model },
          };
        } else {
          // The policy would cover the call, but this call can't follow it:
          // allowed as asked, and never cacheable, since the next call might.
          a = allow();
        }
        hold(a.reservation_cents);
        break;
      }
      case 'degraded':
        a = allow({ degraded: true, detail: 'check_timeout', fail_mode: 'open' });
        headers['x-tc-fail-mode'] = 'open';
        break;
      case 'unavailable':
        a = {
          decision: 'refuse',
          ...base(decisionId, { fail_mode: 'closed' }),
          reason: 'check_unavailable',
          detail: 'check_timeout',
          message: "TensorCost couldn't check this call's budget in time, and this workspace refuses calls it can't check. Try again shortly.",
          reservation_cents: r.reservation_cents,
          reservation_basis: r.reservation_basis,
          attribution,
          cache_ttl_seconds: 0,
        };
        headers['x-tc-fail-mode'] = 'closed';
        break;
      case 'throttled': {
        const b = base(decisionId, { reservation_cents: 0, attribution: { team: null, developer: null, unmapped: [] } });
        a = failMode === 'open'
          ? { decision: 'allow', ...b, reason: null, detail: 'throttled', message: null, degraded: true, cache_ttl_seconds: 0 }
          : {
              decision: 'refuse',
              ...b,
              reason: 'check_unavailable',
              detail: 'throttled',
              message: "TensorCost: this gateway is past its 60,000 budget checks a minute, and this workspace refuses calls it can't check. A TensorCost admin can raise the gateway's rate.",
              retry_after_seconds: secondsToNextMinute(now()),
              cache_ttl_seconds: 0,
            };
        break;
      }
      case 'cache': {
        const ttl = /^\d+$/.test(behaviour.arg) ? Math.min(Number(behaviour.arg), 5) : 5;
        // No hard cap matched, so nothing is reserved or held: the only kind of allow that may be reused.
        a = allow({ reservation_cents: 0, cache_ttl_seconds: ttl });
        break;
      }
      case 'unknown-mode':
        // The workspace's fail mode couldn't be read: the default (open) decided.
        a = allow({ fail_mode: 'open', fail_mode_known: false, degraded: true, detail: 'fail_mode_unknown' });
        delete headers['x-tc-fail-mode'];
        hold(a.reservation_cents);
        break;
      default: // allow, and slow-* once it has waited
        a = allow();
        hold(a.reservation_cents);
    }
    if (ignored.length) a.detail = a.detail ? `${a.detail}; ignored: ${ignored.join(', ')}` : `ignored: ${ignored.join(', ')}`;
    return { answer: a, headers, behaviour: behaviour.kind, arg: behaviour.arg };
  }

  function send(res, status, payload, headers = {}) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const type = typeof payload === 'string' ? 'text/plain' : 'application/json';
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  function tokenOf(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return null;
    if (options.key && m[1] !== options.key) return null;
    return m[1];
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
  }

  function wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });
  }

  async function onAdmit(req, res) {
    const raw = await readBody(req);
    const entry = { at: new Date(now()).toISOString(), body: null, status: 0, answer: null, request_errors: [], response_errors: [] };
    log.admits.push(entry);
    const token = tokenOf(req);
    if (!token) {
      entry.status = 401;
      return send(res, 401, { message: 'Not a live gateway connection key.' });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    entry.body = body ?? raw;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      entry.status = 400;
      return send(res, 400, { message: 'The body must be a JSON object.' });
    }
    if (admitOp) entry.request_errors = validate(spec, admitOp.request, body, { at: 'request' });

    const asked = behaviourFor(keptCallers(body).callers);
    if (asked.kind === 'error') {
      const status = /^\d{3}$/.test(asked.arg) && Number(asked.arg) >= 400 && Number(asked.arg) <= 599 ? Number(asked.arg) : null;
      if (asked.arg === 'not-json') {
        entry.status = 200;
        return send(res, 200, '<html>upstream hiccup</html>', { 'content-type': 'text/html' });
      }
      entry.status = status ?? 503;
      return send(res, entry.status, { message: `admit-mock: error-${asked.arg} asked for a ${entry.status}` });
    }
    if (asked.kind === 'slow') {
      await wait(/^\d+$/.test(asked.arg) ? Number(asked.arg) : slowMs);
    }
    const out = answer(body, token);
    entry.status = 200;
    entry.answer = out.answer;
    entry.behaviour = out.behaviour;
    if (admitOp) entry.response_errors = validate(spec, admitOp.responses['200'], out.answer, { at: 'answer', strict: true });
    send(res, 200, out.answer, { ...out.headers, 'x-tc-decision': decisionHeader(out.answer) });
  }

  async function onCancel(req, res, decisionId) {
    await readBody(req);
    const entry = { at: new Date(now()).toISOString(), decision_id: decisionId, status: 0, cancelled: null, response_errors: [] };
    log.cancels.push(entry);
    const token = tokenOf(req);
    if (!token) {
      entry.status = 401;
      return send(res, 401, { message: 'Not a live gateway connection key.' });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decisionId)) {
      entry.status = 400;
      return send(res, 400, { message: 'decision_id must be a uuid.' });
    }
    const h = holds.get(decisionId);
    // Only the key that was answered can cancel, once, while the hold lasts.
    const cancelled = Boolean(h && h.token === token && !h.cancelled && h.until > now());
    if (cancelled) h.cancelled = true;
    const payload = { decision_id: decisionId, cancelled };
    entry.status = 200;
    entry.cancelled = cancelled;
    if (cancelOp) entry.response_errors = validate(spec, cancelOp.responses['200'], payload, { at: 'cancel', strict: true });
    send(res, 200, payload);
  }

  // Headroom: the mock's one budget, judged as the admit check would with
  // estimate_cents as the worst case. An error-* caller asks for that status.
  async function onHeadroom(req, res) {
    const raw = await readBody(req);
    const entry = { at: new Date(now()).toISOString(), body: null, status: 0, answer: null, request_errors: [], response_errors: [] };
    log.headrooms.push(entry);
    const token = tokenOf(req);
    if (!token) {
      entry.status = 401;
      return send(res, 401, { message: 'Not a live gateway connection key.' });
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = undefined;
    }
    entry.body = body ?? raw;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      entry.status = 400;
      return send(res, 400, { message: 'Send a JSON object' });
    }
    if (headroomOp) entry.request_errors = validate(spec, headroomOp.request, body, { at: 'request' });
    const estimate = body.estimate_cents ?? 0;
    if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0) {
      entry.status = 400;
      return send(res, 400, { message: 'estimate_cents must be a number from 0 to 1000000000' });
    }
    const { kind, callers, ignored } = keptCallers(body);
    const asked = behaviourFor(callers);
    if (asked.kind === 'error') {
      entry.status = /^\d{3}$/.test(asked.arg) ? Number(asked.arg) : 503;
      return send(res, entry.status, { message: `admit-mock: error-${asked.arg} asked for a ${entry.status}` });
    }
    const person = typeof body.developer === 'string' && body.developer.trim() ? [{ kind: 'user', id: body.developer }] : [];
    const attribution = attributionFor(kind, null, [...person, ...callers]);
    const team = typeof body.team === 'string' && body.team.trim() ? body.team.trim() : attribution.team;
    const b = HEADROOM_BUDGET;
    const budget = {
      ...b,
      held_cents: 0,
      remaining_cents: b.cap_cents - b.spent_cents,
      burn_pct: Math.round((b.spent_cents / b.cap_cents) * 1000) / 10,
    };
    const answer = {
      allowed: b.spent_cents + estimate <= b.cap_cents,
      binding: budget,
      budgets: [budget],
      counted_spend_mtd_cents: b.spent_cents,
      counted_spend_scope: team ? 'team' : 'workspace',
      estimate_cents: estimate,
      attribution: { ...attribution, team: team ?? null },
      ...(ignored.length > 0 ? { ignored } : {}),
    };
    entry.status = 200;
    entry.answer = answer;
    if (headroomOp) entry.response_errors = validate(spec, headroomOp.responses['200'], answer, { at: 'answer', strict: true });
    send(res, 200, answer);
  }

  // Subscriptions: kept per key, so only the key that subscribed can delete.
  async function onSubscribe(req, res, prefix) {
    const raw = await readBody(req);
    const entry = { at: new Date(now()).toISOString(), op: 'subscribe', status: 0, id: null, request_errors: [], response_errors: [] };
    log.subscriptions.push(entry);
    const token = tokenOf(req);
    if (!token) {
      entry.status = 401;
      return send(res, 401, { message: 'Not a live gateway connection key.' });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    if (subscribeOp && body && typeof body === 'object') entry.request_errors = validate(spec, subscribeOp.request, body, { at: 'request' });
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    const types = body?.event_types;
    if (!/^https:\/\//.test(url)) {
      entry.status = 400;
      return send(res, 400, { message: 'url must be the https address to send events to' });
    }
    if (!Array.isArray(types) || types.length === 0 || !types.every((t) => SUBSCRIPTION_EVENT_TYPES.includes(t))) {
      entry.status = 400;
      return send(res, 400, { message: `event_types may name only ${SUBSCRIPTION_EVENT_TYPES.join(', ')}` });
    }
    const id = randomUUID();
    const answer = { id, url, event_types: [...new Set(types)], signing_secret: randomUUID().replace(/-/g, '') };
    subscriptions.set(id, { token, url, event_types: answer.event_types });
    entry.status = 201;
    entry.id = id;
    if (subscribeOp) entry.response_errors = validate(spec, subscribeOp.responses['201'], answer, { at: 'answer', strict: true });
    send(res, 201, answer, { location: `${prefix}/v1/gateway/subscriptions/${id}` });
  }

  async function onUnsubscribe(req, res, id) {
    await readBody(req);
    const entry = { at: new Date(now()).toISOString(), op: 'unsubscribe', status: 0, id };
    log.subscriptions.push(entry);
    const token = tokenOf(req);
    if (!token) {
      entry.status = 401;
      return send(res, 401, { message: 'Not a live gateway connection key.' });
    }
    const sub = subscriptions.get(id);
    if (!sub || sub.token !== token) {
      entry.status = 404;
      return send(res, 404, { message: 'No subscription with this id for this gateway connection' });
    }
    subscriptions.delete(id);
    entry.status = 204;
    res.writeHead(204);
    res.end();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    const fail = (err) => send(res, 500, { message: `admit-mock: ${err.message}` });
    const hit = route(req.method, p);
    if (hit?.operationId === 'gatewayAdmit') return void onAdmit(req, res).catch(fail);
    if (hit?.operationId === 'gatewayAdmitCancel') return void onCancel(req, res, hit.params[0]).catch(fail);
    if (hit?.operationId === 'gatewayHeadroom') return void onHeadroom(req, res).catch(fail);
    if (hit?.operationId === 'gatewaySubscribe') return void onSubscribe(req, res, p.startsWith('/api/inference-proxy/') ? '/api/inference-proxy' : '').catch(fail);
    if (hit?.operationId === 'gatewayUnsubscribe') return void onUnsubscribe(req, res, hit.params[0]).catch(fail);
    if (req.method === 'GET' && p === '/_mock/log') return send(res, 200, { spec: specPath, ...log });
    if (req.method === 'POST' && p === '/_mock/reset') {
      // Clears the log and the holds; {"fail_mode": "closed"} also switches the workspace's fail mode.
      return void readBody(req).then((raw) => {
        let want;
        try {
          want = raw ? JSON.parse(raw)?.fail_mode : undefined;
        } catch {
          return send(res, 400, { message: 'reset takes an empty body or {"fail_mode": "open"|"closed"}' });
        }
        if (want !== undefined && want !== 'open' && want !== 'closed') return send(res, 400, { message: 'fail_mode must be open or closed' });
        api.reset(want);
        send(res, 200, { reset: true, fail_mode: failMode });
      });
    }
    send(res, 404, { message: 'admit-mock serves POST /v1/gateway/admit, POST /v1/gateway/admit/{decision_id}/cancel, POST /v1/gateway/headroom, POST /v1/gateway/subscriptions and DELETE /v1/gateway/subscriptions/{id}' });
  });

  const api = {
    server,
    spec: specPath,
    get log() {
      return log;
    },
    get failMode() {
      return failMode;
    },
    reset(mode) {
      if (mode !== undefined) failMode = checkMode(mode);
      log = { admits: [], cancels: [], headrooms: [], subscriptions: [] };
      subscriptions.clear();
      holds.clear();
    },
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const { port: p } = server.address();
          resolve(`http://${host.includes(':') ? `[${host}]` : host}:${p}`);
        });
      });
    },
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}
