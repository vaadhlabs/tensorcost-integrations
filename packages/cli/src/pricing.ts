import { createRequire } from "module";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// JSON import via createRequire — keeps NodeNext module resolution happy without
// needing "assert { type: 'json' }" which isn't universally supported in older
// bundler configs. resolveJsonModule in tsconfig handles the .json type inference.
const require = createRequire(import.meta.url);

interface ModelEntry {
  display_name: string;
  provider: string;
  input_per_million_usd: number;
  output_per_million_usd: number;
  last_updated: string;
  price_unverified?: boolean;
}

interface PricingFile {
  _note: string;
  _schema_version?: number;
  _sources: Record<string, string>;
  models: Record<string, ModelEntry>;
}

const pricingData: PricingFile = require("./pricing/models.json") as PricingFile;

// In-process map — starts from the bundled JSON, then loadModelRates() merges
// live/cached rates on top. Mutations are local to this process.
const modelMap: Map<string, ModelEntry> = new Map(
  Object.entries(pricingData.models),
);

export type ModelId = string;

export interface ModelPricing {
  id: ModelId;
  display_name: string;
  provider: string;
  input_per_million_usd: number;
  output_per_million_usd: number;
  last_updated: string;
  price_unverified?: boolean;
}

export function getAllModels(): ModelPricing[] {
  return Array.from(modelMap.entries()).map(([id, entry]) => ({
    id,
    ...entry,
  }));
}

/**
 * Resolve a model id.
 *
 * 1. Exact match (`openai/gpt-4o`)
 * 2. Bare slug unique match (`gpt-4o` → the single provider-prefixed id)
 *
 * Returns null when unknown. When a bare slug matches multiple providers,
 * returns `{ ambiguous: true, candidates }` so the caller can print them.
 */
export type GetModelResult =
  | { kind: "found"; model: ModelPricing }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: string[] };

export function resolveModel(id: string): GetModelResult {
  const exact = modelMap.get(id);
  if (exact) {
    return { kind: "found", model: { id, ...exact } };
  }

  if (!id.includes("/")) {
    const matches: string[] = [];
    for (const key of modelMap.keys()) {
      const slash = key.lastIndexOf("/");
      const slug = slash >= 0 ? key.slice(slash + 1) : key;
      if (slug === id) matches.push(key);
    }
    if (matches.length === 1) {
      const fullId = matches[0]!;
      const entry = modelMap.get(fullId)!;
      return { kind: "found", model: { id: fullId, ...entry } };
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", candidates: matches.sort() };
    }
  }

  return { kind: "not_found" };
}

/** Convenience wrapper — exact or unique bare-slug match; null otherwise. */
export function getModel(id: string): ModelPricing | null {
  const result = resolveModel(id);
  return result.kind === "found" ? result.model : null;
}

export interface CostEstimate {
  model: ModelPricing;
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

export function estimateCost(
  model: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const inputCostUsd = (inputTokens / 1_000_000) * model.input_per_million_usd;
  const outputCostUsd =
    (outputTokens / 1_000_000) * model.output_per_million_usd;
  return {
    model,
    inputTokens,
    outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}

// ---------------------------------------------------------------------------
// Live-rates loader — the published rate catalogue
// ---------------------------------------------------------------------------
// Fetches TensorCost's daily-published rate catalogue and merges it into the
// in-process map. Uses a 1-hour on-disk cache at ~/.tensorcost/rates-cache.json.
//
// No API key required — the catalogue is public list pricing. Every failure
// path (offline flag, network error, an HTML page instead of JSON, FS
// permission) falls back silently to the bundled table.

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_CATALOG_URL = "https://console.tensorcost.com/cli/model-rates.json";
const FETCH_TIMEOUT_MS = 3_000;

function ratesCachePath(): string {
  return join(homedir(), ".tensorcost", "rates-cache.json");
}

function defaultCatalogUrl(): string {
  return process.env["TENSORCOST_CATALOG_URL"]?.trim() || DEFAULT_CATALOG_URL;
}

function isValidUsdPerMillion(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n < 1_000_000;
}

interface RemoteModelEntry {
  display_name: string;
  provider: string;
  input_per_million_usd: number;
  output_per_million_usd: number;
  last_updated: string;
}

interface RemoteRatesResponse {
  schema_version: number;
  generated_at: string;
  models: Record<string, RemoteModelEntry>;
}

interface RatesCache {
  fetched_at: number; // unix ms
  /** Must match the active catalogue URL or the entry is ignored. */
  catalog_url: string;
  data: RemoteRatesResponse;
}

function isRemoteRatesResponse(x: unknown): x is RemoteRatesResponse {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  if (obj["schema_version"] !== 2) return false;
  if (typeof obj["generated_at"] !== "string") return false;
  if (typeof obj["models"] !== "object" || obj["models"] === null) return false;
  return true;
}

function isRatesCache(x: unknown): x is RatesCache {
  if (typeof x !== "object" || x === null) return false;
  const obj = x as Record<string, unknown>;
  if (typeof obj["fetched_at"] !== "number") return false;
  if (typeof obj["catalog_url"] !== "string" || obj["catalog_url"].length === 0) {
    return false;
  }
  return isRemoteRatesResponse(obj["data"]);
}

/** Match LiteLLM versioned ids (e.g. …/claude-3-haiku-20240307), not variant slugs (…/gpt-4o-mini). */
function isVersionedModelSuffix(aliasId: string, candidateId: string): boolean {
  if (!candidateId.startsWith(`${aliasId}-`)) return false;
  const suffix = candidateId.slice(aliasId.length + 1);
  return /^\d{8}($|@|-)/.test(suffix);
}

/** Re-expose bundled friendly ids using live rates from the newest matching versioned row. */
function restoreBundledAliases(): void {
  const liveIds = [...modelMap.keys()];
  for (const [aliasId, bundledEntry] of Object.entries(pricingData.models)) {
    if (modelMap.has(aliasId)) continue;

    const matches = liveIds.filter((id) => isVersionedModelSuffix(aliasId, id));
    if (matches.length === 0) continue;

    matches.sort((a, b) => b.localeCompare(a));
    const live = modelMap.get(matches[0]!);
    if (!live) continue;

    modelMap.set(aliasId, {
      ...live,
      display_name: bundledEntry.display_name,
    });
  }
}

function applyRemoteCatalog(remote: RemoteRatesResponse): void {
  const next = new Map<string, ModelEntry>();
  for (const [id, entry] of Object.entries(remote.models)) {
    if (
      typeof entry.display_name === "string" &&
      typeof entry.provider === "string" &&
      typeof entry.input_per_million_usd === "number" &&
      typeof entry.output_per_million_usd === "number" &&
      isValidUsdPerMillion(entry.input_per_million_usd) &&
      isValidUsdPerMillion(entry.output_per_million_usd)
    ) {
      next.set(id, {
        display_name: entry.display_name,
        provider: entry.provider,
        input_per_million_usd: entry.input_per_million_usd,
        output_per_million_usd: entry.output_per_million_usd,
        last_updated: entry.last_updated ?? new Date().toISOString().slice(0, 10),
      });
    }
  }
  // Successful live catalogue replaces bundled seed — avoids stale alias rows.
  if (next.size > 0) {
    modelMap.clear();
    for (const [id, entry] of next) {
      modelMap.set(id, entry);
    }
    restoreBundledAliases();
  }
}

function tryReadCache(catalogUrl: string): RatesCache | null {
  try {
    const raw = readFileSync(ratesCachePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRatesCache(parsed) && parsed.catalog_url === catalogUrl) return parsed;
  } catch {
    // ENOENT, EPERM, or JSON parse failure — all silently ignored
  }
  return null;
}

function tryWriteCache(catalogUrl: string, data: RemoteRatesResponse): void {
  try {
    mkdirSync(join(homedir(), ".tensorcost"), { recursive: true });
    const entry: RatesCache = {
      fetched_at: Date.now(),
      catalog_url: catalogUrl,
      data,
    };
    writeFileSync(ratesCachePath(), JSON.stringify(entry, null, 2), "utf8");
  } catch {
    // EPERM or disk full — ignore; the in-process state is already merged
  }
}

export interface LoadModelRatesOptions {
  catalogUrl?: string;
  offline?: boolean;
  /** Skip the 1h disk cache and always attempt a network fetch (tests). */
  forceRefresh?: boolean;
  /** Ignore ~/.tensorcost/rates-cache.json (tests). */
  ignoreDiskCache?: boolean;
}

/** @internal Restore bundled seed — for unit tests only. */
export function __resetModelCatalogForTests(): void {
  modelMap.clear();
  for (const [id, entry] of Object.entries(pricingData.models)) {
    modelMap.set(id, entry);
  }
}

export async function loadModelRates(opts?: LoadModelRatesOptions): Promise<void> {
  const offline =
    opts?.offline === true ||
    process.env["TENSORCOST_OFFLINE"] === "1" ||
    process.env["TENSORCOST_OFFLINE"] === "true";

  const catalogUrl = opts?.catalogUrl ?? defaultCatalogUrl();
  const ignoreDiskCache = opts?.ignoreDiskCache === true;

  // Check cache first — valid regardless of offline mode / network.
  const cached =
    opts?.forceRefresh || ignoreDiskCache ? null : tryReadCache(catalogUrl);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    applyRemoteCatalog(cached.data);
    return;
  }

  if (offline) {
    // Prefer a stale cache over bundled-only when offline.
    const stale = ignoreDiskCache ? null : tryReadCache(catalogUrl);
    if (stale) applyRemoteCatalog(stale.data);
    return;
  }

  try {
    const res = await fetch(catalogUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      if (cached) applyRemoteCatalog(cached.data);
      else {
        const stale = ignoreDiskCache ? null : tryReadCache(catalogUrl);
        if (stale) applyRemoteCatalog(stale.data);
      }
      return;
    }

    // A static host may answer a missing object with an HTML page and a 200.
    // Reject anything that isn't schema_version-2 JSON.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      if (cached) applyRemoteCatalog(cached.data);
      else {
        const stale = ignoreDiskCache ? null : tryReadCache(catalogUrl);
        if (stale) applyRemoteCatalog(stale.data);
      }
      return;
    }

    const body: unknown = await res.json();
    if (!isRemoteRatesResponse(body)) {
      if (cached) applyRemoteCatalog(cached.data);
      else {
        const stale = ignoreDiskCache ? null : tryReadCache(catalogUrl);
        if (stale) applyRemoteCatalog(stale.data);
      }
      return;
    }

    applyRemoteCatalog(body);
    if (!ignoreDiskCache) tryWriteCache(catalogUrl, body);
  } catch {
    // Network error, DNS failure, timeout, JSON parse — silently ignore.
    if (cached) {
      applyRemoteCatalog(cached.data);
    } else {
      const stale = ignoreDiskCache ? null : tryReadCache(catalogUrl);
      if (stale) applyRemoteCatalog(stale.data);
    }
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
// Heuristic: ceil(char_count / 4) is accurate to within ~10% for typical
// English prose. BPE tokenizers average ~4 chars/token for English; code and
// non-Latin scripts skew lower (more tokens per char), so this is a slight
// undercount for mixed content — acceptable for cost estimation purposes.
//
// When @anthropic-ai/tokenizer or tiktoken is installed we prefer the real
// tokenizer, but we do NOT hard-depend on either. A failed dynamic import
// just falls back to the heuristic.

export function heuristicTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

let _tiktoken: ((text: string) => number) | null | undefined = undefined; // undefined = not yet tried

// We use `new Function` to hide the dynamic import string from tsc so it doesn't
// try to resolve specifiers that aren't installed as hard dependencies. At runtime
// the import either succeeds (real tokenizer used) or throws (fall back to heuristic).
const dynamicImport: (specifier: string) => Promise<unknown> = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<unknown>;

async function tryLoadTiktoken(): Promise<((text: string) => number) | null> {
  if (_tiktoken !== undefined) return _tiktoken;
  try {
    // tiktoken is the most widely installed; try it first.
    type AnyFn = (...a: unknown[]) => unknown;
    const mod = await dynamicImport("tiktoken") as { encoding_for_model: AnyFn };
    const enc = mod.encoding_for_model("gpt-3.5-turbo") as { encode: AnyFn };
    _tiktoken = (text: string): number =>
      (enc.encode(text) as ArrayLike<number>).length;
    return _tiktoken;
  } catch {
    // not installed
  }

  try {
    // @anthropic-ai/tokenizer is the other common option
    type CountFn = { countTokens: (text: string) => number };
    const mod = await dynamicImport("@anthropic-ai/tokenizer") as CountFn;
    _tiktoken = (text: string): number => mod.countTokens(text);
    return _tiktoken;
  } catch {
    // not installed
  }

  _tiktoken = null;
  return null;
}

export async function countTokens(text: string): Promise<number> {
  const realTokenizer = await tryLoadTiktoken();
  if (realTokenizer) {
    return realTokenizer(text);
  }
  return heuristicTokenCount(text);
}

export function defaultOutputTokens(inputTokens: number): number {
  // Chat assistants typically generate ~1/5 of the input length.
  // Floor at 64 so very short prompts still get a meaningful projection.
  return Math.max(64, Math.ceil(inputTokens / 5));
}
