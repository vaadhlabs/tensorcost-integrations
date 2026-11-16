export type GenAiProviderId = "anthropic" | "openai" | "bedrock" | "azure_openai" | "vertex";

const PROVIDER_NAMES: Readonly<Record<string, GenAiProviderId>> = {
  anthropic: "anthropic",
  openai: "openai",
  "aws.bedrock": "bedrock",
  bedrock: "bedrock",
  amazon_bedrock: "bedrock",
  "azure.ai.openai": "azure_openai",
  "azure.ai.inference": "azure_openai",
  azure: "azure_openai",
  azure_openai: "azure_openai",
  "gcp.vertex_ai": "vertex",
  "gcp.gemini": "vertex",
  "gcp.gen_ai": "vertex",
  vertex_ai: "vertex",
  vertex: "vertex",
};

/**
 * Maps the provider name a gateway puts on a span (the OTel GenAI names plus
 * the spellings Kong and LiteLLM use) to the id TensorCost stores. Anything
 * else is null: guessing a provider writes spend under the wrong price list.
 */
export function normalizeProviderName(raw: string | null | undefined): GenAiProviderId | null {
  if (!raw) return null;
  return PROVIDER_NAMES[raw.trim().toLowerCase()] ?? null;
}
