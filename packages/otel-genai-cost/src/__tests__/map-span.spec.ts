import { describe, expect, it } from "vitest";
import { mapGenAiSpan, spanCorrelationId, storedInputTokens, type OtlpSpanLike } from "../map-span.js";

const s = (key: string, stringValue: string) => ({ key, value: { stringValue } });
const n = (key: string, intValue: number) => ({ key, value: { intValue: String(intValue) } });

function kongSpan(provider: string, input: number): OtlpSpanLike {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "aaaaaaaaaaaaaaaa",
    name: "kong.gen_ai",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    attributes: [
      s("gen_ai.provider.name", provider),
      s("gen_ai.request.model", "claude-sonnet-4-5"),
      n("gen_ai.usage.input_tokens", input),
      n("gen_ai.usage.cache_read.input_tokens", 800),
      n("gen_ai.usage.cache_creation.input_tokens", 100),
      n("gen_ai.usage.output_tokens", 300),
      s("gen_ai.response.id", "req-abc"),
    ],
  };
}

describe("mapGenAiSpan", () => {
  it("reads provider, cache tokens and response id from a Kong span", () => {
    const call = mapGenAiSpan(kongSpan("aws.bedrock", 1200), "kong");
    expect(call).toMatchObject({
      provider: "bedrock",
      providerRaw: "aws.bedrock",
      model: "claude-sonnet-4-5",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      responseId: "req-abc",
      status: "success",
    });
  });

  it("falls back to gen_ai.system and llm.provider", () => {
    const span: OtlpSpanLike = {
      attributes: [s("llm.provider", "azure"), s("llm.model_name", "gpt-4o"), n("llm.token_count.prompt", 5)],
    };
    expect(mapGenAiSpan(span)?.provider).toBe("azure_openai");
  });

  it("keeps an unknown provider as raw text with a null id", () => {
    const call = mapGenAiSpan(kongSpan("mistral", 10));
    expect(call?.provider).toBeNull();
    expect(call?.providerRaw).toBe("mistral");
  });

  it("returns null for a span that is not an LLM call", () => {
    expect(mapGenAiSpan({ attributes: [s("http.method", "GET")] })).toBeNull();
  });

  it("returns null for a span with a model but no usage and no response id", () => {
    expect(mapGenAiSpan({ attributes: [s("gen_ai.request.model", "gpt-4o")] })).toBeNull();
  });

  it("reads the gateway callers", () => {
    const span = kongSpan("anthropic", 300);
    span.attributes!.push(s("kong.auth.consumer.name", "search-svc"), s("kong.workspace.name", "prod"), s("user.email", "a@b.co"));
    expect(mapGenAiSpan(span, "kong")?.callers).toEqual([
      { kind: "consumer", id: "search-svc" },
      { kind: "workspace", id: "prod" },
      { kind: "user", id: "a@b.co" },
    ]);
  });

  it("detects Kong from kong.* attributes and returns the stored input", () => {
    const span = kongSpan("anthropic", 300);
    span.attributes!.push(s("kong.workspace.name", "prod"));
    expect(mapGenAiSpan(span)?.inputTokens).toBe(1200);
  });

  it("keeps input as reported for a non-Kong Anthropic span", () => {
    expect(mapGenAiSpan(kongSpan("anthropic", 1200))?.inputTokens).toBe(1200);
    expect(mapGenAiSpan(kongSpan("anthropic", 300), "otel")?.inputTokens).toBe(300 + 0);
  });

  it("marks an error status", () => {
    const span = kongSpan("openai", 5);
    span.attributes!.push(s("error.type", "rate_limit"));
    const call = mapGenAiSpan(span);
    expect(call?.status).toBe("error");
    expect(call?.errorType).toBe("rate_limit");
  });
});

describe("storedInputTokens", () => {
  it("adds cache back for a Kong Anthropic span", () => {
    expect(storedInputTokens("kong", "anthropic", 300, 800, 100)).toBe(1200);
  });
  it("trusts Kong's input for other providers", () => {
    expect(storedInputTokens("kong", "bedrock", 1200, 800, 100)).toBe(1200);
    expect(storedInputTokens("kong", null, 1200, 800, 100)).toBe(1200);
  });
  it("trusts otel and litellm input", () => {
    expect(storedInputTokens("otel", "anthropic", 1200, 800, 100)).toBe(1200);
    expect(storedInputTokens("litellm", "anthropic", 1200, 800, 100)).toBe(1200);
  });
});

describe("spanCorrelationId", () => {
  const trace = "0123456789abcdef0123456789abcdef";
  it("differs per span in one trace", () => {
    expect(spanCorrelationId(trace, "aaaaaaaaaaaaaaaa")).not.toBe(spanCorrelationId(trace, "bbbbbbbbbbbbbbbb"));
  });
  it("is stable and uuid-shaped", () => {
    const id = spanCorrelationId(trace, "aaaaaaaaaaaaaaaa");
    expect(id).toBe(spanCorrelationId(trace, "aaaaaaaaaaaaaaaa"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
