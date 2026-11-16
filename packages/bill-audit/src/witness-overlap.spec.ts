import { describe, expect, it } from "vitest";
import {
  parseBedrockInvocationLog,
  parseFocusBill,
  parseLiteLlmSpendLog,
  witnessOverlap,
} from "./witness-overlap.js";

const TWO_CENTS = () => 2;

function litellmCsv(rows: Array<{ id: string; at: string; cents?: number }>): string {
  const lines = rows.map(
    (r) =>
      `req-${r.id},${r.id},bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0,${((r.cents ?? 2) / 100).toFixed(4)},1000,500,${r.at}`,
  );
  return ["request_id,id,model,spend,prompt_tokens,completion_tokens,startTime", ...lines].join("\n");
}

function invocationLog(rows: Array<{ id: string; at: string }>): string {
  return rows
    .map((r) =>
      JSON.stringify({
        schemaType: "ModelInvocationLog",
        timestamp: r.at,
        requestId: r.id,
        modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        operation: "Converse",
        input: { inputTokenCount: 1000 },
        output: { outputTokenCount: 500 },
      }),
    )
    .join("\n");
}

const at = (n: number) => `2026-11-10T12:${String(n % 60).padStart(2, "0")}:00.000Z`;
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("witnessOverlap", () => {
  it("counts 40 shared calls once and keeps the 10 calls only one input saw", () => {
    const shared = ids("shared-", 40);
    const gatewayOnly = ids("gw-", 5);
    const logOnly = ids("log-", 5);
    const gateway = parseLiteLlmSpendLog(
      litellmCsv([...shared, ...gatewayOnly].map((id, i) => ({ id, at: at(i) }))),
    );
    const log = parseBedrockInvocationLog(
      invocationLog([...shared, ...logOnly].map((id, i) => ({ id, at: at(i) }))),
      TWO_CENTS,
    );

    const out = witnessOverlap([...gateway, ...log.calls]);

    expect(out.naive_cents).toBe(180);
    expect(out.counted_cents).toBe(100);
    expect(out.counted_twice_cents).toBe(80);
    expect(out.by_pair).toEqual([
      { sources: ["litellm", "bedrock-invocations"], calls: 40, cents: 80 },
    ]);
  });

  it("an api base is Bedrock only by its exact hostname", () => {
    const csv = (base: string, model: string) =>
      `request_id,model,api_base,spend,prompt_tokens,completion_tokens,startTime\nr1,${model},${base},0.02,1000,500,${at(1)}`;
    expect(parseLiteLlmSpendLog(csv("https://bedrock-gw.corp.example/v1", "gpt-4o"))[0]!.provider).toBe("openai");
    expect(parseLiteLlmSpendLog(csv("https://my-bedrock-proxy.internal", "claude-sonnet-4-5"))[0]!.provider).toBe("anthropic");
    expect(parseLiteLlmSpendLog(csv("https://bedrock-runtime.us-east-1.amazonaws.com", "claude-sonnet-4-5"))[0]!.provider).toBe("bedrock");
  });

  it("matches on the response id column, not LiteLLM's own request id", () => {
    const gateway = parseLiteLlmSpendLog(litellmCsv([{ id: "abc", at: at(1) }]));
    expect(gateway[0]!.provider_response_id).toBe("abc");
  });

  it("does not collapse two calls that only look alike when a reported row is involved", () => {
    const gateway = parseLiteLlmSpendLog(
      "request_id,model,spend,prompt_tokens,completion_tokens,startTime\nr1,bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0,0.02,1000,500," +
        at(1),
    );
    const log = parseBedrockInvocationLog(invocationLog([{ id: "x", at: at(1) }]), TWO_CENTS);
    const out = witnessOverlap([...gateway, ...log.calls]);
    expect(out.counted_twice_cents).toBe(0);
    expect(out.counted_cents).toBe(4);
  });

  it("reports nothing twice for a single input", () => {
    const gateway = parseLiteLlmSpendLog(litellmCsv([{ id: "a", at: at(1) }, { id: "b", at: at(2) }]));
    const out = witnessOverlap(gateway);
    expect(out.counted_twice_cents).toBe(0);
    expect(out.by_pair).toEqual([]);
    expect(out.counted_cents).toBe(out.naive_cents);
  });

  it("counts a call seen twice by the same input as a pair of that input with itself", () => {
    const gateway = parseLiteLlmSpendLog(litellmCsv([{ id: "a", at: at(1) }, { id: "a", at: at(1) }]));
    const out = witnessOverlap(gateway);
    expect(out.counted_twice_cents).toBe(2);
    expect(out.by_pair[0]!.sources).toEqual(["litellm", "litellm"]);
  });

  it("lists a bill beside the calls without netting it", () => {
    const bill = parseFocusBill(
      "ServiceName,BilledCost,ChargePeriodStart\nAmazon Bedrock,12.50,2026-11-01\nAmazon EC2,99.00,2026-11-01\nAmazon Bedrock,0.25,2026-11-02\n",
    );
    expect(bill.total_cents).toBe(1275);
    const out = witnessOverlap([], [bill]);
    expect(out.bills).toEqual([{ source: "bedrock-cur", cents: 1275 }]);
    expect(out.counted_twice_cents).toBe(0);
  });
});

describe("parseBedrockInvocationLog", () => {
  it("counts a call it can't price as zero and says how many", () => {
    const out = parseBedrockInvocationLog(invocationLog([{ id: "a", at: at(1) }]), () => null);
    expect(out.unpriced).toBe(1);
    expect(out.calls[0]!.cost_cents).toBe(0);
  });

  it("skips lines that aren't invocation records", () => {
    const out = parseBedrockInvocationLog(`not json\n{"foo":1}\n${invocationLog([{ id: "a", at: at(1) }])}`, TWO_CENTS);
    expect(out.calls).toHaveLength(1);
  });
});

describe("parseFocusBill", () => {
  it("reads every row when the export has no service column", () => {
    expect(parseFocusBill("BilledCost\n1.00\n2.00\n").total_cents).toBe(300);
  });

  it("refuses a file with no cost column", () => {
    expect(() => parseFocusBill("ServiceName\nAmazon Bedrock\n")).toThrow(/FOCUS/);
  });
});
