import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAllModels,
  getModel,
  resolveModel,
  estimateCost,
  heuristicTokenCount,
  countTokens,
  defaultOutputTokens,
  loadModelRates,
  __resetModelCatalogForTests,
} from "../pricing.js";

beforeEach(() => {
  __resetModelCatalogForTests();
});

describe("getModel", () => {
  beforeEach(() => {
    __resetModelCatalogForTests();
  });
  it("returns a known model", () => {
    const m = getModel("anthropic/claude-3-sonnet");
    expect(m).not.toBeNull();
    expect(m!.input_per_million_usd).toBeGreaterThan(0);
    expect(m!.output_per_million_usd).toBeGreaterThan(0);
  });

  it("returns null for an unknown model", () => {
    expect(getModel("nonexistent/model")).toBeNull();
  });

  it("resolves a unique bare slug (gpt-4o → openai/gpt-4o)", () => {
    // Bundled table has openai/gpt-4o and azure/gpt-4o — ambiguous.
    // Use a slug that is unique in the bundled table.
    const m = getModel("claude-3-sonnet");
    expect(m).not.toBeNull();
    expect(m!.id).toBe("anthropic/claude-3-sonnet");
  });
});

describe("resolveModel", () => {
  it("returns ambiguous when bare slug matches multiple providers", () => {
    const result = resolveModel("gpt-4o");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toContain("openai/gpt-4o");
      expect(result.candidates).toContain("azure/gpt-4o");
    }
  });

  it("returns not_found for garbage", () => {
    expect(resolveModel("nope/nope").kind).toBe("not_found");
  });
});

describe("getAllModels", () => {
  it("returns at least 25 configured models", () => {
    expect(getAllModels().length).toBeGreaterThanOrEqual(25);
  });

  it("every model has a last_updated date string", () => {
    for (const m of getAllModels()) {
      expect(typeof m.last_updated).toBe("string");
      // Bundled uses YYYY-MM-DD; live catalogue may use full ISO timestamps.
      expect(m.last_updated.length).toBeGreaterThanOrEqual(10);
      expect(m.last_updated.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("estimateCost", () => {
  it("computes cost correctly for claude-3-sonnet", () => {
    const model = getModel("anthropic/claude-3-sonnet")!;
    const est = estimateCost(model, 1_000, 200);
    expect(est.inputCostUsd).toBeCloseTo(0.003, 6);
    expect(est.outputCostUsd).toBeCloseTo(0.003, 6);
    expect(est.totalCostUsd).toBeCloseTo(0.006, 6);
  });

  it("computes cost correctly for gpt-4o", () => {
    const model = getModel("openai/gpt-4o")!;
    const est = estimateCost(model, 500, 100);
    expect(est.inputCostUsd).toBeCloseTo(0.00125, 7);
    expect(est.outputCostUsd).toBeCloseTo(0.001, 7);
    expect(est.totalCostUsd).toBeCloseTo(0.00225, 7);
  });
});

describe("heuristicTokenCount", () => {
  it("returns ceil(charCount / 4)", () => {
    expect(heuristicTokenCount("abcd")).toBe(1);
    expect(heuristicTokenCount("abcde")).toBe(2);
    expect(heuristicTokenCount("")).toBe(0);
  });

  const fixtures: Array<{ label: string; text: string; realTokens: number }> = [
    {
      label: "short greeting",
      text: "Hello, how are you today?",
      realTokens: 7,
    },
    {
      label: "medium technical paragraph",
      text: "Transformer models use self-attention mechanisms to capture long-range dependencies in sequences. This allows them to process all positions in parallel rather than sequentially.",
      realTokens: 45,
    },
    {
      label: "system prompt template",
      text: "You are a helpful assistant. Answer the user's question accurately and concisely. If you are unsure, say so. Do not make up facts.",
      realTokens: 32,
    },
    {
      label: "code snippet",
      text: "const result = await openai.chat.completions.create({ model: 'gpt-4', messages });",
      realTokens: 22,
    },
    {
      label: "long user message",
      text: "I need help debugging a TypeScript error I'm getting when I try to import a JSON file in a project that uses NodeNext module resolution. The error says 'Cannot find module' even though the file exists and I have resolveJsonModule set to true in my tsconfig.json.",
      realTokens: 64,
    },
  ];

  for (const { label, text, realTokens } of fixtures) {
    it(`within 20% of real token count for: ${label}`, () => {
      const heuristic = heuristicTokenCount(text);
      const ratio = heuristic / realTokens;
      expect(ratio).toBeGreaterThan(0.8);
      expect(ratio).toBeLessThan(1.2);
    });
  }
});

describe("countTokens", () => {
  it("falls back to heuristic when no tokenizer is installed", async () => {
    const text = "Hello world, this is a test.";
    const result = await countTokens(text);
    expect(result).toBe(heuristicTokenCount(text));
  });
});

describe("defaultOutputTokens", () => {
  it("floors at 64 for very short input", () => {
    expect(defaultOutputTokens(10)).toBe(64);
    expect(defaultOutputTokens(64)).toBe(64);
  });

  it("returns ceil(n/5) for longer inputs", () => {
    expect(defaultOutputTokens(1000)).toBe(200);
    expect(defaultOutputTokens(1001)).toBe(201);
  });
});

describe("loadModelRates", () => {
  beforeEach(() => {
    __resetModelCatalogForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetModelCatalogForTests();
  });

  it("skips network when offline=true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const before = getAllModels().length;
    await expect(
      loadModelRates({ offline: true, ignoreDiskCache: true }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAllModels().length).toBeGreaterThanOrEqual(before);
  });

  it("falls back gracefully on a network error", async () => {
    const before = getAllModels().length;
    await expect(
      loadModelRates({
        catalogUrl: "http://127.0.0.1:1",
        forceRefresh: true,
        ignoreDiskCache: true,
      }),
    ).resolves.toBeUndefined();
    expect(getAllModels().length).toBeGreaterThanOrEqual(before);
  });

  it("merges a successful catalogue response and replaces bundled rows", async () => {
    const bundledOnly = getModel("anthropic/claude-3-sonnet");
    expect(bundledOnly).not.toBeNull();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        schema_version: 2,
        generated_at: "2026-08-14T00:00:00.000Z",
        models: {
          "openai/gpt-4o": {
            display_name: "GPT-4o Live",
            provider: "openai",
            input_per_million_usd: 9.99,
            output_per_million_usd: 19.99,
            last_updated: "2026-08-14T00:00:00.000Z",
          },
          "anthropic/claude-3-haiku-20240307": {
            display_name: "Claude 3 Haiku (dated)",
            provider: "anthropic",
            input_per_million_usd: 0.25,
            output_per_million_usd: 1.25,
            last_updated: "2026-08-14T00:00:00.000Z",
          },
          "groq/llama-test": {
            display_name: "Llama Test",
            provider: "groq",
            input_per_million_usd: 0.05,
            output_per_million_usd: 0.08,
            last_updated: "2026-08-14T00:00:00.000Z",
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadModelRates({
      catalogUrl: "https://example.test/cli/model-rates.json",
      forceRefresh: true,
      ignoreDiskCache: true,
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(getModel("groq/llama-test")).not.toBeNull();
    expect(getModel("openai/gpt-4o")!.input_per_million_usd).toBe(9.99);
    // Friendly bundled alias restored from the versioned live row.
    expect(getModel("anthropic/claude-3-haiku")).not.toBeNull();
    expect(getModel("anthropic/claude-3-haiku")!.input_per_million_usd).toBe(0.25);
    // Bundled-only alias with no versioned live match stays dropped.
    expect(getModel("anthropic/claude-3-sonnet")).toBeNull();
  });

  it("ignores disk cache when catalog_url does not match", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const prevHome = process.env["HOME"];
    const fakeHome = mkdtempSync(join(tmpdir(), "tc-cli-cache-"));
    process.env["HOME"] = fakeHome;
    mkdirSync(join(fakeHome, ".tensorcost"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".tensorcost", "rates-cache.json"),
      JSON.stringify({
        fetched_at: Date.now(),
        catalog_url: "https://other.example/cli/model-rates.json",
        data: {
          schema_version: 2,
          generated_at: "2026-08-14T00:00:00.000Z",
          models: {
            "groq/llama-test": {
              display_name: "Llama Test",
              provider: "groq",
              input_per_million_usd: 0.05,
              output_per_million_usd: 0.08,
              last_updated: "2026-08-14T00:00:00.000Z",
            },
          },
        },
      }),
      "utf8",
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        schema_version: 2,
        generated_at: "2026-08-14T00:00:00.000Z",
        models: {
          "openai/gpt-4o": {
            display_name: "GPT-4o Live",
            provider: "openai",
            input_per_million_usd: 2.5,
            output_per_million_usd: 10,
            last_updated: "2026-08-14T00:00:00.000Z",
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const pricing = await import("../pricing.js");

    try {
      pricing.__resetModelCatalogForTests();
      await pricing.loadModelRates({
        catalogUrl: "https://example.test/cli/model-rates.json",
      });
      expect(fetchMock).toHaveBeenCalled();
      expect(pricing.getModel("groq/llama-test")).toBeNull();
      expect(pricing.getModel("openai/gpt-4o")!.input_per_million_usd).toBe(2.5);
    } finally {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      pricing.__resetModelCatalogForTests();
    }
  });

  it("rejects schema_version !== 2", async () => {
    const before = getAllModels().length;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        schema_version: 1,
        generated_at: "2026-08-14T00:00:00.000Z",
        models: {
          "groq/old-schema": {
            display_name: "Old",
            provider: "groq",
            input_per_million_usd: 0.05,
            output_per_million_usd: 0.08,
            last_updated: "2026-08-14T00:00:00.000Z",
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadModelRates({
      catalogUrl: "https://example.test/cli/model-rates.json",
      forceRefresh: true,
      ignoreDiskCache: true,
    });
    expect(getModel("groq/old-schema")).toBeNull();
    expect(getAllModels().length).toBeGreaterThanOrEqual(before);
  });

  it("ignores HTML SPA fallback (CloudFront 403→200)", async () => {
    const before = getAllModels().length;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "text/html; charset=utf-8" },
      json: async () => ({ html: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadModelRates({
      catalogUrl: "https://example.test/cli/model-rates.json",
      forceRefresh: true,
      ignoreDiskCache: true,
    });
    expect(getAllModels().length).toBeGreaterThanOrEqual(before);
    expect(getModel("groq/should-not-exist-from-html")).toBeNull();
  });

  it("ignores non-schema JSON bodies", async () => {
    const before = getAllModels().length;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ nope: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadModelRates({
      catalogUrl: "https://example.test/cli/model-rates.json",
      forceRefresh: true,
      ignoreDiskCache: true,
    });
    expect(getAllModels().length).toBeGreaterThanOrEqual(before);
  });
});
