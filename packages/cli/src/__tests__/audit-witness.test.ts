import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditReport,
  parseAuditArgs,
  renderReport,
  type AuditArgs,
} from "../commands/audit.js";
import { loadModelRates } from "../pricing.js";

const MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const CLOSING =
  "Connected, TensorCost counts this daily and lets your gateways enforce one budget: https://tensorcost.com/connect";

function litellm(ids: string[]): string {
  const rows = ids.map(
    (id, i) =>
      `req-${id},${id},bedrock/${MODEL},0.0105,1000,500,2026-11-10T12:${String(i % 60).padStart(2, "0")}:00Z`,
  );
  return ["request_id,id,model,spend,prompt_tokens,completion_tokens,startTime", ...rows].join("\n");
}

function invocations(ids: string[]): string {
  return ids
    .map((id, i) =>
      JSON.stringify({
        timestamp: `2026-11-10T12:${String(i % 60).padStart(2, "0")}:00Z`,
        requestId: id,
        modelId: MODEL,
        input: { inputTokenCount: 1000 },
        output: { outputTokenCount: 500 },
      }),
    )
    .join("\n");
}

const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const noRates = async () => {};

function args(over: Partial<AuditArgs>): AuditArgs {
  return { exports: [], invoices: [], json: false, ...over };
}

function reader(files: Record<string, string>) {
  return (path: string) => {
    const c = files[path];
    if (c === undefined) throw new Error(`ENOENT ${path}`);
    return c;
  };
}

describe("parseAuditArgs --export", () => {
  it("takes --export name=path like a named export", () => {
    const parsed = parseAuditArgs([
      "--export", "litellm=spend.csv",
      "--export", "bedrock-cur=cur.csv",
      "--invoice", "anthropic=1234.56",
    ]);
    expect(parsed.exports).toEqual([
      { provider: "litellm", path: "spend.csv" },
      { provider: "bedrock-cur", path: "cur.csv" },
    ]);
    expect(parsed.invoices).toEqual([{ provider: "anthropic", value: "1234.56" }]);
  });
});

describe("auditReport", () => {
  const shared = range("shared-", 40);
  const files = {
    "spend.csv": litellm([...shared, ...range("gw-", 5)]),
    "inv.jsonl": invocations([...shared, ...range("log-", 5)]),
  };

  it("shows 40 shared calls counted twice and the 50 calls counted once", async () => {
    const report = await auditReport(
      args({
        exports: [
          { provider: "litellm", path: "spend.csv" },
          { provider: "bedrock-invocations", path: "inv.jsonl" },
        ],
      }),
      { readFile: reader(files), loadRates: noRates },
    );
    const twice = report.counted_twice!;
    // 1000 in and 500 out at the bundled Sonnet rate is 1.05 cents a call.
    expect(twice.by_pair).toEqual([
      { sources: ["litellm", "bedrock-invocations"], calls: 40, cents: 42 },
    ]);
    expect(twice.counted_twice_cents).toBe(42);
    // 50 calls at 1.05 cents, 90 added up: 52.5 and 94.5 before rounding.
    expect(Math.abs(twice.counted_cents - 52.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(twice.naive_cents - 94.5)).toBeLessThanOrEqual(0.5);

    const text = renderReport(report);
    expect(text).toContain("Counted twice: $0.42");
    expect(text).toContain("litellm + bedrock-invocations");
    expect(text).toMatch(/only on the response id/i);
    expect(text.trimEnd().split("\n").at(-1)).toBe(CLOSING);
  });

  it("lists an invoice for a provider no export names, beside the counted calls", async () => {
    const report = await auditReport(
      args({
        exports: [{ provider: "litellm", path: "spend.csv" }],
        invoices: [{ provider: "anthropic", value: "1234.56" }],
      }),
      { readFile: reader(files), loadRates: noRates },
    );
    expect(renderReport(report)).toContain("anthropic $1,234.56");
  });

  it("reads a FOCUS CSV and says a parquet file isn't read", async () => {
    const ok = await auditReport(
      args({ exports: [{ provider: "bedrock-cur", path: "cur.csv" }] }),
      { readFile: reader({ "cur.csv": "ServiceName,BilledCost\nAmazon Bedrock,10.00\n" }), loadRates: noRates },
    );
    expect(ok.counted_twice!.bills).toEqual([{ source: "bedrock-cur", cents: 1000 }]);

    await expect(
      auditReport(args({ exports: [{ provider: "bedrock-cur", path: "cur.parquet" }] }), {
        readFile: reader({}),
        loadRates: noRates,
      }),
    ).rejects.toThrow(/FOCUS CSV/);
  });

  it("still audits ordinary exports alongside the witness inputs", async () => {
    const report = await auditReport(
      args({
        exports: [
          { provider: "openai", path: "usage.csv" },
          { provider: "litellm", path: "spend.csv" },
        ],
      }),
      { readFile: reader({ ...files, "usage.csv": "cost,run_id\n40,r1\n10,\n" }), loadRates: noRates },
    );
    expect(report.audit?.cross_vendor.providers[0]?.provider).toBe("openai");
    expect(report.counted_twice).not.toBeNull();
  });
});

describe("network", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  function watchFetch(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response("nope", { status: 503 });
    }) as typeof fetch;
    return urls;
  }

  const read = reader({
    "spend.csv": litellm(["a", "b"]),
    "inv.jsonl": invocations(["a", "b"]),
    "cur.csv": "BilledCost\n1.00\n",
  });
  const catalogue = () => loadModelRates({ ignoreDiskCache: true });

  it("never fetches for a gateway log and a bill", async () => {
    const urls = watchFetch();
    await auditReport(
      args({
        exports: [
          { provider: "litellm", path: "spend.csv" },
          { provider: "bedrock-cur", path: "cur.csv" },
        ],
      }),
      { readFile: read, loadRates: catalogue },
    );
    expect(urls).toEqual([]);
  });

  it("fetches only the public price catalogue, and only to price an invocation log", async () => {
    vi.stubEnv("TENSORCOST_OFFLINE", "");
    vi.stubEnv("TENSORCOST_CATALOG_URL", "");
    vi.stubEnv("TENSORCOST_INSTANCE", "");
    const urls = watchFetch();
    await auditReport(
      args({
        exports: [
          { provider: "litellm", path: "spend.csv" },
          { provider: "bedrock-invocations", path: "inv.jsonl" },
        ],
      }),
      { readFile: read, loadRates: catalogue },
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/[^/]*tensorcost\.com\/cli\/model-rates\.json$/);
    }
  });
});
