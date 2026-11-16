import { describe, expect, it } from "vitest";
import { normalizeProviderName } from "../provider-name.js";

describe("normalizeProviderName", () => {
  it.each([
    ["anthropic", "anthropic"],
    ["openai", "openai"],
    ["aws.bedrock", "bedrock"],
    ["bedrock", "bedrock"],
    ["amazon_bedrock", "bedrock"],
    ["azure.ai.openai", "azure_openai"],
    ["azure.ai.inference", "azure_openai"],
    ["azure", "azure_openai"],
    ["azure_openai", "azure_openai"],
    ["gcp.vertex_ai", "vertex"],
    ["gcp.gemini", "vertex"],
    ["gcp.gen_ai", "vertex"],
    ["vertex_ai", "vertex"],
    ["vertex", "vertex"],
  ])("maps %s to %s", (raw, id) => {
    expect(normalizeProviderName(raw)).toBe(id);
  });

  it("ignores case and surrounding space", () => {
    expect(normalizeProviderName("  AWS.Bedrock ")).toBe("bedrock");
  });

  it.each(["mistral", "", undefined, null])("gives null for %s", (raw) => {
    expect(normalizeProviderName(raw)).toBeNull();
  });
});
