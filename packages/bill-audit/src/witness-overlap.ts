/**
 * Reads the inputs that can each hold the same AI call and shows the dollars
 * that would be counted twice if you added them up.
 *
 * Inputs:
 *   litellm              a LiteLLM spend-log CSV. A gateway row, priced by LiteLLM.
 *   bedrock-invocations  Bedrock's model invocation log (JSON lines, as it lands
 *                        in S3 or CloudWatch). Tokens only, so the caller prices
 *                        it. A reported row.
 *   bedrock-cur          an AWS FOCUS-format cost export (CSV). A bill: dollars
 *                        with no call in them.
 *
 * The same-call rule is the one the product counts with (same-call.ts, the
 * only part of the contracts package this one pulls in, by relative path, so
 * the compiled package carries its own copy and imports no other package). Calls collapse on a
 * shared provider response id. The fingerprint arm needs two metering
 * sources, and an invocation log is a reported row, so a gateway row and an
 * invocation-log row for one call collapse only when both carry the id. A
 * bill carries no call, so it is listed beside the calls and not netted.
 */

import {
  sameCallSurvivors,
  type SameCallRow,
} from "../../contracts/src/same-call.js";
import { firstPartyProviderOfHost, hostnameOf } from "../../contracts/src/upstream-billing.js";
import {
  parseUsd,
  ProspectCsvParseError,
  splitCsvLine,
  stripBom,
} from "./prospect-csv.js";

export type WitnessSource = "litellm" | "bedrock-invocations" | "bedrock-cur";

export interface WitnessCall extends SameCallRow {
  source: WitnessSource;
  cost_cents: number;
}

export interface WitnessBill {
  source: WitnessSource;
  total_cents: number;
}

export interface WitnessPair {
  sources: [WitnessSource, WitnessSource];
  calls: number;
  cents: number;
}

export interface WitnessOverlap {
  inputs: Array<{ source: WitnessSource; calls: number; cents: number }>;
  /** Every call from every input added up. */
  naive_cents: number;
  /** The same calls with each one counted once. */
  counted_cents: number;
  counted_twice_cents: number;
  by_pair: WitnessPair[];
  /** Bills, listed and not netted against the calls. */
  bills: Array<{ source: WitnessSource; cents: number }>;
  /** Calls in an invocation log whose model had no price, counted as $0. */
  unpriced_calls: number;
}

/** Cents for one call, or null when the model has no price. */
export type PriceCents = (
  modelId: string,
  inputTokens: number,
  outputTokens: number,
) => number | null;

const GATEWAY_RANK = 2;
const REPORTED_RANK = 3;
// Both are raw logs in the product (cost_priority 3). The survivor order
// puts the gateway's row (a pulled gateway log, tier 0) ahead of the
// invocation-log row (a reported row, tier 1) before it looks at priority.
const RAW_LOG_PRIORITY = 3;

function key(header: string): string {
  return header.toLowerCase().replace(/[\s_]+/g, "");
}

function column(headers: string[], ...names: string[]): number {
  for (const name of names) {
    const i = headers.indexOf(key(name));
    if (i >= 0) return i;
  }
  return -1;
}

function csvLines(text: string): string[][] {
  return stripBom(text)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map(splitCsvLine);
}

function toIso(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(withZone.replace(/ (?=[+-]\d{2}:?\d{2}$)/, ""));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function wholeNumber(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The provider as the product names it, from a LiteLLM model and api base. */
function providerOf(model: string, apiBase: string): string {
  const m = model.toLowerCase();
  // The api base is Bedrock only by its exact hostname (bedrock-runtime.<region>.amazonaws.com):
  // a corporate gateway whose name contains "bedrock" may serve anything.
  if (m.startsWith("bedrock/") || firstPartyProviderOfHost(hostnameOf(apiBase) ?? "") === "bedrock") return "bedrock";
  if (/^(?:(?:us|eu|apac|global)\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21)\./.test(m)) {
    return "bedrock";
  }
  const slash = m.indexOf("/");
  if (slash > 0) return m.slice(0, slash);
  if (m.includes("claude")) return "anthropic";
  if (/^(gpt|o\d|chatgpt|text-embedding)/.test(m)) return "openai";
  if (m.includes("gemini")) return "google";
  return "unknown";
}

/**
 * LiteLLM spend logs: `id` is the upstream provider's response id and
 * `request_id` is LiteLLM's own (TensorCost's gateway log parser reads them
 * the same way). A log with only `request_id` falls back to it, since that is
 * all such an export offers.
 */
export function parseLiteLlmSpendLog(csv: string): WitnessCall[] {
  const rows = csvLines(csv);
  const headers = (rows[0] ?? []).map(key);
  const idCol = column(headers, "id");
  const requestCol = column(headers, "request_id");
  const modelCol = column(headers, "model", "model_group");
  const costCol = column(headers, "response_cost", "spend");
  const inCol = column(headers, "prompt_tokens");
  const outCol = column(headers, "completion_tokens");
  const startCol = column(headers, "start_time", "startTime");
  const baseCol = column(headers, "api_base");
  const cacheCol = column(headers, "cached_tokens");

  if (modelCol < 0 || costCol < 0 || startCol < 0 || (idCol < 0 && requestCol < 0)) {
    throw new ProspectCsvParseError(
      "This doesn't look like a LiteLLM spend log. Expected columns request_id (or id), model, spend, prompt_tokens, completion_tokens and startTime.",
    );
  }

  const calls: WitnessCall[] = [];
  rows.slice(1).forEach((cols, i) => {
    const startedAt = toIso(cols[startCol]);
    if (!startedAt) return;
    const model = cols[modelCol]?.trim() ?? "";
    const responseId =
      (idCol >= 0 ? cols[idCol]?.trim() : "") || (requestCol >= 0 ? cols[requestCol]?.trim() : "") || null;
    const usd = parseUsd(cols[costCol] ?? "") ?? 0;
    calls.push({
      id: `litellm:${i}`,
      source: "litellm",
      provider: providerOf(model, baseCol >= 0 ? (cols[baseCol] ?? "") : ""),
      provider_response_id: responseId,
      source_rank: GATEWAY_RANK,
      cost_priority: RAW_LOG_PRIORITY,
      gateway_source: "litellm",
      input_tokens: wholeNumber(cols[inCol]),
      output_tokens: wholeNumber(cols[outCol]),
      cached_input_tokens: cacheCol >= 0 ? wholeNumber(cols[cacheCol]) : 0,
      started_at: startedAt,
      cost_cents: usd * 100,
      // The same-call step ranks a witness with money first (same-call.ts):
      // a LiteLLM line with no spend loses to one that has it.
      total_cost_cents: usd * 100,
    });
  });
  return calls;
}

interface InvocationRecord {
  timestamp?: unknown;
  requestId?: unknown;
  modelId?: unknown;
  input?: { inputTokenCount?: unknown; cacheReadInputTokenCount?: unknown };
  output?: { outputTokenCount?: unknown };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Bedrock's invocation log, one JSON record per line (a file of records
 * saved from S3, or an export of the CloudWatch log group). Lines that aren't
 * invocation records are skipped.
 */
export function parseBedrockInvocationLog(
  text: string,
  priceCents: PriceCents,
): { calls: WitnessCall[]; unpriced: number } {
  const calls: WitnessCall[] = [];
  let unpriced = 0;
  stripBom(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim()) return;
      let rec: InvocationRecord;
      try {
        rec = JSON.parse(line) as InvocationRecord;
      } catch {
        return;
      }
      if (!rec || typeof rec !== "object") return;
      const requestId = typeof rec.requestId === "string" ? rec.requestId.trim() : "";
      const modelId = typeof rec.modelId === "string" ? rec.modelId.trim() : "";
      const startedAt = toIso(typeof rec.timestamp === "string" ? rec.timestamp : undefined);
      if (!requestId || !modelId || !startedAt) return;

      const cacheRead = count(rec.input?.cacheReadInputTokenCount);
      const input = count(rec.input?.inputTokenCount);
      const output = count(rec.output?.outputTokenCount);
      const cents = priceCents(modelId, input, output);
      if (cents === null) unpriced += 1;
      calls.push({
        id: `bedrock-invocations:${i}`,
        source: "bedrock-invocations",
        provider: "bedrock",
        provider_response_id: requestId,
        source_rank: REPORTED_RANK,
        cost_priority: RAW_LOG_PRIORITY,
        gateway_source: null,
        input_tokens: input + cacheRead,
        output_tokens: output,
        cached_input_tokens: cacheRead,
        started_at: startedAt,
        cost_cents: cents ?? 0,
        total_cost_cents: cents ?? 0,
      });
    });
  return { calls, unpriced };
}

/** An AWS FOCUS cost export. Bedrock rows when it has a service column, else every row. */
export function parseFocusBill(csv: string): WitnessBill {
  const rows = csvLines(csv);
  const headers = (rows[0] ?? []).map(key);
  const costCol = column(headers, "BilledCost", "EffectiveCost", "ListCost");
  const serviceCol = column(headers, "ServiceName");
  if (costCol < 0) {
    throw new ProspectCsvParseError(
      "This doesn't look like a FOCUS cost export. Expected a BilledCost column. Export AWS's FOCUS format as CSV.",
    );
  }
  let usd = 0;
  for (const cols of rows.slice(1)) {
    if (serviceCol >= 0 && !/bedrock/i.test(cols[serviceCol] ?? "")) continue;
    usd += parseUsd(cols[costCol] ?? "") ?? 0;
  }
  return { source: "bedrock-cur", total_cents: Math.round(usd * 100) };
}

const SOURCE_ORDER: WitnessSource[] = ["litellm", "bedrock-invocations", "bedrock-cur"];

function pairOf(a: WitnessSource, b: WitnessSource): [WitnessSource, WitnessSource] {
  return SOURCE_ORDER.indexOf(a) <= SOURCE_ORDER.indexOf(b) ? [a, b] : [b, a];
}

function utcDay(iso: string): number {
  return Math.floor(Date.parse(iso) / 86_400_000);
}

/** The survivor that stands for a dropped call: same response id and day, else the same fingerprint. */
function survivorFor(loser: WitnessCall, survivors: WitnessCall[]): WitnessCall | undefined {
  if (loser.provider_response_id !== null) {
    const byId = survivors.find(
      (s) =>
        s.provider === loser.provider &&
        s.provider_response_id === loser.provider_response_id &&
        utcDay(s.started_at) === utcDay(loser.started_at),
    );
    if (byId) return byId;
  }
  const minute = Math.floor(Date.parse(loser.started_at) / 60_000);
  return survivors.find(
    (s) =>
      s.provider === loser.provider &&
      s.input_tokens === loser.input_tokens &&
      s.output_tokens === loser.output_tokens &&
      s.cached_input_tokens === loser.cached_input_tokens &&
      Math.floor(Date.parse(s.started_at) / 60_000) === minute,
  );
}

export function witnessOverlap(
  calls: readonly WitnessCall[],
  bills: readonly WitnessBill[] = [],
  unpricedCalls = 0,
): WitnessOverlap {
  const kept = sameCallSurvivors(calls);
  const keptSet = new Set(kept);
  const sum = (rows: readonly WitnessCall[]) => rows.reduce((t, r) => t + r.cost_cents, 0);

  const pairs = new Map<string, WitnessPair>();
  for (const loser of calls) {
    if (keptSet.has(loser)) continue;
    const winner = survivorFor(loser, kept);
    const sources = pairOf(winner?.source ?? loser.source, loser.source);
    const k = sources.join("+");
    const pair = pairs.get(k) ?? { sources, calls: 0, cents: 0 };
    pair.calls += 1;
    pair.cents += loser.cost_cents;
    pairs.set(k, pair);
  }

  const naive = sum(calls);
  const counted = sum(kept);
  return {
    inputs: SOURCE_ORDER.flatMap((source) => {
      const own = calls.filter((c) => c.source === source);
      return own.length ? [{ source, calls: own.length, cents: Math.round(sum(own)) }] : [];
    }),
    naive_cents: Math.round(naive),
    counted_cents: Math.round(counted),
    counted_twice_cents: Math.round(naive - counted),
    by_pair: [...pairs.values()]
      .map((p) => ({ ...p, cents: Math.round(p.cents) }))
      .sort((a, b) => b.cents - a.cents),
    bills: bills.map((b) => ({ source: b.source, cents: b.total_cents })),
    unpriced_calls: unpricedCalls,
  };
}
