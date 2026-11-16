import { getAllModels, type ModelPricing } from "./pricing.js";

export interface ModelCatalogOptions {
  /** Include deprecated rows (claude-2, claude-instant, …). Default false. */
  includeLegacy?: boolean;
  /** When `"latest"`, keep only current-generation model families. */
  tier?: "latest";
}

/** Current-generation models (Claude 3.5+, 4.x, GPT-4o+, Nova, Gemini 2.x, …). */
export function isLatestTierModelId(id: string): boolean {
  if (isLegacyModelId(id)) return false;
  const lc = id.toLowerCase();

  if (/claude-(opus-4|sonnet-4|haiku-4|3-7|3-5)/.test(lc)) return true;
  if (/anthropic\.claude-(opus-4|sonnet-4|haiku-4|3-7|3-5)/.test(lc)) return true;

  if (/gpt-4o|gpt-4\.1|chatgpt-4o/.test(lc)) return true;
  if (/(^|[/.])o[134](-|$|@|\/)/.test(lc)) return true;

  if (/amazon\.nova-/.test(lc)) return true;
  if (/gemini-2[\.\-]/.test(lc)) return true;
  if (/meta\.llama[34]|llama-3\.3|llama3-3|llama4/.test(lc)) return true;
  if (/deepseek-(r1|v3)/.test(lc)) return true;

  return false;
}

export function filterCatalogModels(
  models: ModelPricing[],
  opts?: ModelCatalogOptions,
): ModelPricing[] {
  let out = models;
  if (!opts?.includeLegacy) {
    out = out.filter((m) => !isLegacyModelId(m.id));
  }
  if (opts?.tier === "latest") {
    out = out.filter((m) => isLatestTierModelId(m.id));
  }
  return dedupeVersionedVariants(
    dedupeRegionalBedrock([...out].sort((a, b) => a.id.localeCompare(b.id))),
  );
}

/** True when candidateId is a dated LiteLLM variant of aliasId (not a slug variant like gpt-4o-mini). */
function isVersionedVariantOf(aliasId: string, candidateId: string): boolean {
  if (!candidateId.startsWith(`${aliasId}-`)) return false;
  const suffix = candidateId.slice(aliasId.length + 1);
  return /^\d{8}($|@|-)/.test(suffix);
}

/** Drop dated ids when a friendly alias for the same model is already in the list. */
export function dedupeVersionedVariants(models: ModelPricing[]): ModelPricing[] {
  const ids = new Set(models.map((m) => m.id));
  return models.filter((m) => {
    for (const aliasId of ids) {
      if (aliasId !== m.id && isVersionedVariantOf(aliasId, m.id)) {
        return false;
      }
    }
    return true;
  });
}

/** Drop regional Bedrock duplicates when the global model id is present. */
export function dedupeRegionalBedrock(models: ModelPricing[]): ModelPricing[] {
  const ids = new Set(models.map((m) => m.id));
  return models.filter((m) => {
    if (!m.id.startsWith("bedrock/")) return true;
    const slug = m.id.slice("bedrock/".length);
    const regional = /^(us|eu|au|global)\./.exec(slug);
    if (!regional) return true;
    const globalId = `bedrock/${slug.slice(regional[0].length)}`;
    return !ids.has(globalId);
  });
}

export function isLegacyModelId(id: string): boolean {
  const lc = id.toLowerCase();
  if (/claude-2(\.|$|-)/.test(lc)) return true;
  if (/claude-instant/.test(lc)) return true;
  return false;
}

/**
 * Match a provider scope — includes hosted variants (Bedrock, Vertex, OpenRouter).
 * `anthropic` → direct API + Bedrock/Vertex/OpenRouter Claude rows.
 * `bedrock`   → all Bedrock-hosted models.
 */
export function matchesProviderScope(model: ModelPricing, scope: string): boolean {
  const want = scope.toLowerCase();
  const id = model.id.toLowerCase();
  const provider = model.provider.toLowerCase();

  if (provider === want || id.startsWith(`${want}/`)) return true;

  switch (want) {
    case "anthropic":
      return (
        (id.startsWith("bedrock/") && id.includes("anthropic.")) ||
        id.startsWith("vertex_ai_anthropic_models/") ||
        id.startsWith("openrouter/anthropic/")
      );
    case "openai":
      return (
        (id.startsWith("azure/") && /\/(gpt-|o[0-9]|chatgpt-)/.test(id)) ||
        id.startsWith("openrouter/openai/")
      );
    case "gemini":
    case "google":
      return (
        provider === "vertex" ||
        id.startsWith("vertex/") ||
        id.includes("gemini")
      );
    default:
      return false;
  }
}

export function modelsForProvider(
  provider: string,
  opts?: ModelCatalogOptions,
): ModelPricing[] {
  const filtered = getAllModels().filter((m) => matchesProviderScope(m, provider));
  return filterCatalogModels(filtered, opts);
}
