import { describe, expect, it } from "vitest";
import { ProspectCsvParseError } from "./prospect-csv.js";
import { parseUsageExport } from "./usage-export.js";

// Field names below are copied from each vendor's docs (checked 2026-11-05),
// so a rename here should mean the vendor changed, not that a test was tidied.

const COPILOT_HEADER =
  "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,username,organization,app_client_id,repository,cost_center_name,model,input,output,cache_read,cache_write";

function copilotRow(opts: {
  user: string;
  gross: string;
  net: string;
  costCenter?: string;
}): string {
  return `2026-10-01,copilot,ai_credits,100,credits,0.01,${opts.gross},0,${opts.net},${opts.user},acme,app1,acme/api,${opts.costCenter ?? ""},gpt-5,10,10,0,0`;
}

function cursorEvent(over: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: "1750979225854",
    userEmail: "dev@acme.com",
    conversationId: "conv-1",
    model: "claude-opus-5-5",
    kind: "Usage-based",
    chargedCents: 10,
    tokenUsage: { inputTokens: 1, outputTokens: 1, totalCents: 10 },
    ...over,
  };
}

describe("parseUsageExport generic CSV", () => {
  it("leaves an ordinary usage CSV to the generic parser", () => {
    const parsed = parseUsageExport("cost,run_id\n12.50,r1\n");
    expect(parsed.format).toBe("generic");
    expect(parsed.total_cents).toBe(1250);
    expect(parsed.rows[0]?.workflow_id).toBe("r1");
  });
});

describe("parseUsageExport GitHub Copilot AI usage report", () => {
  it("bills on net_amount and keeps gross_amount beside it", () => {
    const parsed = parseUsageExport(
      `${COPILOT_HEADER}\n${copilotRow({ user: "dana", gross: "5.00", net: "3.50" })}\n`,
    );
    expect(parsed.format).toBe("github_copilot");
    expect(parsed.cost_basis).toBe("billed");
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        person: "dana",
        tool: "GitHub Copilot",
        cost_cents: 350,
        gross_cents: 500,
      }),
    ]);
  });

  it("keeps usage covered by included credits, which bills at zero", () => {
    const parsed = parseUsageExport(
      `${COPILOT_HEADER}\n${copilotRow({ user: "dana", gross: "5.00", net: "0" })}\n`,
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.cost_cents).toBe(0);
    expect(parsed.rows[0]?.gross_cents).toBe(500);
  });

  it("adds sub-cent rows up before rounding", () => {
    const rows = Array.from({ length: 4 }, () =>
      copilotRow({ user: "dana", gross: "0.004", net: "0.004" }),
    );
    const parsed = parseUsageExport(`${COPILOT_HEADER}\n${rows.join("\n")}\n`);
    expect(parsed.total_cents).toBe(2);
  });

  it("treats a cost centre as a tag", () => {
    const parsed = parseUsageExport(
      `${COPILOT_HEADER}\n${copilotRow({ user: "dana", gross: "1", net: "1", costCenter: "platform" })}\n`,
    );
    expect(parsed.rows[0]?.tagged).toBe(true);
  });

  it("points at the right report when given the all-products detailed report", () => {
    expect(() =>
      parseUsageExport(
        "date,product,sku,quantity,gross_amount,discount_amount,net_amount,username\n2026-10-01,actions,linux,1,1,0,1,dana\n",
      ),
    ).toThrow(/AI usage report/);
  });
});

describe("parseUsageExport Cursor Admin API", () => {
  it("uses conversationId as the run and userEmail as the person", () => {
    const parsed = parseUsageExport(
      JSON.stringify({ usageEvents: [cursorEvent({ chargedCents: 250 })] }),
    );
    expect(parsed.format).toBe("cursor");
    expect(parsed.cost_basis).toBe("billed");
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        person: "dev@acme.com",
        workflow_id: "conv-1",
        tool: "Cursor",
        cost_cents: 250,
        gross_cents: 10,
      }),
    ]);
  });

  it("adds fractional cents up within a conversation before rounding", () => {
    const events = [0.4, 0.4, 0.4].map((chargedCents) =>
      cursorEvent({ chargedCents }),
    );
    const parsed = parseUsageExport(JSON.stringify({ usageEvents: events }));
    expect(parsed.total_cents).toBe(1);
  });

  it("reads several saved pages from a JSON array", () => {
    const parsed = parseUsageExport(
      JSON.stringify([
        { usageEvents: [cursorEvent({ conversationId: "a" })] },
        { usageEvents: [cursorEvent({ conversationId: "b" })] },
      ]),
    );
    expect(parsed.rows).toHaveLength(2);
  });

  it("reads several saved pages from JSON lines", () => {
    const line = JSON.stringify({ usageEvents: [cursorEvent({})] });
    const parsed = parseUsageExport(`${line}\n${line}\n`);
    expect(parsed.total_cents).toBe(20);
  });

  it("names a service account when no person is attached", () => {
    const parsed = parseUsageExport(
      JSON.stringify({
        usageEvents: [
          cursorEvent({ userEmail: null, serviceAccountName: "ci-bot" }),
        ],
      }),
    );
    expect(parsed.rows[0]?.person).toBe("service:ci-bot");
  });

  it("leaves an event with nobody attached unowned", () => {
    const parsed = parseUsageExport(
      JSON.stringify({
        usageEvents: [cursorEvent({ userEmail: null, conversationId: null })],
      }),
    );
    expect(parsed.rows[0]?.person).toBeNull();
    expect(parsed.rows[0]?.workflow_id).toBeNull();
  });

  it("reads the per-member spend endpoint, billing on-demand spend only", () => {
    const parsed = parseUsageExport(
      JSON.stringify({
        teamMemberSpend: [
          {
            userId: "user_1",
            email: "dev@acme.com",
            spendCents: 2450.125487,
            overallSpendCents: 4000.5,
          },
        ],
      }),
    );
    expect(parsed.format).toBe("cursor");
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        person: "dev@acme.com",
        workflow_id: null,
        cost_cents: 2450,
        gross_cents: 4001,
      }),
    ]);
  });
});

describe("parseUsageExport Claude Code Analytics API", () => {
  const record = {
    date: "2025-09-08T00:00:00Z",
    actor: { type: "user_actor", email_address: "dev@acme.com" },
    customer_type: "api",
    terminal_type: "vscode",
    core_metrics: { num_sessions: 5 },
    model_breakdown: [
      { model: "a", estimated_cost: { currency: "USD", amount: 113 } },
      { model: "b", estimated_cost: { currency: "USD", amount: 7 } },
    ],
  };

  it("sums estimated cents across models and marks the figure as estimated", () => {
    const parsed = parseUsageExport(
      JSON.stringify({ data: [record], has_more: false, next_page: null }),
    );
    expect(parsed.format).toBe("claude_code");
    expect(parsed.cost_basis).toBe("estimated");
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        person: "dev@acme.com",
        tool: "Claude Code",
        cost_cents: 120,
        gross_cents: null,
        workflow_id: null,
      }),
    ]);
  });

  it("names an API key actor", () => {
    const parsed = parseUsageExport(
      JSON.stringify({
        data: [
          { ...record, actor: { type: "api_actor", api_key_name: "ci-key" } },
        ],
      }),
    );
    expect(parsed.rows[0]?.person).toBe("key:ci-key");
  });
});

describe("parseUsageExport Claude spend report CSV", () => {
  const header =
    "user_email,account_uuid,product,model,model_family,total_requests,total_prompt_tokens,total_completion_tokens,total_net_spend_usd,total_gross_spend_usd";

  it("bills on net spend and splits tools by product", () => {
    const parsed = parseUsageExport(
      `${header}\na@acme.com,u1,Claude Code,m,f,1,1,1,4.00,5.00\na@acme.com,u1,Chat,m,f,1,1,1,1.00,1.00\n`,
    );
    expect(parsed.format).toBe("claude_code");
    expect(parsed.cost_basis).toBe("billed");
    expect(parsed.rows.map((r) => [r.tool, r.cost_cents, r.gross_cents])).toEqual(
      [
        ["Claude Code", 400, 500],
        ["Claude Chat", 100, 100],
      ],
    );
  });

  it("finds the email column whatever the export calls it", () => {
    const parsed = parseUsageExport(
      "User Email,product,total_net_spend_usd\na@acme.com,Chat,2\n",
    );
    expect(parsed.rows[0]?.person).toBe("a@acme.com");
  });
});

describe("parseUsageExport people", () => {
  it("treats an email as one person whatever its case", () => {
    const parsed = parseUsageExport(
      JSON.stringify({
        usageEvents: [
          cursorEvent({ userEmail: "Dana@Acme.com", chargedCents: 100 }),
          cursorEvent({ userEmail: "dana@acme.com", chargedCents: 100 }),
        ],
      }),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.person).toBe("dana@acme.com");
  });

  it("leaves a username's case alone, since it isn't an email", () => {
    const parsed = parseUsageExport(
      `${COPILOT_HEADER}\n${copilotRow({ user: "DanaK", gross: "1", net: "1" })}\n`,
    );
    expect(parsed.rows[0]?.person).toBe("DanaK");
  });
});

describe("parseUsageExport unrecognised JSON", () => {
  it("says which JSON exports it can read", () => {
    expect(() => parseUsageExport('{"hello":"world"}')).toThrow(
      ProspectCsvParseError,
    );
    expect(() => parseUsageExport('{"hello":"world"}')).toThrow(/Cursor/);
  });

  it("does not throw a raw syntax error on broken JSON", () => {
    expect(() => parseUsageExport('{"usageEvents": [')).toThrow(
      ProspectCsvParseError,
    );
  });
});
