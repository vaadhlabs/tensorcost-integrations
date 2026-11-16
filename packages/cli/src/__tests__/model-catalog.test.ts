import { beforeEach, describe, expect, it } from "vitest";
import {
  dedupeRegionalBedrock,
  dedupeVersionedVariants,
  isLatestTierModelId,
  isLegacyModelId,
  matchesProviderScope,
  modelsForProvider,
} from "../model-catalog.js";
import { __resetModelCatalogForTests, getAllModels } from "../pricing.js";

beforeEach(() => {
  __resetModelCatalogForTests();
});

describe("dedupeVersionedVariants", () => {
  it("drops dated ids when a friendly alias is present", () => {
    const sample = [
      {
        id: "anthropic/claude-3-haiku",
        display_name: "Haiku",
        provider: "anthropic",
        input_per_million_usd: 0.25,
        output_per_million_usd: 1.25,
        last_updated: "2026-08-14",
      },
      {
        id: "anthropic/claude-3-haiku-20240307",
        display_name: "Haiku dated",
        provider: "anthropic",
        input_per_million_usd: 0.25,
        output_per_million_usd: 1.25,
        last_updated: "2026-08-14",
      },
    ];

    const deduped = dedupeVersionedVariants(sample);
    expect(deduped.map((m) => m.id)).toEqual(["anthropic/claude-3-haiku"]);
  });
});

describe("dedupeRegionalBedrock", () => {
  it("drops us/eu prefixed rows when the global bedrock id exists", () => {
    const sample = [
      {
        id: "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
        display_name: "Haiku",
        provider: "bedrock",
        input_per_million_usd: 0.25,
        output_per_million_usd: 1.25,
        last_updated: "2026-08-14",
      },
      {
        id: "bedrock/us.anthropic.claude-3-haiku-20240307-v1:0",
        display_name: "Haiku US",
        provider: "bedrock",
        input_per_million_usd: 0.25,
        output_per_million_usd: 1.25,
        last_updated: "2026-08-14",
      },
    ];
    expect(dedupeRegionalBedrock(sample).map((m) => m.id)).toEqual([
      "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
    ]);
  });
});

describe("isLegacyModelId", () => {
  it("flags claude-2 and claude-instant", () => {
    expect(isLegacyModelId("anthropic/claude-2")).toBe(true);
    expect(isLegacyModelId("anthropic/claude-instant-1.2")).toBe(true);
    expect(isLegacyModelId("anthropic/claude-3-haiku")).toBe(false);
  });
});

describe("matchesProviderScope", () => {
  const bedrockClaude = {
    id: "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0",
    display_name: "Sonnet",
    provider: "bedrock",
    input_per_million_usd: 3,
    output_per_million_usd: 15,
    last_updated: "2026-08-14",
  };

  it("includes bedrock-hosted Claude under anthropic scope", () => {
    expect(matchesProviderScope(bedrockClaude, "anthropic")).toBe(true);
    expect(matchesProviderScope(bedrockClaude, "bedrock")).toBe(true);
  });
});

describe("isLatestTierModelId", () => {
  it("includes Claude 4.x and excludes claude-3-opus", () => {
    expect(isLatestTierModelId("anthropic/claude-opus-4-6")).toBe(true);
    expect(isLatestTierModelId("bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(
      true,
    );
    expect(isLatestTierModelId("anthropic/claude-3-opus")).toBe(false);
    expect(isLatestTierModelId("anthropic/claude-2")).toBe(false);
  });
});

describe("modelsForProvider", () => {
  it("returns bundled anthropic models without legacy rows by default", () => {
    const models = modelsForProvider("anthropic");
    expect(models.some((m) => m.id === "anthropic/claude-3-haiku")).toBe(true);
    expect(models.some((m) => m.id === "anthropic/claude-3-opus")).toBe(true);
    expect(models.every((m) => !isLegacyModelId(m.id))).toBe(true);
  });

  it("can restrict to latest tier", () => {
    const latest = modelsForProvider("anthropic", { tier: "latest" });
    expect(latest.every((m) => isLatestTierModelId(m.id))).toBe(true);
    expect(latest.some((m) => m.id.includes("claude-3-5"))).toBe(true);
    expect(latest.some((m) => m.id === "anthropic/claude-3-opus")).toBe(false);
  });
});
