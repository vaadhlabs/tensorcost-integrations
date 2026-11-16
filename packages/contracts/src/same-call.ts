/**
 * The same call, counted once across its witnesses.
 *
 * One call can land in ai.ai_spend_events several times: the proxy's row,
 * the SDK's, a customer gateway's (LiteLLM, Kong, Portkey: metadata
 * gateway_source), a provider's report. The bill-overlap rule
 * (ai-bill-overlap.ts unbilledShares) already counts metered calls against
 * reported money once. What it can't see is two metered rows for one call,
 * which it would count twice. This step runs first, at read time: rows that
 * are the same call collapse to one survivor, and the survivor goes through
 * the rule as before. Stored rows are never netted or rewritten.
 *
 * Two rows are the same call when
 *
 * 1. they share tenant, provider and provider_response_id (the provider's
 *    msg_… / chatcmpl-… / resp_… id, or Bedrock's request id) and their
 *    started_at falls on the same UTC day; or
 * 2. they don't both carry a response id (two different ids are two calls)
 *    and they are a fingerprint pair: the same (provider, input_tokens,
 *    output_tokens, cached_input_tokens, UTC minute of started_at), from two
 *    different metering sources, at least one of them a gateway row. Pairing
 *    is one to one: within a fingerprint, the nth row of one source (by
 *    started_at, then id) pairs with the nth row of the other, so N calls
 *    seen by both collapse to N and a call only one source saw is kept.
 *    Metering sources are the proxy, the SDK and each gateway; reported rows
 *    (CUR, exports, usage reports, the Bedrock invocation log) stay out of
 *    the fingerprint, since the bill-overlap rule already weighs them against
 *    the calls. A pair either side of a minute boundary isn't matched and
 *    counts twice, which is the safe direction for a cap.
 *
 * Both arms stay inside one UTC day, so a day's survivors depend only on
 * that day's rows: the daily rollups (ai-spend-days.ts, ai-spend-flow-days.ts)
 * store a day at its version, which moves only when that day's rows change.
 * Two rows with one response id either side of midnight count twice, the
 * same safe miss as the minute boundary.
 *
 * One survivor order serves both arms. Money comes first: a row that
 * carries money ranks before one that doesn't, whoever wrote either. Money
 * is a cost above 0 that isn't an estimate (aiRowCarriesMoneySql). A proxy
 * row for a model with no rate, a gateway log with no cost for a model we
 * have no rate for: each stores its tokens at 0, and if it beat a witness of
 * the same call that carries money, the call would read $0. A proxy row
 * costed at the request-side estimate (a floor of a cent or so) would read
 * the estimate instead of the real cost, the same undercount, and so would
 * an SDK's reported cost taken over onto a proxy row. The key reads the cost
 * column and two markers, metadata.cost_estimated and metadata.cost_unknown,
 * which only server code writes (the proxy's decision mapper and the spend
 * writer's takeover; both are reserved from tags and the SDK's metadata
 * bag), so the order reads nothing a client controls. A row
 * without money gets no boost, so a client's $0 row still ranks behind a
 * server row by the tier; a client row with money can displace only a row
 * that has none, which raises the count (the safe direction) and moves
 * attribution only where the server row had no real price. Inside each of
 * the two groups the order below applies unchanged.
 *
 * The tier comes next. Tier 0 is what
 * the platform or a customer's gateway connection reported: proxy rows, and
 * gateway rows from the gateway-spend path (written server-side: a pull, or
 * a push to /v1/gateway/logs authenticated by the connection's gateway key).
 * A pushed row is the gateway's own report, trusted on the strength of that
 * key, not something the server observed itself; its connection, source and
 * dedupe key are the server's, its figures the gateway's. Tier 1 is everything a client could have
 * posted: SDK rows, reported rows, and gateway rows that came in over the
 * SDK's pipe (Kong's spans posted over OTLP with an SDK token, where the
 * span body says which gateway it is, so such a Kong row is as
 * client-supplied as an SDK row; Kong's spans sent with its connection's
 * gateway key are a push, tier 0). Inside a tier it is the row with the lowest cost_priority, then
 * the proxy row, then the SDK row, then a gateway row, then a reported one,
 * then the lowest id; precisely, no_money * 2000 + tier * 1000 + priority * 4
 * + source rank (meteringSourceRankSql: proxy 0, SDK 1, gateway 2, reported
 * 3), lower wins. So a pulled gateway row with money loses only to a proxy
 * row with money or another pulled gateway's row with money. An SDK row's response id, cost and tokens are all
 * client-supplied: without the tier, whoever holds an SDK token could send a
 * $0 row carrying a gateway row's response id, or its tokens and minute, and
 * zero out spend the gateway witnessed, and the same with a span labelled
 * Kong. No client-supplied row displaces a proxy or pulled gateway row on
 * either arm unless the client row carries money and the server row
 * doesn't. A bill-line row at cost_priority 1 likewise loses the
 * response-id arm to them; the counted-once rule still weighs it against the
 * metered calls afterwards. A gateway row's cost_priority is clamped to no
 * better than provider_api's 2: it is a witness, never a bill, and the proxy
 * rows it sees carry 2. Today's writers store gateway rows as raw_log (3) or
 * provider_api (2), so the clamp changes no outcome; it lets the fingerprint
 * arm skip every proxy row with money at 2 without a lookup.
 *
 * Every gateway row, Kong's included, still counts as a gateway row for
 * whether the fingerprint arm applies (a pair needs one).
 *
 * The loser's attribution (a gateway's caller, the SDK's agent) isn't merged
 * into the survivor.
 *
 * aiRowSameCallSql is the rule in SQL, a predicate every reader of the
 * counted rows puts in its WHERE, with both arms in functions
 * (SAME_CALL_RESPONSE_ID_FN_SQL, SAME_CALL_FINGERPRINT_FN_SQL, deployed to
 * the database as functions);
 * sameCallSurvivors is its TypeScript twin (fixtures, the audit CLI).
 * same-call.cases.ts holds the cases both run.
 */

/** A spend row as the same-call step reads it. */
export interface SameCallRow {
  id: string;
  provider: string;
  provider_response_id: string | null;
  /** 0 proxy, 1 SDK, 2 gateway, 3 reported (meteringSourceRankSql). */
  source_rank: number;
  cost_priority: number;
  gateway_source: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  /** ISO-8601. */
  started_at: string;
  /**
   * True for a row that came in over the SDK's pipe (metadata.source
   * 'tier2-sdk'): a Kong span posted with an SDK token has it, a gateway log
   * we pulled or a gateway pushed on its key (Kong's traces included) doesn't.
   * Absent means false. A gateway row with it is tier 1.
   */
  via_sdk?: boolean;
  /**
   * The stored total_cost_cents. Above 0, and not an estimate, is a row that
   * carries money, which ranks before every row that doesn't. Required: a
   * caller that leaves the column out of its select would rank every row as
   * one without money.
   */
  total_cost_cents: number;
  /** True when the cost is an estimate (metadata.cost_estimated set). Absent means a real cost. */
  cost_estimated?: boolean;
  /**
   * True when the provider may not have billed the call at all
   * (metadata.cost_unknown set, contracts upstream-billing.ts). Absent means
   * the billing is settled.
   */
  cost_unknown?: boolean;
}

/**
 * ai.ai_spend_events.cost_priority by source column (a generated column in
 * the database). Lower is more authoritative.
 */
export const SPEND_SOURCE_COST_PRIORITY: Readonly<Record<string, number>> = {
  cur: 1,
  azure_export: 1,
  gcp_export: 1,
  provider_api: 2,
  raw_log: 3,
  metrics_api: 4,
  backfill: 99,
};

/**
 * SQL for a row's metering source rank (alias `a`): 0 proxy, 1 SDK,
 * 2 gateway, 3 anything else (a reported row). A gateway row is a gateway
 * whatever pipe it came in by: Kong's spans posted with an SDK token arrive
 * through the SDK's observation path and carry its metadata.source.
 */
export function meteringSourceRankSql(a = ""): string {
  return `(CASE WHEN ${a}metadata->>'gateway_source' IS NOT NULL THEN 2
                WHEN ${a}metadata->>'source' = 'applied-mode-proxy' THEN 0
                WHEN ${a}metadata->>'source' = 'tier2-sdk' THEN 1
                ELSE 3 END)`;
}

/** The metering source a metered row came from: the proxy, the SDK, or which gateway. */
function meteringSourceKeySql(a: string): string {
  return `COALESCE('gateway:' || (${a}metadata->>'gateway_source'), ${a}metadata->>'source')`;
}

/**
 * SQL, true for a row that carries money (alias `a`): total_cost_cents > 0
 * and the cost isn't an estimate. A row at 0 or below (an unpriced call, a
 * free model, a credit line) doesn't, nor does one whose cost isn't a
 * server's: metadata.cost_estimated, whatever its value. 'request_estimate'
 * is the proxy's request-side estimate (the applied-mode spend mapper's,
 * from the proxy's costBasis); 'sdk_reported'
 * is an SDK observation's cost that the spend writer took over onto a proxy
 * decision row, client data on a tier-0 row. Such a row still counts when no
 * other witness of the call has money. metadata.cost_unknown is the same:
 * the proxy couldn't tell whether the provider billed the call (a timeout, a
 * 5xx, a stream that ended without its usage; contracts upstream-billing.ts)
 * and booked the estimate. The mapper sets both markers today; the key reads
 * each, so an unknown-cost estimate can never outrank a gateway's real
 * figure for the same call even if a writer sets only the one.
 * Never NULL: the column is NOT NULL and the marker test is IS NULL.
 * sameCallCarriesMoney is the twin.
 */
export function aiRowCarriesMoneySql(a = ""): string {
  return `(${a}total_cost_cents > 0 AND ${a}metadata->>'cost_estimated' IS NULL AND ${a}metadata->>'cost_unknown' IS NULL)`;
}

/** aiRowCarriesMoneySql's twin. */
export function sameCallCarriesMoney(r: Pick<SameCallRow, "total_cost_cents" | "cost_estimated" | "cost_unknown">): boolean {
  return r.total_cost_cents > 0 && r.cost_estimated !== true && r.cost_unknown !== true;
}

/**
 * SQL for a row's place in the survivor order (alias `a`), one integer:
 * no_money * 2000 + tier * 1000 + priority * 4 + meteringSourceRankSql,
 * lower wins, the id breaking ties. no_money is 1 for a row without
 * aiRowCarriesMoneySql. Tier 0 is a proxy row or a gateway row we pulled;
 * tier 1 anything else. The priority is cost_priority, except that a gateway row
 * counts as no better than 2. The part after the tier tops out at
 * 99 * 4 + 3, so the tiers don't overlap, and the part after the money key
 * tops out at 1399, so the two money groups don't either; 1000 and 2000 are
 * multiples of 4, so `% 4` still reads the source rank. An integer rather
 * than a tuple, because every reader carries this predicate and JIT compiles
 * all of it, run or not.
 */
function sameCallOrderSql(a: string): string {
  // Where the tier is decided. metadata.source is written by the server on
  // every path (the SDK mapper's own keys win over the client's bag), and
  // 'tier2-sdk' means the row came in over the SDK's pipe, on an SDK
  // credential. A gateway row that did is client-supplied, whatever its
  // gateway_source says, so it is tier 1, and keeps its old place there
  // (priority, then source rank 2). A gateway row without it came from the
  // gateway-spend path (a pull, or a push on the connection's gateway key):
  // tier 0. That is the key's word for the figures, not the server's own
  // observation.
  // Kong is both. Its spans sent with the Kong connection's own gateway key
  // (POST /v1/traces) are forwarded as a log push, so the gateway-spend path
  // writes them without tier2-sdk: tier 0, like any pushed gateway. The same
  // spans posted with an SDK token come through the SDK's pipe and keep
  // tier2-sdk: tier 1. Never key this on anything the client can set (the
  // span's attributes, the gateway label).
  return `((CASE WHEN ${aiRowCarriesMoneySql(a)} THEN 0 ELSE 2000 END)
          + CASE WHEN ${a}metadata->>'gateway_source' IS NOT NULL THEN
                  (CASE WHEN ${a}metadata->>'source' IS DISTINCT FROM 'tier2-sdk' THEN 0 ELSE 1000 END)
                  + GREATEST(${a}cost_priority, 2) * 4 + 2
                WHEN ${a}metadata->>'source' = 'applied-mode-proxy' THEN ${a}cost_priority * 4
                WHEN ${a}metadata->>'source' = 'tier2-sdk' THEN 1000 + ${a}cost_priority * 4 + 1
                ELSE 1000 + ${a}cost_priority * 4 + 3 END)`;
}

const UTC_DAY_START = `(date_trunc('day', p_started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
const UTC_MINUTE_START = `(date_trunc('minute', p_started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * The index each arm's function looks its rival up on: one on the response
 * id, one on the fingerprint. The migrations that create them skip the build
 * on a large table, where an operator builds them by hand, and without its
 * index an arm's lookup scans every row of the tenant and provider for the
 * day or minute, once per row read: quadratic. So the predicate checks each
 * index once per statement and turns its arm off while the index is
 * missing or invalid. The calls that arm would have collapsed then count
 * twice, the safe direction for a cap, until the index is built; the service
 * that owns the ai schema logs a warning at boot while either is missing (same-call-index-check).
 */
export const SAME_CALL_RESPONSE_ID_INDEX = "ai_spend_events_provider_response_idx";
export const SAME_CALL_FINGERPRINT_INDEX = "ai_spend_events_same_call_fp_idx";

/** SQL: true when the ai-schema index is built and valid. Uncorrelated, so it runs once per statement. */
export function sameCallIndexReadySql(index: string): string {
  return `EXISTS (SELECT 1 FROM pg_catalog.pg_index sc_ix
                  WHERE sc_ix.indexrelid = to_regclass('"ai".${index}')
                    AND sc_ix.indisvalid AND sc_ix.indisready)`;
}

/**
 * SQL for which arms are on right now, as text: 'rid1fp1' with both indexes
 * ready, 'rid0fp1' without the response-id index, and so on. The daily
 * rollups store it with every rolled day (rule_version `<rule>:<arms>`) and their fresh and stale
 * checks compare against its value now, so a day rolled while an arm was off
 * goes stale, and is rolled again, once the index is built. Without this a
 * rolled day would keep its double-counted pairs for good: the build SQL is
 * the same text either way, and no row of the day changes.
 */
export function sameCallArmsSql(): string {
  return `(CASE WHEN ${sameCallIndexReadySql(SAME_CALL_RESPONSE_ID_INDEX)} THEN 'rid1' ELSE 'rid0' END
          || CASE WHEN ${sameCallIndexReadySql(SAME_CALL_FINGERPRINT_INDEX)} THEN 'fp1' ELSE 'fp0' END)`;
}

/** The database functions that hold the two arms. */
export const SAME_CALL_RESPONSE_ID_FN = `"ai".same_call_response_id_loses`;
export const SAME_CALL_FINGERPRINT_FN = `"ai".same_call_fingerprint_loses`;

/**
 * SQL, one row with `ready`: true once both functions and both pairing
 * tables exist. Postgres resolves a function or table name when it parses a
 * statement, so a reader carrying aiRowSameCallSql fails outright, whatever
 * the index checks say, until the database functions exist, and one
 * carrying it with a tenant until the pairing tables do too. A service whose
 * readers carry the predicate reports not-ready until this is true, so a
 * deploy that reaches it before the schema does keeps the old tasks serving.
 */
export const SAME_CALL_FNS_READY_SQL = `SELECT to_regprocedure('${SAME_CALL_RESPONSE_ID_FN}(uuid, text, text, timestamptz, integer, uuid)') IS NOT NULL
   AND to_regprocedure('${SAME_CALL_FINGERPRINT_FN}(uuid, text, timestamptz, integer, integer, integer, uuid)') IS NOT NULL
   AND to_regclass('"ai".same_call_day') IS NOT NULL
   AND to_regclass('"ai".same_call_loser') IS NOT NULL AS ready`;

/**
 * The response-id arm as a function: true when another active row of the
 * tenant and provider has the same response id, on the same UTC day, and
 * comes first in the survivor order (`p_order` is the row's own
 * sameCallOrderSql). The UTC day bound is deliberate: a pair either side of
 * midnight counts twice, the safe direction, and a rolled day's survivors
 * depend only on that day's rows. Inline, this correlated subquery made
 * every read that carried it give up its parallel scan (a two-year Flow
 * read went from 0.7 s to 1.4 s); a PARALLEL SAFE function call doesn't.
 * The SET clause keeps it from being inlined back into the reader.
 * It looks the id up on ai_spend_events_provider_response_idx.
 */
export const SAME_CALL_RESPONSE_ID_FN_SQL = `CREATE OR REPLACE FUNCTION ${SAME_CALL_RESPONSE_ID_FN}(
  p_tenant_id uuid,
  p_provider text,
  p_provider_response_id text,
  p_started_at timestamptz,
  p_order int,
  p_id uuid
) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
COST 10
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM "ai"."ai_spend_events" x
     WHERE x.tenant_id = p_tenant_id
       AND x.provider = p_provider
       AND x.provider_response_id = p_provider_response_id
       AND x.started_at >= ${UTC_DAY_START}
       AND x.started_at < ${UTC_DAY_START} + interval '1 day'
       AND x.superseded_at IS NULL
       AND (${sameCallOrderSql("x.")}, x.id) < (p_order, p_id))
$fn$;`;

/**
 * The fingerprint arm as a function: true when the row with these values
 * loses a fingerprint pair. The migration that deploys the database function
 * holds this exact text, as it does SAME_CALL_RESPONSE_ID_FN_SQL's, and a
 * test checks it does, so a change here fails until a new migration carries
 * it (and the rollup rules are bumped).
 *
 * Why a function and not a subquery in the predicate: the planner can't
 * estimate a minute range on a correlated started_at (it takes the default
 * 0.005), so it costs the windowed subquery at a thousand or more per row
 * even though it is skipped for most proxy rows. Inline, that estimate
 * switched on JIT for one-day rollup inserts (6 ms became 780 ms) and moved
 * the day rollup onto a slower index (4 ms became 80-130 ms with JIT off).
 * A call to a SQL function with a SET clause is never inlined, so the
 * planner costs it as a constant; it is reached for every metered row bar
 * a proxy row with money at cost_priority 2 or better (see aiRowSameCallSql). (A plpgsql version cost two to
 * five times as much per call.)
 *
 * Both functions are SECURITY INVOKER, so RLS applies to the rows they
 * read as it does to the reader's own; STABLE and PARALLEL SAFE (they only
 * read); search_path pinned, every name schema-qualified.
 *
 * COST 10, not the default 100. The planner can't tell how many rows reach a
 * call, so it costs one per row read. A reader that binds one tenant
 * (same-call-paired.ts) carries this predicate for its unpaired days only,
 * yet at 100 a 1M-row budget read planned at ~530k, past the JIT inline and
 * optimize thresholds, and spent 1.1 s of 2.2 s compiling. COST changes no
 * result. It is in this text, not in an ALTER, because CREATE OR REPLACE
 * resets every attribute it doesn't name: the next migration that carries a
 * new body carries the COST with it (a test checks).
 */
export const SAME_CALL_FINGERPRINT_FN_SQL = `CREATE OR REPLACE FUNCTION ${SAME_CALL_FINGERPRINT_FN}(
  p_tenant_id uuid,
  p_provider text,
  p_started_at timestamptz,
  p_input_tokens int,
  p_output_tokens int,
  p_cached_input_tokens int,
  p_id uuid
) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
COST 10
SET search_path = pg_catalog, pg_temp
AS $fn$
  -- The fingerprint's metered rows, numbered per metering source by
  -- (started_at, id): the nth row of one source pairs with the nth of
  -- another. ok is the survivor order (money, tier, priority * 4, source
  -- rank; a gateway row's priority no better than 2); ok % 4 = 2 is a
  -- gateway row, 3 a reported row, which stays out.
  SELECT EXISTS (
    WITH sc_fp AS (
      SELECT q.*, ROW_NUMBER() OVER (PARTITION BY q.s ORDER BY q.started_at, q.id) AS n
        FROM (SELECT x.id, x.started_at, x.provider_response_id AS rid,
                     ${sameCallOrderSql("x.")} AS ok,
                     ${meteringSourceKeySql("x.")} AS s
                FROM "ai"."ai_spend_events" x
               WHERE x.tenant_id = p_tenant_id
                 AND x.provider = p_provider
                 AND x.started_at >= ${UTC_MINUTE_START}
                 AND x.started_at < ${UTC_MINUTE_START} + interval '1 minute'
                 AND x.input_tokens = p_input_tokens
                 AND x.output_tokens = p_output_tokens
                 AND x.cached_input_tokens = p_cached_input_tokens
                 AND x.superseded_at IS NULL) q
       WHERE q.ok % 4 < 3)
    SELECT 1
      FROM sc_fp me
      JOIN sc_fp r ON r.n = me.n AND r.s <> me.s
     WHERE me.id = p_id
       AND (me.ok % 4 = 2 OR r.ok % 4 = 2)
       AND (me.rid IS NULL OR r.rid IS NULL)
       AND (r.ok, r.id) < (me.ok, me.id))
$fn$;`;

/**
 * True when an ai.ai_spend_events row (alias `a`, e.g. "e.") survives the
 * same-call step. With no alias the columns are left unqualified.
 *
 * Cost. The response-id arm calls SAME_CALL_RESPONSE_ID_FN only for a row
 * with an id; it stays inside the row's UTC day (see the function).
 * The fingerprint arm skips reported rows (rank 3 stays out of it), every
 * row while its index is missing (the arm is off), and every proxy row with
 * money (a real cost above 0) at cost_priority <= 2 that isn't a gateway
 * row. Proof for the proxy skip: a pair needs a gateway row on one side and
 * two different sources, so a proxy row can only lose to a gateway row. A
 * pulled gateway row with money (tier 0) has order
 * GREATEST(cost_priority, 2) * 4 + 2 >= 10: the clamp and the source rank
 * put it after the proxy row (a Kong row sent on its gateway key is one).
 * A Kong row posted with an SDK token and with money (tier 1) is at least
 * 1010, and any gateway row without money at least 2010. The proxy row's
 * own order is cost_priority * 4 <= 8 (the priorities are 1, 2, 3, 4 and
 * 99), so it wins every pair. A proxy row without money can't be skipped,
 * and that includes one whose cost is an estimate: its order is
 * 2000 + cost_priority * 4, so any gateway row with money (at most 1399)
 * beats it. An SDK row can't be skipped: a pulled gateway row
 * beats it whatever either one's priority when both carry money (at most
 * 398 against 1000 and up) or when only the gateway row does, and an
 * SDK-token Kong row beats it at cost_priority 3 or worse, or when only the
 * Kong row carries money. Every SDK row, and any other metered row (a proxy row
 * without money or stored above cost_priority 2, a gateway row), calls
 * SAME_CALL_FINGERPRINT_FN. A tenant
 * with no gateway rows pays a CASE per row, the index lookup for rows that
 * carry a response id, and a fingerprint lookup for each SDK row. The
 * only subqueries left inline are the two index checks, which are
 * uncorrelated (run once per statement), so the planner costs the predicate
 * as a few function calls.
 *
 * A reader that binds one tenant uses aiRowSameCallPairedSql
 * (same-call-paired.ts) instead, which reads settled days from the per-day
 * pairs and runs this predicate only for the rest.
 */
export function aiRowSameCallSql(a = ""): string {
  const o = a;
  return `((${o}provider_response_id IS NULL
          OR NOT ${sameCallIndexReadySql(SAME_CALL_RESPONSE_ID_INDEX)}
          OR NOT ${SAME_CALL_RESPONSE_ID_FN}(${o}tenant_id, ${o}provider, ${o}provider_response_id,
                   ${o}started_at, ${sameCallOrderSql(o)}, ${o}id))
       AND CASE
             WHEN ${o}metadata->>'gateway_source' IS NULL AND ${o}metadata->>'source' = 'applied-mode-proxy'
                  AND ${o}cost_priority <= 2 AND ${aiRowCarriesMoneySql(o)} THEN true
             WHEN ${meteringSourceRankSql(o)} = 3 THEN true
             WHEN NOT ${sameCallIndexReadySql(SAME_CALL_FINGERPRINT_INDEX)} THEN true
             ELSE NOT ${SAME_CALL_FINGERPRINT_FN}(${o}tenant_id, ${o}provider, ${o}started_at,
                      ${o}input_tokens, ${o}output_tokens, ${o}cached_input_tokens, ${o}id)
           END)`;
}

/** A stored row (its source column and metadata) as the same-call step reads it. */
export function sameCallRowOf(r: {
  id: string;
  provider: string;
  source: string;
  metadata?: { source?: unknown; gateway_source?: unknown; cost_estimated?: unknown; cost_unknown?: unknown } | null;
  /** numeric comes back from pg as a string; either is read as a number. */
  total_cost_cents: number | string;
  provider_response_id?: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  started_at: string;
}): SameCallRow {
  const gw = r.metadata?.gateway_source;
  const gateway_source = gw === undefined || gw === null ? null : String(gw);
  const via = r.metadata?.source;
  const source_rank = gateway_source !== null ? 2 : via === "applied-mode-proxy" ? 0 : via === "tier2-sdk" ? 1 : 3;
  return {
    id: r.id,
    provider: r.provider,
    provider_response_id: r.provider_response_id ?? null,
    source_rank,
    cost_priority: SPEND_SOURCE_COST_PRIORITY[r.source] ?? Number.POSITIVE_INFINITY,
    gateway_source,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cached_input_tokens: r.cached_input_tokens,
    started_at: r.started_at,
    via_sdk: via === "tier2-sdk",
    total_cost_cents: Number(r.total_cost_cents),
    cost_estimated: r.metadata?.cost_estimated !== undefined && r.metadata?.cost_estimated !== null,
    cost_unknown: r.metadata?.cost_unknown !== undefined && r.metadata?.cost_unknown !== null,
  };
}

/** sameCallOrderSql's priority: a gateway row counts as no better than 2. */
const priority = (r: SameCallRow) => (r.gateway_source !== null ? Math.max(r.cost_priority, 2) : r.cost_priority);

/**
 * sameCallOrderSql's tier-0 test for a gateway row: one we pulled from the
 * gateway (server-authenticated), not one posted over the SDK's pipe
 * (metadata.source 'tier2-sdk'), whatever its gateway_source says. Also the
 * only kind of row that may confirm a gateway's reroute (the gateway
 * advice confirmer).
 */
export function isPulledGatewayRow(r: Pick<SameCallRow, "gateway_source" | "via_sdk">): boolean {
  return r.gateway_source !== null && r.via_sdk !== true;
}

/** sameCallOrderSql's tier: proxy rows and pulled gateway rows 0, every other row 1. */
const tier = (r: SameCallRow) => (isPulledGatewayRow(r) || (r.gateway_source === null && r.source_rank === 0) ? 0 : 1);

/** sameCallOrderSql's first key: 0 for a row that carries money, 1 for one that doesn't. */
const noMoney = (r: SameCallRow) => (sameCallCarriesMoney(r) ? 0 : 1);

/** Negative when `r` wins over `a`: money first, then tier, then lower priority, then source rank, then id. */
function order(r: SameCallRow, a: SameCallRow): number {
  if (noMoney(r) !== noMoney(a)) return noMoney(r) - noMoney(a);
  if (tier(r) !== tier(a)) return tier(r) - tier(a);
  if (priority(r) !== priority(a)) return priority(r) - priority(a);
  if (r.source_rank !== a.source_rank) return r.source_rank - a.source_rank;
  return r.id < a.id ? -1 : r.id > a.id ? 1 : 0;
}

const sourceKey = (r: SameCallRow) => (r.gateway_source !== null ? `gateway:${r.gateway_source}` : `rank:${r.source_rank}`);

/**
 * The rows that survive the same-call step (aiRowSameCallSql's twin), in
 * input order. The rows are one tenant's active rows; none is changed. It
 * models the predicate with both indexes ready (both arms on): with an index
 * missing the SQL turns that arm off, and this twin has no such state.
 */
export function sameCallSurvivors<R extends SameCallRow>(rows: readonly R[]): R[] {
  const dropped = new Set<R>();

  // 1. The same response id on the same UTC day: the best row of each survives.
  const byId = new Map<string, R[]>();
  for (const r of rows) {
    if (r.provider_response_id === null) continue;
    const day = Math.floor(Date.parse(r.started_at) / 86_400_000);
    const k = `${r.provider}\u0000${r.provider_response_id}\u0000${day}`;
    const list = byId.get(k);
    if (list) list.push(r);
    else byId.set(k, [r]);
  }
  for (const list of byId.values()) for (const a of list) if (list.some((r) => order(r, a) < 0)) dropped.add(a);

  // 2. The fingerprint, metered rows only, numbered per source.
  const byFingerprint = new Map<string, R[]>();
  for (const r of rows) {
    if (r.source_rank >= 3) continue;
    const minute = Math.floor(Date.parse(r.started_at) / 60_000);
    const k = [r.provider, r.input_tokens, r.output_tokens, r.cached_input_tokens, minute].join("\u0000");
    const list = byFingerprint.get(k);
    if (list) list.push(r);
    else byFingerprint.set(k, [r]);
  }
  for (const group of byFingerprint.values()) {
    const n = new Map<R, number>();
    const bySource = new Map<string, R[]>();
    for (const r of group) {
      const list = bySource.get(sourceKey(r));
      if (list) list.push(r);
      else bySource.set(sourceKey(r), [r]);
    }
    for (const list of bySource.values()) {
      list.sort((x, y) => Date.parse(x.started_at) - Date.parse(y.started_at) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      list.forEach((r, i) => n.set(r, i + 1));
    }
    for (const a of group) {
      const lost = group.some(
        (r) =>
          n.get(r) === n.get(a) &&
          sourceKey(r) !== sourceKey(a) &&
          (r.gateway_source !== null || a.gateway_source !== null) &&
          (r.provider_response_id === null || a.provider_response_id === null) &&
          order(r, a) < 0,
      );
      if (lost) dropped.add(a);
    }
  }
  return rows.filter((r) => !dropped.has(r));
}
