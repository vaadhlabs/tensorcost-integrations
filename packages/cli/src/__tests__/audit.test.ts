import { describe, expect, it } from "vitest";
import {
  auditFiles,
  parseAuditArgs,
  renderAudit,
  type AuditArgs,
} from "../commands/audit.js";
import { formatCents } from "../format.js";

const CURSOR_JSON = JSON.stringify({
  usageEvents: [
    { userEmail: "dana@acme.com", conversationId: "conv-big", chargedCents: 9000 },
    { userEmail: "lee@acme.com", conversationId: "conv-small", chargedCents: 1000 },
  ],
});
const USAGE_CSV = "cost,run_id,team\n40,r1,search\n10,,\n";

function reader(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

function args(over: Partial<AuditArgs>): AuditArgs {
  return { exports: [], invoices: [], json: false, ...over };
}

describe("parseAuditArgs", () => {
  it("takes one export and one invoice", () => {
    expect(parseAuditArgs(["usage.csv", "--invoice", "inv.csv"])).toEqual({
      exports: [{ path: "usage.csv" }],
      invoices: [{ value: "inv.csv" }],
      json: false,
    });
  });

  it("takes named exports and named invoices", () => {
    const parsed = parseAuditArgs([
      "openai=a.csv",
      "anthropic=b.csv",
      "--invoice",
      "openai=100",
      "--invoice",
      "anthropic=c.csv",
      "--window",
      "30",
    ]);
    expect(parsed.exports).toEqual([
      { provider: "openai", path: "a.csv" },
      { provider: "anthropic", path: "b.csv" },
    ]);
    expect(parsed.invoices).toEqual([
      { provider: "openai", value: "100" },
      { provider: "anthropic", value: "c.csv" },
    ]);
    expect(parsed.windowDays).toBe(30);
  });

  it("does not let --json swallow the path after it", () => {
    const parsed = parseAuditArgs(["--json", "usage.csv"]);
    expect(parsed.json).toBe(true);
    expect(parsed.exports).toEqual([{ path: "usage.csv" }]);
  });

  it("does not read an equals sign inside a path as a name", () => {
    expect(parseAuditArgs(["./exports/q=3.csv"]).exports).toEqual([
      { path: "./exports/q=3.csv" },
    ]);
  });

  it("asks for an export when given none", () => {
    expect(() => parseAuditArgs([])).toThrow(/usage export/);
  });

  it("rejects a window other than 30 or 90", () => {
    expect(() => parseAuditArgs(["a.csv", "--window", "45"])).toThrow(/30 or 90/);
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    expect(() => parseAuditArgs(["a.csv", "--invoices", "b"])).toThrow(/--invoices/);
  });

  it("rejects --invoice with nothing after it", () => {
    expect(() => parseAuditArgs(["a.csv", "--invoice"])).toThrow(/--invoice/);
  });
});

describe("auditFiles", () => {
  it("marks the result as a local run", () => {
    const out = auditFiles(
      args({ exports: [{ path: "usage.csv" }] }),
      reader({ "usage.csv": USAGE_CSV }),
    );
    expect(out.source).toBe("local_cli");
  });

  it("names an unnamed export after its file", () => {
    const out = auditFiles(
      args({ exports: [{ path: "/tmp/exports/Open AI.Usage.csv" }] }),
      reader({ "/tmp/exports/Open AI.Usage.csv": USAGE_CSV }),
    );
    expect(out.cross_vendor.providers[0]?.provider).toBe("open_ai_usage");
  });

  it("names an unnamed vendor export after the vendor", () => {
    const out = auditFiles(
      args({ exports: [{ path: "export.json" }] }),
      reader({ "export.json": CURSOR_JSON }),
    );
    expect(out.cross_vendor.providers[0]?.provider).toBe("cursor");
  });

  it("keeps a name the caller gave", () => {
    const out = auditFiles(
      args({ exports: [{ provider: "openai", path: "usage.csv" }] }),
      reader({ "usage.csv": USAGE_CSV }),
    );
    expect(out.cross_vendor.providers[0]?.provider).toBe("openai");
  });

  it("does not apply the public endpoint's limits", () => {
    const big = `cost,run_id\n${"1,r1\n".repeat(600_000)}`;
    const out = auditFiles(
      args({
        exports: ["a", "b", "c", "d"].map((provider) => ({
          provider,
          path: "big.csv",
        })),
      }),
      reader({ "big.csv": big }),
    );
    expect(out.cross_vendor.providers).toHaveLength(4);
  });

  it("takes an invoice as a plain amount", () => {
    const out = auditFiles(
      args({ exports: [{ path: "usage.csv" }], invoices: [{ value: "1,842.00" }] }),
      reader({ "usage.csv": USAGE_CSV }),
    );
    expect(out.invoice_reconciled_cents).toBe(184_200);
  });

  it("takes an invoice from a file", () => {
    const out = auditFiles(
      args({ exports: [{ path: "usage.csv" }], invoices: [{ value: "inv.csv" }] }),
      reader({ "usage.csv": USAGE_CSV, "inv.csv": "vendor,amount\nOpenAI,75\nTotal,75\n" }),
    );
    expect(out.invoice_reconciled_cents).toBe(7500);
  });

  it("adds up several invoices for one provider, as a 90-day window needs", () => {
    const out = auditFiles(
      args({
        exports: [{ path: "usage.csv" }],
        invoices: [{ value: "100" }, { value: "200.50" }, { value: "50" }],
      }),
      reader({ "usage.csv": USAGE_CSV }),
    );
    expect(out.invoice_reconciled_cents).toBe(35_050);
  });

  it("matches named invoices to named exports", () => {
    const out = auditFiles(
      args({
        exports: [
          { provider: "openai", path: "usage.csv" },
          { provider: "anthropic", path: "usage.csv" },
        ],
        invoices: [{ provider: "anthropic", value: "20" }],
      }),
      reader({ "usage.csv": USAGE_CSV }),
    );
    expect(out.reconciliation.map((r) => [r.provider, r.invoice_cents])).toEqual([
      ["openai", null],
      ["anthropic", 2000],
    ]);
  });

  it("says a PDF invoice can't be read and what to do instead", () => {
    expect(() =>
      auditFiles(
        args({ exports: [{ path: "usage.csv" }], invoices: [{ value: "inv.pdf" }] }),
        reader({ "usage.csv": USAGE_CSV, "inv.pdf": "%PDF-1.7 binary 2026 100" }),
      ),
    ).toThrow(/--invoice 1842\.00/);
  });

  it("refuses to guess a total it can't find", () => {
    expect(() =>
      auditFiles(
        args({ exports: [{ path: "usage.csv" }], invoices: [{ value: "inv.txt" }] }),
        reader({ "usage.csv": USAGE_CSV, "inv.txt": "Invoice 2026 for 3 seats" }),
      ),
    ).toThrow(/inv\.txt/);
  });

  it("refuses an unnamed invoice when there are several exports", () => {
    expect(() =>
      auditFiles(
        args({
          exports: [
            { provider: "openai", path: "usage.csv" },
            { provider: "anthropic", path: "usage.csv" },
          ],
          invoices: [{ value: "20" }],
        }),
        reader({ "usage.csv": USAGE_CSV }),
      ),
    ).toThrow(/openai=/);
  });

  it("refuses an invoice for a provider it wasn't given", () => {
    expect(() =>
      auditFiles(
        args({
          exports: [{ provider: "openai", path: "usage.csv" }],
          invoices: [{ provider: "anthropic", value: "20" }],
        }),
        reader({ "usage.csv": USAGE_CSV }),
      ),
    ).toThrow(/anthropic/);
  });

  it("names the file a parse error came from", () => {
    expect(() =>
      auditFiles(
        args({ exports: [{ path: "bad.csv" }] }),
        reader({ "bad.csv": "name,email\na,b\n" }),
      ),
    ).toThrow(/bad\.csv/);
  });
});

describe("renderAudit", () => {
  const generic = auditFiles(
    args({
      exports: [{ provider: "openai", path: "usage.csv" }],
      invoices: [{ value: "75" }],
    }),
    reader({ "usage.csv": USAGE_CSV }),
  );

  it("states that nothing left the machine", () => {
    expect(renderAudit(generic)).toMatch(/Nothing was sent anywhere/);
  });

  it("prints all five numbers, in the offer's order", () => {
    const text = renderAudit(generic);
    const headings = [
      "1. The run your cap did not see",
      "2. Spend with no owner",
      "3. Price paid, not list",
      "4. Capitalisation-ready share (estimate)",
      "5. Cost per attempt",
    ];
    const positions = headings.map((h) => text.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names the largest run with its dollars and share", () => {
    const text = renderAudit(generic);
    expect(text).toContain("r1");
    expect(text).toContain("$40.00");
    expect(text).toContain("80");
  });

  it("states the unowned amount against the total", () => {
    expect(renderAudit(generic)).toMatch(/\$10\.00 of \$50\.00 \(20(\.0)?%\)/);
  });

  it("says which way the invoice and the export differ", () => {
    expect(renderAudit(generic)).toMatch(/invoice is \$25\.00 higher/i);
  });

  it("points at --invoice rather than an API field when none was given", () => {
    const out = auditFiles(
      args({ exports: [{ path: "usage.csv" }] }),
      reader({ "usage.csv": USAGE_CSV }),
    );
    const text = renderAudit(out);
    expect(text).toContain("--invoice");
    expect(text).not.toContain("invoice_total_usd");
  });

  it("shows spend by tool and by person, and says which figures are estimates", () => {
    const claude = JSON.stringify({
      data: [
        {
          actor: { type: "user_actor", email_address: "dana@acme.com" },
          model_breakdown: [{ estimated_cost: { currency: "USD", amount: 4000 } }],
        },
      ],
    });
    const text = renderAudit(
      auditFiles(
        args({ exports: [{ path: "c.json" }, { path: "d.json" }] }),
        reader({ "c.json": CURSOR_JSON, "d.json": claude }),
      ),
    );
    expect(text).toMatch(/Cursor\s+\$100\.00\s+2 people\s+billed/);
    expect(text).toMatch(/Claude Code\s+\$40\.00\s+1 person\s+estimated/);
    expect(text).toMatch(/dana@acme\.com\s+\$130\.00/);
  });

  it("lines the amounts up on their right edge", () => {
    const events = [
      { userEmail: "a@acme.com", conversationId: "c1", chargedCents: 123_456 },
      { userEmail: "b@acme.com", conversationId: "c2", chargedCents: 500 },
    ];
    const lines = renderAudit(
      auditFiles(
        args({ exports: [{ path: "e.json" }] }),
        reader({ "e.json": JSON.stringify({ usageEvents: events }) }),
      ),
    ).split("\n");
    const endOfTotal = (email: string) => {
      const line = lines.find((l) => l.trimStart().startsWith(email))!;
      return line.indexOf(".", line.indexOf("$")) + 3;
    };
    expect(endOfTotal("a@acme.com")).toBe(endOfTotal("b@acme.com"));
  });

  it("leaves the people section out of an ordinary audit", () => {
    expect(renderAudit(generic)).not.toContain("By person");
  });

  it("lists the top ten people and counts the rest", () => {
    const events = Array.from({ length: 13 }, (_, i) => ({
      userEmail: `dev${i}@acme.com`,
      conversationId: `c${i}`,
      chargedCents: 100 + i,
    }));
    const text = renderAudit(
      auditFiles(
        args({ exports: [{ path: "e.json" }] }),
        reader({ "e.json": JSON.stringify({ usageEvents: events }) }),
      ),
    );
    expect(text).toMatch(/top 10 of 13/);
    expect(text).toContain("dev12@acme.com");
    expect(text).not.toContain("dev0@acme.com");
  });

  it("reports credits in credits, not as zero dollars", () => {
    const text = renderAudit(
      auditFiles(
        args({ exports: [{ provider: "github", path: "c.csv" }] }),
        reader({ "c.csv": "credits_used,run_id\n300,r1\n100,\n" }),
      ),
    );
    expect(text).toContain("300 credits");
    expect(text).toMatch(/100 of 400 credits/);
    expect(text).not.toContain("$0.00");
  });

  it("stays out of the wording the public offer rules out", () => {
    const text = renderAudit(generic);
    expect(text).not.toMatch(
      /reserve budget|hard stop|per-agent kill|only vendor|SOC 2|guarantee/i,
    );
  });
});

describe("formatCents", () => {
  it("groups thousands", () => {
    expect(formatCents(123_456)).toBe("$1,234.56");
  });

  it("puts the sign in front of the dollar mark", () => {
    expect(formatCents(-500)).toBe("-$5.00");
  });
});
