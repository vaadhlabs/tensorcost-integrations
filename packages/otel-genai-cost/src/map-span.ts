import { createHash } from "node:crypto";
import { normalizeProviderName, type GenAiProviderId } from "./provider-name.js";

export interface OtlpAttributeLike {
  key: string;
  value?: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

export interface OtlpSpanLike {
  traceId?: string;
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttributeLike[];
}

export type GatewayEmitter = "kong" | "litellm" | "otel";

export interface GatewayCaller {
  kind: string;
  id: string;
}

/**
 * One LLM call as a gateway reported it. inputTokens is what the span said;
 * run it through storedInputTokens before storing, because emitters disagree
 * on whether it already contains the cache tokens.
 */
export interface GenAiCall {
  provider: GenAiProviderId | null;
  providerRaw: string | null;
  model: string;
  operation: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  responseId: string | null;
  traceId: string | null;
  spanId: string | null;
  maxTokens: number | null;
  callers: GatewayCaller[];
  startedAt: string;
  endedAt: string | null;
  status: "success" | "error";
  errorType: string | null;
}

const PROVIDER_KEYS = ["gen_ai.provider.name", "gen_ai.system", "llm.provider"];
const MODEL_KEYS = ["gen_ai.request.model", "gen_ai.response.model", "llm.model_name"];
const INPUT_KEYS = ["gen_ai.usage.input_tokens", "llm.token_count.prompt"];
const OUTPUT_KEYS = ["gen_ai.usage.output_tokens", "llm.token_count.completion"];
const CACHE_READ_KEYS = [
  "gen_ai.usage.cache_read.input_tokens",
  "llm.token_count.prompt_details.cache_read",
];
const CACHE_WRITE_KEYS = [
  "gen_ai.usage.cache_creation.input_tokens",
  "llm.token_count.prompt_details.cache_write",
];
const CALLER_KEYS: ReadonlyArray<{ key: string; kind: string }> = [
  { key: "kong.auth.consumer.name", kind: "consumer" },
  { key: "kong.workspace.name", kind: "workspace" },
  { key: "user.email", kind: "user" },
];

function attrString(attrs: OtlpAttributeLike[], keys: string[]): string | undefined {
  for (const key of keys) {
    const v = attrs.find((a) => a.key === key)?.value;
    if (!v) continue;
    if (v.stringValue) return v.stringValue;
    if (v.intValue != null) return String(v.intValue);
    if (v.doubleValue != null) return String(v.doubleValue);
  }
  return undefined;
}

function attrNumber(attrs: OtlpAttributeLike[], keys: string[]): number | undefined {
  const raw = attrString(attrs, keys);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function nanoToIso(nano?: string): string | null {
  if (!nano) return null;
  const ms = Math.floor(Number(nano) / 1_000_000);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Kong's AI plugins stamp kong.* attributes on the span; plain OTel and
 * LiteLLM spans don't. LiteLLM is never detected here (its spans carry no
 * reliable marker), so pass it explicitly.
 */
export function detectEmitter(span: OtlpSpanLike): GatewayEmitter {
  const kong = (span.attributes ?? []).some((a) => a.key.startsWith("kong."));
  return kong ? "kong" : "otel";
}

/**
 * Reads one span. Null means the span is not an LLM call: it has no model, or
 * it has a model but neither usage nor a response id (a wrapper span around
 * the real call, which would double count if it were kept).
 *
 * inputTokens is the stored value: for an emitter whose input excludes the
 * cache (Kong with Anthropic) the cache reads and writes are added back, see
 * storedInputTokens. The emitter is detected from kong.* attributes unless
 * the caller passes it.
 */
export function mapGenAiSpan(span: OtlpSpanLike, emitter?: GatewayEmitter): GenAiCall | null {
  const attrs = span.attributes ?? [];
  const model = attrString(attrs, MODEL_KEYS);
  if (!model) return null;

  const input = attrNumber(attrs, INPUT_KEYS);
  const output = attrNumber(attrs, OUTPUT_KEYS);
  const responseId = attrString(attrs, ["gen_ai.response.id"]) ?? null;
  if (input === undefined && output === undefined && responseId === null) return null;

  let providerRaw: string | null = null;
  let provider: GenAiProviderId | null = null;
  for (const key of PROVIDER_KEYS) {
    const raw = attrString(attrs, [key]);
    if (!raw) continue;
    providerRaw ??= raw;
    provider = normalizeProviderName(raw);
    if (provider) break;
  }

  const callers: GatewayCaller[] = [];
  for (const { key, kind } of CALLER_KEYS) {
    const id = attrString(attrs, [key]);
    if (id) callers.push({ kind, id });
  }

  const cacheRead = attrNumber(attrs, CACHE_READ_KEYS) ?? 0;
  const cacheWrite = attrNumber(attrs, CACHE_WRITE_KEYS) ?? 0;
  const statusRaw = attrString(attrs, ["gen_ai.response.status", "error.type"]);
  const failed = statusRaw !== undefined && statusRaw !== "success";

  return {
    provider,
    providerRaw,
    model,
    operation: span.name ?? attrString(attrs, ["gen_ai.operation.name"]) ?? null,
    inputTokens: storedInputTokens(
      emitter ?? detectEmitter(span),
      provider,
      input ?? 0,
      cacheRead,
      cacheWrite,
    ),
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    responseId,
    traceId: span.traceId ?? null,
    spanId: span.spanId ?? null,
    maxTokens: attrNumber(attrs, ["gen_ai.request.max_tokens"]) ?? null,
    callers,
    startedAt: nanoToIso(span.startTimeUnixNano) ?? new Date().toISOString(),
    endedAt: nanoToIso(span.endTimeUnixNano),
    status: failed ? "error" : "success",
    errorType: failed ? (statusRaw ?? null) : null,
  };
}

/**
 * A UUID-shaped id from the trace id and span id together. The trace id alone
 * is shared by every call in an agent run, so five calls would collapse into
 * one row.
 */
export function spanCorrelationId(traceId: string, spanId: string): string {
  const h = createHash("sha256").update(`${traceId}:${spanId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The input_tokens value to store, where stored input counts everything the
 * model read, cache reads and writes included. Whether the reported number
 * already includes the cache depends on who emitted the span: OTel semconv
 * and LiteLLM include it; Kong follows each provider's own usage block, so an
 * Anthropic span reports the uncached remainder only. The Kong rows are
 * unverified against a live gateway.
 */
export function storedInputTokens(
  emitter: GatewayEmitter,
  provider: GenAiProviderId | null,
  reportedInput: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const excludesCache = emitter === "kong" && provider === "anthropic";
  return excludesCache ? reportedInput + cacheRead + cacheWrite : reportedInput;
}
