/**
 * The same-call cases, written once. packages/contracts runs them through the
 * TypeScript twin (sameCallSurvivors, same-call.spec.ts); a real-Postgres
 * spec seeds them and runs aiRowSameCallSql over them
 * (spend-same-call.real-pg.spec.ts). Both must leave the survivors listed.
 *
 * A row is written the way it is stored: the `source` column (which sets
 * cost_priority, the ai schema's migration 064) and the metadata keys the rule
 * reads (`source` for the proxy and the SDK, `gateway_source` for a gateway),
 * and total_cost_cents, whose sign is the order's first key. The helpers
 * store a row at 100 cents unless a case says otherwise. `key` names the row
 * inside its case; sameCallCaseId turns its position into the row's uuid,
 * so ties on id break the same way in both runs.
 */

export interface SameCallStoredRow {
  key: string;
  provider: string;
  source: "cur" | "azure_export" | "gcp_export" | "provider_api" | "raw_log" | "metrics_api";
  // unpriced_model and pricing_source are flags writers set on a row stored at
  // 0 for want of a price. The rule doesn't read them; the cases carry them
  // so the rows look as stored.
  metadata: {
    source?: string;
    gateway_source?: string;
    unpriced_model?: boolean;
    pricing_source?: string;
    priced_by?: string;
    /** The proxy's request-side estimate: the order reads it, and ranks the row as one without money. */
    cost_estimated?: string;
    /** The provider may or may not have billed the call (upstream-billing.ts): read like cost_estimated. */
    cost_unknown?: boolean;
    /** What the provider answered; the mapper writes it beside cost_unknown. The rule doesn't read it. */
    upstream_status?: number;
  };
  total_cost_cents: number;
  provider_response_id?: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  /** ISO-8601, UTC. */
  started_at: string;
}

export interface SameCallCase {
  name: string;
  rows: SameCallStoredRow[];
  /** Keys of the rows that survive. */
  survivors: string[];
}

/**
 * The uuid of the nth row (0-based) of case `c`: within a case, ids sort as
 * the rows are listed, and no two cases share one.
 */
export function sameCallCaseId(n: number, c = 0): string {
  return `00000000-0000-4000-8${String(c).padStart(3, "0")}-${String(n + 1).padStart(12, "0")}`;
}

const AT = "2026-11-10T14:03";
const tokens = { input_tokens: 1200, output_tokens: 300, cached_input_tokens: 800 };

const sdk = (key: string, extra: Partial<SameCallStoredRow> = {}): SameCallStoredRow => ({
  key,
  provider: "anthropic",
  source: "provider_api",
  metadata: { source: "tier2-sdk" },
  total_cost_cents: 100,
  ...tokens,
  started_at: `${AT}:10Z`,
  ...extra,
});
const proxy = (key: string, extra: Partial<SameCallStoredRow> = {}): SameCallStoredRow =>
  sdk(key, { metadata: { source: "applied-mode-proxy" }, ...extra });
// A gateway log (LiteLLM, Portkey) as gateway-spend.mapper.ts writes it.
const litellm = (key: string, extra: Partial<SameCallStoredRow> = {}): SameCallStoredRow =>
  sdk(key, { source: "raw_log", metadata: { gateway_source: "litellm" }, ...extra });
// A Portkey log, the other gateway the gateway-spend path pulls.
const portkey = (key: string, extra: Partial<SameCallStoredRow> = {}): SameCallStoredRow =>
  litellm(key, { metadata: { gateway_source: "portkey" }, ...extra });
// A Kong span as it is stored: it comes in over OTLP with an SDK token, so the
// SDK's pipe writes it (provider_api, metadata.source tier2-sdk) and the
// proxy's OTLP receiver adds metadata.gateway_source from the span's kong.*
// attributes. The span body sets that label, so the row is client data: it
// ranks with the SDK rows (tier 1), not with a gateway log we pulled.
const kong = (key: string, extra: Partial<SameCallStoredRow> = {}): SameCallStoredRow =>
  sdk(key, { metadata: { source: "tier2-sdk", gateway_source: "kong" }, ...extra });
// A Kong span sent with the Kong connection's own gateway key, to /v1/traces:
// the proxy forwards it as a log push, so the gateway-spend path writes it
// (raw_log, gateway_source from the connection, no tier2-sdk). It ranks
// with the pushed and pulled gateway rows (tier 0).
const kongKey = (key: string, extra: Partial<SameCallStoredRow> = {}): SameCallStoredRow =>
  litellm(key, { metadata: { gateway_source: "kong" }, ...extra });

// A row that carries no money: what each writer stores when it has no price
// (the proxy and the SDK's pipe flag it unpriced_model; a non-streamed proxy
// row whose estimate failed has no flag at all).
const noMoney = (r: SameCallStoredRow, metadata: Partial<SameCallStoredRow["metadata"]> = {}): SameCallStoredRow => ({
  ...r,
  total_cost_cents: 0,
  metadata: { ...r.metadata, ...metadata },
});

// A proxy row costed at the request-side estimate, as the decision mapper
// stores one: a cent or so, metadata.cost_estimated.
const estimated = (r: SameCallStoredRow, total_cost_cents = 1): SameCallStoredRow => ({
  ...r,
  total_cost_cents,
  metadata: { ...r.metadata, cost_estimated: "request_estimate" },
});

// A proxy row for a call whose billing the proxy couldn't settle (a 500, a
// timeout, a stream that ended without its usage), as the decision mapper
// stores one: the request-side estimate, flagged cost_estimated and
// cost_unknown (applied-mode-spend.mapper.ts billedFigures).
const unknownCost = (r: SameCallStoredRow, total_cost_cents = 1): SameCallStoredRow => ({
  ...r,
  total_cost_cents,
  metadata: { ...r.metadata, cost_estimated: "request_estimate", cost_unknown: true, upstream_status: 500 },
});

export const SAME_CALL_CASES: readonly SameCallCase[] = [
  {
    name: "an SDK row and a LiteLLM row with the same response id leave the LiteLLM row (a gateway row loses only to a proxy row)",
    rows: [litellm("litellm", { provider_response_id: "msg_1" }), sdk("sdk", { provider_response_id: "msg_1" })],
    survivors: ["litellm"],
  },
  {
    name: "the same, the SDK row listed first, so the gateway row has the higher id",
    rows: [sdk("sdk", { provider_response_id: "msg_1" }), litellm("litellm", { provider_response_id: "msg_1" })],
    survivors: ["litellm"],
  },
  {
    // Rows here carry no cost (the stored row doesn't model it); the SDK row
    // stands for a client-supplied $0 and the LiteLLM row for the spend the
    // gateway witnessed. Only the gateway row may count.
    name: "a $0 SDK row carrying a gateway row's response id doesn't displace it: the gateway's money counts",
    rows: [
      sdk("sdk", { provider_response_id: "msg_1" }),
      litellm("litellm", { provider_response_id: "msg_1" }),
    ],
    survivors: ["litellm"],
  },
  {
    // The same attack posted as a Kong span: an SDK token and a kong.*
    // attribute make a Kong row, and it must not displace a pulled gateway
    // row either.
    name: "a Kong span carrying a LiteLLM row's response id doesn't displace it",
    rows: [kong("kong", { provider_response_id: "msg_1" }), litellm("litellm", { provider_response_id: "msg_1" })],
    survivors: ["litellm"],
  },
  {
    name: "a Kong row sent on its gateway key and an SDK row with the same response id leave the Kong row",
    rows: [sdk("sdk", { provider_response_id: "msg_1" }), kongKey("kong", { provider_response_id: "msg_1" })],
    survivors: ["kong"],
  },
  {
    // The same span sent twice, once on the Kong connection's key and once
    // with an SDK token (a second exporter): only the key's row counts.
    name: "a Kong span sent on the gateway key and again with an SDK token leaves the gateway key's row",
    rows: [kong("kong-sdk", { provider_response_id: "msg_1" }), kongKey("kong-key", { provider_response_id: "msg_1" })],
    survivors: ["kong-key"],
  },
  {
    name: "a Kong row sent on its gateway key and a proxy row with the same response id leave the proxy row",
    rows: [kongKey("kong", { provider_response_id: "msg_1" }), proxy("proxy", { provider_response_id: "msg_1" })],
    survivors: ["proxy"],
  },
  {
    name: "fingerprint, no ids: a Kong row sent on its gateway key and an SDK row leave the Kong row",
    rows: [sdk("sdk"), kongKey("kong", { started_at: `${AT}:40Z` })],
    survivors: ["kong"],
  },
  {
    name: "a Kong row and a proxy row with the same response id leave the proxy row",
    rows: [kong("kong", { provider_response_id: "msg_1" }), proxy("proxy", { provider_response_id: "msg_1" })],
    survivors: ["proxy"],
  },
  {
    name: "a proxy row and a gateway row with the same response id leave the proxy row",
    rows: [litellm("litellm", { provider_response_id: "msg_1" }), proxy("proxy", { provider_response_id: "msg_1" })],
    survivors: ["proxy"],
  },
  {
    name: "a bill-line row (cost_priority 1) and a gateway row with the same response id leave the gateway row",
    rows: [
      sdk("cur", { source: "cur", metadata: {}, provider_response_id: "msg_1" }),
      litellm("litellm", { provider_response_id: "msg_1" }),
    ],
    survivors: ["litellm"],
  },
  {
    name: "a bill-line row (cost_priority 1) and a proxy row with the same response id leave the proxy row",
    rows: [
      sdk("cur", { source: "cur", metadata: {}, provider_response_id: "msg_1" }),
      proxy("proxy", { provider_response_id: "msg_1" }),
    ],
    survivors: ["proxy"],
  },
  {
    name: "two SDK rows with the same response id leave the lower id, as before",
    rows: [sdk("sdk1", { provider_response_id: "msg_1" }), sdk("sdk2", { provider_response_id: "msg_1" })],
    survivors: ["sdk1"],
  },
  {
    // cost_priority comes from the source column: azure_export is 1, the
    // SDK's provider_api 2, a gateway log's raw_log 3.
    name: "a reported row with a better cost_priority beats an SDK row but not a gateway row with the same response id",
    rows: [
      sdk("sdk", { provider_response_id: "msg_1" }),
      litellm("litellm", { provider_response_id: "msg_1" }),
      sdk("reported", { source: "azure_export", metadata: {}, provider_response_id: "msg_1" }),
    ],
    survivors: ["litellm"],
  },
  {
    name: "a reported row with the same response id and a worse cost_priority loses to the SDK row",
    rows: [sdk("reported", { source: "raw_log", metadata: {}, provider_response_id: "msg_1" }), sdk("sdk", { provider_response_id: "msg_1" })],
    survivors: ["sdk"],
  },
  {
    name: "the same response id from another provider is another call",
    rows: [sdk("sdk", { provider_response_id: "msg_1" }), litellm("litellm", { provider: "openai", provider_response_id: "msg_1" })],
    survivors: ["sdk", "litellm"],
  },
  {
    name: "the same response id either side of UTC midnight isn't matched (the safe miss that keeps each day its own)",
    rows: [
      sdk("sdk", { provider_response_id: "msg_1", started_at: "2026-11-10T23:59:59.9Z" }),
      litellm("litellm", { provider_response_id: "msg_1", started_at: "2026-11-11T00:00:00.1Z" }),
    ],
    survivors: ["sdk", "litellm"],
  },
  {
    name: "fingerprint, no ids: three SDK rows and two Kong rows leave the three SDK rows (both are client data: the old order)",
    rows: [
      sdk("sdk1", { started_at: `${AT}:01Z` }),
      kong("kong1", { started_at: `${AT}:01.2Z` }),
      sdk("sdk2", { started_at: `${AT}:20Z` }),
      kong("kong2", { started_at: `${AT}:20.3Z` }),
      sdk("sdk3", { started_at: `${AT}:40Z` }),
    ],
    survivors: ["sdk1", "sdk2", "sdk3"],
  },
  {
    name: "two Kong rows with the same fingerprint and no other source leave both: a source never pairs with itself",
    rows: [kong("kong1"), kong("kong2", { started_at: `${AT}:30Z` })],
    survivors: ["kong1", "kong2"],
  },
  {
    name: "an SDK row and a proxy row with the same fingerprint and no gateway row leave both, as before",
    rows: [sdk("sdk"), proxy("proxy")],
    survivors: ["sdk", "proxy"],
  },
  {
    name: "a pair either side of a minute boundary is not matched (the safe miss)",
    rows: [sdk("sdk", { started_at: `${AT}:59.9Z` }), kong("kong", { started_at: "2026-11-10T14:04:00.1Z" })],
    survivors: ["sdk", "kong"],
  },
  {
    name: "an SDK row without an id and a Kong row with one pair on the fingerprint",
    rows: [kong("kong", { provider_response_id: "msg_9" }), sdk("sdk")],
    survivors: ["sdk"],
  },
  {
    name: "an SDK row and a Kong row with different response ids are different calls",
    rows: [sdk("sdk", { provider_response_id: "msg_1" }), kong("kong", { provider_response_id: "msg_2" })],
    survivors: ["sdk", "kong"],
  },
  {
    // The proxy and Kong share id X, so Kong goes to the proxy row on the
    // response id. The SDK row has no id and pairs with Kong on the
    // fingerprint, where the SDK row wins (both tier 1, same priority, the
    // source rank puts the SDK row first). The SDK row and the proxy row never
    // pair with each other (no gateway row between them). Two rows survive:
    // counting the call twice is the safe direction for a cap, and it ends
    // once the SDK sends the response id.
    name: "proxy (id X), Kong (id X) and SDK (no id) for one call leave the proxy row and the SDK row",
    rows: [proxy("proxy", { provider_response_id: "X" }), kong("kong", { provider_response_id: "X" }), sdk("sdk")],
    survivors: ["proxy", "sdk"],
  },
  {
    name: "a pulled gateway and Kong seeing the same call leave the pulled one: Kong's row is client data, whatever its priority",
    rows: [kong("kong", { source: "provider_api" }), litellm("litellm")],
    survivors: ["litellm"],
  },
  {
    name: "the same with the same response id",
    rows: [kong("kong", { provider_response_id: "msg_1" }), litellm("litellm", { provider_response_id: "msg_1" })],
    survivors: ["litellm"],
  },
  {
    name: "two pulled gateways seeing the same call leave the better cost_priority",
    rows: [litellm("litellm"), portkey("portkey", { source: "provider_api" })],
    survivors: ["portkey"],
  },
  {
    name: "two pulled gateways at one cost_priority leave the lower id",
    rows: [portkey("portkey"), litellm("litellm")],
    survivors: ["portkey"],
  },
  {
    // Kong's span carries the SDK pipe's metadata.source; gateway_source
    // must win, or the pair would be two SDK rows and never collapse.
    // A Kong row is still a gateway row for whether the pair applies (the
    // fingerprint arm needs a gateway row), and then the old order holds in
    // tier 1: the SDK row's priority ties Kong's clamped 2 and its source rank
    // is better.
    name: "a Kong span stored through the SDK pipe is a gateway row: Kong and the SDK for one call leave the SDK row",
    rows: [kong("kong"), sdk("sdk")],
    survivors: ["sdk"],
  },
  {
    name: "Kong and the SDK with one response id leave the SDK row (the old order inside tier 1)",
    rows: [kong("kong", { provider_response_id: "msg_1" }), sdk("sdk", { provider_response_id: "msg_1" })],
    survivors: ["sdk"],
  },
  {
    name: "a Kong row with a better cost_priority than the SDK row survives the pair (tier 1, the old order)",
    rows: [sdk("sdk", { source: "raw_log" }), kong("kong")],
    survivors: ["kong"],
  },
  {
    name: "a gateway row stored with a bill's cost_priority still counts as no better than 2: it ties the proxy row's priority and loses to it",
    rows: [kong("kong", { source: "cur" }), proxy("proxy")],
    survivors: ["proxy"],
  },
  {
    name: "reported rows stay out of the fingerprint: a Bedrock invocation-log row and a Kong row are both kept",
    rows: [
      sdk("invocation-log", { provider: "bedrock", source: "raw_log", metadata: {} }),
      kong("kong", { provider: "bedrock" }),
    ],
    survivors: ["invocation-log", "kong"],
  },
  {
    name: "any token count apart breaks the fingerprint",
    rows: [
      sdk("sdk"),
      kong("kong-input", { input_tokens: 1201 }),
      kong("kong-output", { output_tokens: 301 }),
      kong("kong-cached", { cached_input_tokens: 0 }),
      kong("kong-provider", { provider: "openai" }),
    ],
    survivors: ["sdk", "kong-input", "kong-output", "kong-cached", "kong-provider"],
  },
  {
    name: "one to one across three sources: LiteLLM's row takes the first pair, the SDK takes the second, the third SDK row stands",
    rows: [
      sdk("sdk1", { started_at: `${AT}:01Z` }),
      sdk("sdk2", { started_at: `${AT}:02Z` }),
      sdk("sdk3", { started_at: `${AT}:03Z` }),
      kong("kong1", { started_at: `${AT}:01Z` }),
      kong("kong2", { started_at: `${AT}:02Z` }),
      litellm("litellm1", { started_at: `${AT}:01Z` }),
    ],
    survivors: ["litellm1", "sdk2", "sdk3"],
  },
  {
    name: "a gateway call the SDK never saw is kept",
    rows: [sdk("sdk"), kong("kong1"), kong("kong2", { started_at: `${AT}:11Z` })],
    survivors: ["sdk", "kong2"],
  },
  {
    // The SDK's cost, tokens and response id are all client-supplied. A $0
    // SDK row with a gateway call's tokens in its minute and no id pairs with
    // the gateway row; the gateway row, which carries the money, stays.
    name: "a $0 SDK row with a LiteLLM row's fingerprint and no ids doesn't displace it: the gateway row stays",
    rows: [sdk("sdk"), litellm("litellm")],
    survivors: ["litellm"],
  },
  {
    name: "the same with the LiteLLM row listed first, so it has the lower id",
    rows: [litellm("litellm"), sdk("sdk")],
    survivors: ["litellm"],
  },
  {
    name: "a Kong span with a LiteLLM row's fingerprint doesn't displace it either",
    rows: [kong("kong"), litellm("litellm")],
    survivors: ["litellm"],
  },
  {
    name: "a Kong row and a proxy row with the same fingerprint and no ids leave the proxy row",
    rows: [kong("kong"), proxy("proxy")],
    survivors: ["proxy"],
  },
  {
    name: "an SDK row and a gateway row with the same fingerprint and different response ids are two calls: both stay",
    rows: [sdk("sdk", { provider_response_id: "msg_1" }), litellm("litellm", { provider_response_id: "msg_2" })],
    survivors: ["sdk", "litellm"],
  },
  {
    name: "a proxy row and a gateway row with the same fingerprint and no ids leave the proxy row",
    rows: [litellm("litellm"), proxy("proxy")],
    survivors: ["proxy"],
  },
  {
    // The proxy row's priority (metrics_api, 4) is worse than the gateway
    // row's (raw_log, 3, which the clamp leaves at 3), so the gateway row wins
    // the pair: a proxy row is skipped only at cost_priority 2 or better.
    name: "a proxy row stored at a worse cost_priority than the gateway row loses the pair to it",
    rows: [proxy("proxy", { source: "metrics_api" }), litellm("litellm")],
    survivors: ["litellm"],
  },
  // Money first: a row with total_cost_cents > 0 ranks before one without,
  // on both arms, whoever wrote either; inside each group the order above
  // holds. Every row above carries money, so they keep the old order.
  {
    // A non-streamed proxy row with content blocks: the request-side
    // estimate fails, so it stores the tokens at 0 with no flag.
    name: "a non-streamed proxy row with no price and no flag doesn't displace a LiteLLM row with money and the same response id",
    rows: [noMoney(proxy("proxy", { provider_response_id: "msg_1" })), litellm("litellm", { provider_response_id: "msg_1" })],
    survivors: ["litellm"],
  },
  {
    // The proxy row is at cost_priority 2, where the fingerprint arm skips a
    // proxy row with money; one without money has to look.
    name: "the same on the fingerprint: an unpriced proxy row (no ids) loses the pair to a LiteLLM row with money",
    rows: [noMoney(proxy("proxy"), { unpriced_model: true }), litellm("litellm")],
    survivors: ["litellm"],
  },
  {
    name: "an unpriced proxy row loses to a Portkey row with money on the fingerprint, the proxy row listed second",
    rows: [portkey("portkey"), noMoney(proxy("proxy"), { unpriced_model: true })],
    survivors: ["portkey"],
  },
  {
    name: "an unpriced proxy row loses to a Bedrock invocation-log row with money and the same request id",
    rows: [
      noMoney(proxy("proxy", { provider: "bedrock", provider_response_id: "req_1" }), { unpriced_model: true }),
      sdk("invocation-log", { provider: "bedrock", source: "raw_log", metadata: {}, provider_response_id: "req_1" }),
    ],
    survivors: ["invocation-log"],
  },
  {
    // A LiteLLM log with no cost for a model we have no rate for (gateway-
    // spend.mapper.ts keeps the gateway's figure, which is none).
    name: "a LiteLLM row with no cost and no rate loses to a proxy row with money and the same response id",
    rows: [
      noMoney(litellm("litellm", { provider_response_id: "msg_1" }), { priced_by: "gateway", pricing_source: "pricing_miss" }),
      proxy("proxy", { provider_response_id: "msg_1" }),
    ],
    survivors: ["proxy"],
  },
  {
    name: "a LiteLLM row with no cost and no rate loses to a Kong row with money on the fingerprint",
    rows: [noMoney(litellm("litellm"), { priced_by: "gateway", pricing_source: "pricing_miss" }), kong("kong")],
    survivors: ["kong"],
  },
  {
    name: "a Portkey row with no cost loses to an SDK row with money on the fingerprint",
    rows: [noMoney(portkey("portkey")), sdk("sdk")],
    survivors: ["sdk"],
  },
  {
    // No money on either side, so nothing moves up: the tier keeps the
    // server row, and the client's tokens and attribution don't replace it.
    name: "a client's $0 SDK row doesn't displace an unpriced proxy row with the same response id: the proxy row stays by tier",
    rows: [noMoney(proxy("proxy", { provider_response_id: "msg_1" }), { unpriced_model: true }), noMoney(sdk("sdk", { provider_response_id: "msg_1", input_tokens: 1, output_tokens: 1 }))],
    survivors: ["proxy"],
  },
  {
    name: "a client's $0 SDK row still loses to a LiteLLM row with money, by money and by tier",
    rows: [noMoney(sdk("sdk", { provider_response_id: "msg_1" })), litellm("litellm", { provider_response_id: "msg_1" })],
    survivors: ["litellm"],
  },
  {
    name: "a client's $0 SDK row doesn't displace an unpriced LiteLLM row on the fingerprint (tier)",
    rows: [noMoney(sdk("sdk")), noMoney(litellm("litellm"), { priced_by: "gateway" })],
    survivors: ["litellm"],
  },
  {
    // The proxy row counted nothing, so the client row can only raise the
    // count by beating it.
    name: "an SDK row with money displaces an unpriced proxy row with the same response id",
    rows: [noMoney(proxy("proxy", { provider_response_id: "msg_1" }), { unpriced_model: true }), sdk("sdk", { provider_response_id: "msg_1" })],
    survivors: ["sdk"],
  },
  {
    name: "an unpriced SDK row doesn't displace a Kong row with money, by response id or by fingerprint",
    rows: [
      noMoney(sdk("sdk-id", { provider_response_id: "msg_1" }), { unpriced_model: true }),
      kong("kong-id", { provider_response_id: "msg_1" }),
      // Another minute, so the two pairs stay apart.
      noMoney(sdk("sdk-fp", { started_at: "2026-11-10T14:05:30Z" }), { unpriced_model: true }),
      kong("kong-fp", { started_at: "2026-11-10T14:05:30Z" }),
    ],
    survivors: ["kong-id", "kong-fp"],
  },
  {
    name: "an unpriced SDK row doesn't displace a reported row with money and the same response id",
    rows: [noMoney(sdk("sdk", { provider_response_id: "msg_1" }), { unpriced_model: true }), sdk("reported", { source: "raw_log", metadata: {}, provider_response_id: "msg_1" })],
    survivors: ["reported"],
  },
  {
    name: "two rows with money keep the old order: the proxy row beats a LiteLLM row that cost more",
    rows: [litellm("litellm", { provider_response_id: "msg_1", total_cost_cents: 4000 }), proxy("proxy", { provider_response_id: "msg_1", total_cost_cents: 40 })],
    survivors: ["proxy"],
  },
  {
    name: "two rows with money keep the old order on the fingerprint: the SDK row beats a Kong row",
    rows: [kong("kong", { total_cost_cents: 900 }), sdk("sdk", { total_cost_cents: 3 })],
    survivors: ["sdk"],
  },
  {
    // A free model priced at 0 has no money either: the old order, and the
    // call reads $0 whichever row stays.
    name: "a free model's proxy row at 0 and an unpriced LiteLLM row keep the old order: the proxy row stays",
    rows: [noMoney(litellm("litellm", { provider_response_id: "msg_1" }), { priced_by: "gateway", pricing_source: "pricing_miss" }), noMoney(proxy("proxy", { provider_response_id: "msg_1" }))],
    survivors: ["proxy"],
  },
  {
    name: "a free model's SDK row at 0 and an unpriced Kong row keep the old order: the SDK row stays",
    rows: [noMoney(kong("kong"), { unpriced_model: true }), noMoney(sdk("sdk"))],
    survivors: ["sdk"],
  },
  {
    name: "two rows without money keep the old order: an unpriced proxy row beats an unpriced Portkey row on the fingerprint",
    rows: [noMoney(portkey("portkey")), noMoney(proxy("proxy"), { unpriced_model: true })],
    survivors: ["proxy"],
  },
  {
    name: "a pricing-miss Bedrock invocation-log row and an unpriced proxy row with one request id keep the old order",
    rows: [
      noMoney(sdk("invocation-log", { provider: "bedrock", source: "raw_log", metadata: {}, provider_response_id: "req_1" }), { pricing_source: "pricing_miss" }),
      noMoney(proxy("proxy", { provider: "bedrock", provider_response_id: "req_1" }), { unpriced_model: true }),
    ],
    survivors: ["proxy"],
  },
  // An estimate is not money: a row costed at the proxy's request-side
  // estimate ranks with the rows without money, so a witness with the real
  // cost stays.
  {
    // A non-streamed Opus call with string content and no usage the proxy
    // could price: the floor estimate, 1 cent. LiteLLM logged 30.
    name: "an Opus proxy row at the 1-cent request-side estimate doesn't displace LiteLLM's 30 cents for the same response id",
    rows: [
      estimated(proxy("proxy", { provider_response_id: "msg_1", input_tokens: 10000, output_tokens: 2000, cached_input_tokens: 0 })),
      litellm("litellm", { provider_response_id: "msg_1", input_tokens: 10000, output_tokens: 2000, cached_input_tokens: 0, total_cost_cents: 30 }),
    ],
    survivors: ["litellm"],
  },
  {
    // At cost_priority 2, where a proxy row with money skips the lookup; an
    // estimate has to look.
    name: "the same on the fingerprint: an estimated proxy row loses the pair to LiteLLM's real cost",
    rows: [estimated(proxy("proxy")), litellm("litellm", { total_cost_cents: 30 })],
    survivors: ["litellm"],
  },
  {
    // A streamed decision that kept its estimate and took an unpriced SDK
    // row's tokens and id (spend-event-writer.ts): still an estimate.
    name: "a streamed estimate row that took an unpriced SDK row's tokens and id still loses to a Portkey row with money",
    rows: [estimated(proxy("proxy"), 2), portkey("portkey")],
    survivors: ["portkey"],
  },
  {
    name: "an estimated proxy row loses to a Kong row with money on the fingerprint",
    rows: [estimated(proxy("proxy")), kong("kong")],
    survivors: ["kong"],
  },
  {
    name: "an estimated proxy row loses to an SDK row with a real price and the same response id",
    rows: [estimated(proxy("proxy", { provider_response_id: "msg_1" })), sdk("sdk", { provider_response_id: "msg_1" })],
    survivors: ["sdk"],
  },
  {
    // Neither has money, so the tier keeps the server row.
    name: "an estimated proxy row still beats a client's $0 SDK row with the same response id (tier)",
    rows: [noMoney(sdk("sdk", { provider_response_id: "msg_1" })), estimated(proxy("proxy", { provider_response_id: "msg_1" }))],
    survivors: ["proxy"],
  },
  {
    name: "an estimated proxy row and a LiteLLM row with no cost keep the old order: the proxy row stays",
    rows: [noMoney(litellm("litellm", { provider_response_id: "msg_1" }), { priced_by: "gateway", pricing_source: "pricing_miss" }), estimated(proxy("proxy", { provider_response_id: "msg_1" }))],
    survivors: ["proxy"],
  },
  {
    // What the proxy writes once it prices the call from the response's
    // usage: a real cost, no marker, so the old order holds.
    name: "a proxy row priced from the response's usage beats LiteLLM's figure for the same call (the old order)",
    rows: [litellm("litellm", { provider_response_id: "msg_1", total_cost_cents: 30 }), proxy("proxy", { provider_response_id: "msg_1", total_cost_cents: 29.5 })],
    survivors: ["proxy"],
  },
  {
    // A tokenless stream decision taken over by an SDK observation with a
    // price: the spend writer marks the cost the SDK's ('sdk_reported'), so
    // it ranks as no money and the gateway's real cost stays.
    name: "a proxy row carrying an SDK-reported cost from a takeover doesn't displace LiteLLM's real cost for the same response id",
    rows: [
      { ...proxy("proxy", { provider: "openai", provider_response_id: "chatcmpl-1", total_cost_cents: 0.000001 }), metadata: { source: "applied-mode-proxy", cost_estimated: "sdk_reported" } },
      litellm("litellm", { provider: "openai", provider_response_id: "chatcmpl-1", total_cost_cents: 30 }),
    ],
    survivors: ["litellm"],
  },
  {
    name: "with no other witness, the taken-over row still counts its SDK-reported cost",
    rows: [{ ...proxy("proxy", { provider_response_id: "chatcmpl-1" }), metadata: { source: "applied-mode-proxy", cost_estimated: "sdk_reported" } }],
    survivors: ["proxy"],
  },
  {
    name: "a proxy row booked at the estimate for a call of unknown billing loses to LiteLLM's real cost for the same response id",
    rows: [unknownCost(proxy("proxy", { provider_response_id: "msg_1" })), litellm("litellm", { provider_response_id: "msg_1", total_cost_cents: 30 })],
    survivors: ["litellm"],
  },
  {
    // The key reads each marker on its own: a row with cost_unknown and a
    // cost above the gateway's still ranks as one without money.
    name: "cost_unknown alone ranks a proxy row as one without money, whatever its cost",
    rows: [
      { ...proxy("proxy", { provider_response_id: "msg_1", total_cost_cents: 40 }), metadata: { source: "applied-mode-proxy", cost_unknown: true } },
      portkey("portkey", { provider_response_id: "msg_1", total_cost_cents: 30 }),
    ],
    survivors: ["portkey"],
  },
  {
    name: "an unknown-cost proxy row loses to LiteLLM's real cost by the fingerprint too (no response id on either)",
    rows: [unknownCost(proxy("proxy")), litellm("litellm", { total_cost_cents: 30 })],
    survivors: ["litellm"],
  },
  {
    // Neither has money: the tier keeps the server row, which counts its estimate.
    name: "an unknown-cost proxy row still beats a LiteLLM row with no cost for the same response id",
    rows: [noMoney(litellm("litellm", { provider_response_id: "msg_1" }), { priced_by: "gateway", pricing_source: "pricing_miss" }), unknownCost(proxy("proxy", { provider_response_id: "msg_1" }))],
    survivors: ["proxy"],
  },
  {
    name: "with no other witness, an unknown-cost proxy row counts its estimate",
    rows: [unknownCost(proxy("proxy", { provider_response_id: "msg_1" }))],
    survivors: ["proxy"],
  },
];
