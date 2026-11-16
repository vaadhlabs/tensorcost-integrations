import { describe, expect, it } from "vitest";
import {
  buildProspectBillAudit,
  ProspectAuditValidationError,
} from "./prospect-audit.builder.js";

const SAMPLE_CSV = `workflow_id,agent_id,cost,project
run-a,agent-1,10.00,proj-x
run-a,agent-1,5.00,proj-x
,agent-2,2.50,
,,3.00,
run-b,,8.00,`;

describe("buildProspectBillAudit", () => {
  it("computes five lines and cross-vendor from one export", () => {
    const out = buildProspectBillAudit({
      window_days: 90,
      providers: [
        {
          provider: "openai",
          usage_csv: SAMPLE_CSV,
          invoice_total_usd: 24,
        },
      ],
    });
    expect(out.source).toBe("prospect_upload");
    expect(out.lines.unowned_spend.unowned_cents).toBe(550);
    expect(out.envelope_preview[0]!.proposed_envelope.amount).toBeLessThan(
      out.envelope_preview[0]!.spend_native_cap_would_miss_cents,
    );
    expect(out.lines.cap_blind_spot.largest_run_workflow_id).toBe("run-a");
    expect(out.lines.price_paid_vs_list.effective_cents).toBe(2400);
    expect(out.invoice_reconciled_cents).toBe(2400);
    expect(out.envelope_preview).toHaveLength(1);
    expect(out.envelope_preview[0]?.applied).toBe(false);
  });

  it("merges two providers for cross_vendor", () => {
    const out = buildProspectBillAudit({
      providers: [
        { provider: "openai", usage_csv: "cost\n10\n" },
        { provider: "anthropic", usage_csv: "cost\n5\n" },
      ],
    });
    expect(out.cross_vendor.providers).toHaveLength(2);
    expect(out.lines.unowned_spend.instrumented_cents).toBe(1500);
  });

  it("marks credit pools when export is credit-denominated", () => {
    const out = buildProspectBillAudit({
      providers: [
        {
          provider: "github",
          usage_csv: "credits_used,cost\n100,0\n",
          credit_pool_label: "Copilot Business",
        },
      ],
    });
    expect(out.lines.price_paid_vs_list.credit_pools).toBe("noted_in_export");
  });
  describe("partial invoices", () => {
    const OPENAI_CSV = `date,run_id,agent_id,project,cost_usd
2026-09-01,run-1,agent-a,search,12.50
2026-09-02,run-1,agent-a,search,7.25
2026-09-03,run-2,agent-b,,40.00
2026-09-04,,,,15.00
2026-09-05,run-3,agent-a,billing,5.25
Total,,,,80.00`;
    const ANTHROPIC_CSV = `session_id,Cost,team
s1,"$1,200.50",ml
s2,$300.00,
s3,(10.00),ml`;

    it("reconciles only the provider that supplied an invoice", () => {
      const out = buildProspectBillAudit({
        providers: [
          { provider: "openai", usage_csv: OPENAI_CSV, invoice_total_usd: 95 },
          { provider: "anthropic", usage_csv: ANTHROPIC_CSV },
        ],
      });

      // Export stays the all-provider total; the comparison does not.
      expect(out.export_total_cents).toBe(8000 + 149_050);
      expect(out.invoice_reconciled_cents).toBe(9500);
      expect(out.lines.price_paid_vs_list).toMatchObject({
        status: "computed",
        effective_cents: 9500,
        list_estimate_cents: 8000,
        gap_cents: -1500,
      });
      expect(out.lines.cap_blind_spot.list_vs_effective_gap_cents).toBe(-1500);
      expect(out.lines.price_paid_vs_list.note).toContain("anthropic");

      expect(out.reconciliation).toEqual([
        {
          provider: "openai",
          unit: "usd_cents",
          invoice_cents: 9500,
          export_cents: 8000,
          export_credits: null,
          gap_cents: -1500,
        },
        {
          provider: "anthropic",
          unit: "usd_cents",
          invoice_cents: null,
          export_cents: 149_050,
          export_credits: null,
          gap_cents: null,
        },
      ]);
    });

    it("sums every provider when all of them supplied an invoice", () => {
      const out = buildProspectBillAudit({
        providers: [
          { provider: "openai", usage_csv: OPENAI_CSV, invoice_total_usd: 95 },
          {
            provider: "anthropic",
            usage_csv: ANTHROPIC_CSV,
            invoice_total_usd: 1500,
          },
        ],
      });
      expect(out.lines.price_paid_vs_list).toMatchObject({
        effective_cents: 9500 + 150_000,
        list_estimate_cents: 157_050,
        gap_cents: -2450,
      });
      expect(out.reconciliation.map((r) => r.gap_cents)).toEqual([
        -1500, -950,
      ]);
    });

    it("stays account-level when no provider supplied an invoice", () => {
      const out = buildProspectBillAudit({
        providers: [
          { provider: "openai", usage_csv: OPENAI_CSV },
          { provider: "anthropic", usage_csv: ANTHROPIC_CSV },
        ],
      });
      expect(out.invoice_reconciled_cents).toBeNull();
      expect(out.lines.cap_blind_spot.list_vs_effective_gap_cents).toBeNull();
      expect(out.lines.price_paid_vs_list).toMatchObject({
        status: "account_level_only",
        effective_cents: 157_050,
        list_estimate_cents: 157_050,
        gap_cents: 0,
      });
      expect(out.lines.price_paid_vs_list.note).toContain("invoice_total_usd");
      expect(out.reconciliation.every((r) => r.gap_cents === null)).toBe(true);
    });
  });

  describe("credit-denominated exports", () => {
    const COPILOT_CSV = `run_id,credits_used,team
r1,500,ml
r2,120,`;

    it("measures run share and tagged share in credits when every export is credits", () => {
      const out = buildProspectBillAudit({
        providers: [
          {
            provider: "github-copilot",
            usage_csv: COPILOT_CSV,
            credit_pool_label: "Copilot",
          },
        ],
      });
      expect(out.headline_unit).toBe("credits");
      expect(out.lines.cap_blind_spot).toMatchObject({
        status: "estimated",
        largest_run_workflow_id: "r1",
        largest_run_share_pct: 80.6,
        native_cap_would_miss: true,
        // No dollars in this export; the credit figure lives on credit_headline.
        largest_run_cost_cents: 0,
      });
      expect(out.lines.capitalisation_estimate).toMatchObject({
        status: "estimated",
        capitalisation_eligible_share_pct: 80.6,
        tagged_cents: 0,
      });
      expect(out.lines.unowned_spend).toMatchObject({
        status: "computed",
        unowned_pct: 0,
        instrumented_cents: 0,
      });
      expect(out.credit_headline).toEqual({
        providers: ["github-copilot"],
        instrumented_credits: 620,
        unowned_credits: 0,
        largest_run_workflow_id: "r1",
        largest_run_credits: 500,
        largest_run_share_pct: 80.6,
        native_cap_would_miss: true,
        tagged_credits: 500,
        tagged_share_pct: 80.6,
      });
      expect(out.sdk_workflow_coverage_pct).toBe(100);
      expect(out.cross_vendor.providers[0]!.share_pct).toBe(100);
      expect(out.reconciliation).toEqual([
        {
          provider: "github-copilot",
          unit: "credits",
          invoice_cents: null,
          export_cents: 0,
          export_credits: 620,
          gap_cents: null,
        },
      ]);
      expect(out.lines.price_paid_vs_list.note).not.toContain("invoice_total_usd");
      const env = out.envelope_preview[0]!;
      expect(env.proposed_envelope.unit).toBe("credits");
      expect(env.largest_run_credits).toBe(500);
    });

    it("does not compare a dollar invoice against a credit export", () => {
      const out = buildProspectBillAudit({
        providers: [
          {
            provider: "github-copilot",
            usage_csv: COPILOT_CSV,
            invoice_total_usd: 40,
          },
        ],
      });
      expect(out.invoice_reconciled_cents).toBeNull();
      expect(out.lines.price_paid_vs_list.status).toBe("account_level_only");
      // Asking for another invoice would not help; say why there is no gap.
      expect(out.lines.price_paid_vs_list.note).toContain("no dollar total");
      expect(out.reconciliation[0]).toMatchObject({
        invoice_cents: 4000,
        gap_cents: null,
      });
    });

    it("keeps the headline in USD when a credit export sits beside a USD one", () => {
      const out = buildProspectBillAudit({
        providers: [
          {
            provider: "openai",
            usage_csv: "run_id,cost,project\nrun-1,90,ops\nrun-2,10,\n",
            invoice_total_usd: 120,
          },
          {
            provider: "github-copilot",
            usage_csv: COPILOT_CSV,
            credit_pool_label: "Copilot",
          },
        ],
      });
      expect(out.headline_unit).toBe("usd_cents");
      // 90 of 100 dollars; the 500 credits never enter the percentage.
      expect(out.lines.cap_blind_spot).toMatchObject({
        largest_run_workflow_id: "run-1",
        largest_run_cost_cents: 9000,
        largest_run_share_pct: 90,
      });
      expect(out.lines.capitalisation_estimate).toMatchObject({
        tagged_cents: 9000,
        capitalisation_eligible_share_pct: 90,
      });
      expect(out.lines.unowned_spend).toMatchObject({
        instrumented_cents: 10_000,
        unowned_cents: 0,
      });
      expect(out.sdk_workflow_coverage_pct).toBe(100);
      expect(out.export_total_cents).toBe(10_000);
      expect(out.lines.price_paid_vs_list).toMatchObject({
        effective_cents: 12_000,
        list_estimate_cents: 10_000,
        gap_cents: -2000,
      });
      expect(out.credit_headline).toMatchObject({
        providers: ["github-copilot"],
        largest_run_credits: 500,
        largest_run_share_pct: 80.6,
        tagged_credits: 500,
      });
      expect(out.reconciliation.map((r) => [r.provider, r.unit])).toEqual([
        ["openai", "usd_cents"],
        ["github-copilot", "credits"],
      ]);
      // The credit export's run ids must not be picked as the dollar top run.
      const copilotSlice = out.cross_vendor.providers.find(
        (p) => p.provider === "github-copilot",
      );
      expect(copilotSlice).toMatchObject({ spend_cents: 0, share_pct: 0 });
    });

    it("never names a credit-only run as the dollar top run", () => {
      const out = buildProspectBillAudit({
        providers: [
          { provider: "openai", usage_csv: "cost\n50\n" },
          { provider: "github-copilot", usage_csv: COPILOT_CSV },
        ],
      });
      expect(out.lines.cap_blind_spot.largest_run_workflow_id).toBeNull();
      expect(out.lines.cap_blind_spot.status).toBe("account_level_only");
    });
  });
});

describe("buildProspectBillAudit options", () => {
  const csv = "cost,run_id\n10,r1\n";

  it("keeps the public endpoint's size limit by default", () => {
    const big = `cost,run_id\n${"1,r1\n".repeat(500_000)}`;
    expect(() =>
      buildProspectBillAudit({ providers: [{ provider: "openai", usage_csv: big }] }),
    ).toThrow(ProspectAuditValidationError);
  });

  it("lets a local caller lift the size limit", () => {
    const big = `cost,run_id\n${"1,r1\n".repeat(500_000)}`;
    const out = buildProspectBillAudit(
      { providers: [{ provider: "openai", usage_csv: big }] },
      { maxCsvChars: Number.POSITIVE_INFINITY },
    );
    expect(out.export_total_cents).toBe(50_000_000);
  });

  it("survives more distinct runs than fit in an argument list", () => {
    const rows = Array.from({ length: 300_000 }, (_, i) => `1,r${i}`);
    const out = buildProspectBillAudit(
      {
        providers: [
          { provider: "openai", usage_csv: `cost,run_id\n${rows.join("\n")}\n` },
        ],
      },
      { maxCsvChars: Number.POSITIVE_INFINITY },
    );
    expect(out.export_total_cents).toBe(30_000_000);
  });

  it("lets a local caller pass more than three exports", () => {
    const providers = ["a", "b", "c", "d"].map((provider) => ({
      provider,
      usage_csv: csv,
    }));
    expect(() => buildProspectBillAudit({ providers })).toThrow(
      ProspectAuditValidationError,
    );
    const out = buildProspectBillAudit(
      { providers },
      { maxProviders: Number.POSITIVE_INFINITY },
    );
    expect(out.cross_vendor.providers).toHaveLength(4);
  });

  it("says when the audit ran locally rather than as an upload", () => {
    const req = { providers: [{ provider: "openai", usage_csv: csv }] };
    expect(buildProspectBillAudit(req).source).toBe("prospect_upload");
    expect(buildProspectBillAudit(req, { source: "local_cli" }).source).toBe(
      "local_cli",
    );
  });
});

describe("buildProspectBillAudit people and tools", () => {
  const copilotHeader =
    "date,gross_amount,discount_amount,net_amount,username,cost_center_name,model";
  const copilot = `${copilotHeader}\n2026-10-01,30,10,20,dana,platform,gpt-5\n2026-10-01,10,0,10,lee,,gpt-5\n`;
  const cursor = JSON.stringify({
    usageEvents: [
      {
        userEmail: "dana",
        conversationId: "conv-big",
        chargedCents: 9000,
      },
      { userEmail: "lee", conversationId: "conv-small", chargedCents: 1000 },
      { userEmail: null, conversationId: null, chargedCents: 500 },
    ],
  });
  const claudeCode = JSON.stringify({
    data: [
      {
        actor: { type: "user_actor", email_address: "dana" },
        model_breakdown: [{ estimated_cost: { currency: "USD", amount: 4000 } }],
      },
    ],
  });

  it("counts spend tied to a person as owned, with or without a run id", () => {
    const out = buildProspectBillAudit({
      providers: [{ provider: "github_copilot", usage_csv: copilot }],
    });
    expect(out.lines.unowned_spend.unowned_cents).toBe(0);
    expect(out.lines.unowned_spend.instrumented_cents).toBe(3000);
  });

  it("still counts spend with neither a person nor a run as unowned", () => {
    const out = buildProspectBillAudit({
      providers: [{ provider: "cursor", usage_csv: cursor }],
    });
    expect(out.lines.unowned_spend.unowned_cents).toBe(500);
  });

  it("feeds Cursor conversations into the largest-run line", () => {
    const out = buildProspectBillAudit({
      providers: [{ provider: "cursor", usage_csv: cursor }],
    });
    expect(out.lines.cap_blind_spot.largest_run_workflow_id).toBe("conv-big");
    expect(out.lines.cap_blind_spot.largest_run_cost_cents).toBe(9000);
  });

  it("does not call a person-level export account-level", () => {
    const out = buildProspectBillAudit({
      providers: [{ provider: "github_copilot", usage_csv: copilot }],
    });
    expect(out.lines.cap_blind_spot.status).toBe("account_level_only");
    expect(out.lines.cap_blind_spot.note).toMatch(/by person/i);
  });

  it("totals spend by tool and by person across exports", () => {
    const out = buildProspectBillAudit({
      providers: [
        { provider: "github_copilot", usage_csv: copilot },
        { provider: "cursor", usage_csv: cursor },
        { provider: "claude_code", usage_csv: claudeCode },
      ],
    });
    expect(out.people_and_tools?.by_tool).toEqual([
      {
        tool: "Cursor",
        cost_basis: "billed",
        spend_cents: 10_500,
        gross_cents: null,
        people: 2,
        unowned_cents: 500,
      },
      {
        tool: "Claude Code",
        cost_basis: "estimated",
        spend_cents: 4000,
        gross_cents: null,
        people: 1,
        unowned_cents: 0,
      },
      {
        tool: "GitHub Copilot",
        cost_basis: "billed",
        spend_cents: 3000,
        gross_cents: 4000,
        people: 2,
        unowned_cents: 0,
      },
    ]);
    expect(out.people_and_tools?.by_person[0]).toEqual({
      person: "dana",
      total_cents: 15_000,
      tools: [
        { tool: "Cursor", spend_cents: 9000 },
        { tool: "Claude Code", spend_cents: 4000 },
        { tool: "GitHub Copilot", spend_cents: 2000 },
      ],
    });
  });

  it("leaves the section null for an ordinary export", () => {
    const out = buildProspectBillAudit({
      providers: [{ provider: "openai", usage_csv: "cost,run_id\n10,r1\n" }],
    });
    expect(out.people_and_tools).toBeNull();
  });

  it("does not propose a per-run ceiling from an export with no runs", () => {
    const out = buildProspectBillAudit({
      providers: [
        { provider: "github_copilot", usage_csv: copilot },
        { provider: "cursor", usage_csv: cursor },
      ],
    });
    expect(out.envelope_preview.map((e) => e.provider)).toEqual(["cursor"]);
  });

  it("flags an invoice compared against estimated figures", () => {
    const out = buildProspectBillAudit({
      providers: [
        {
          provider: "claude_code",
          usage_csv: claudeCode,
          invoice_total_usd: 50,
        },
      ],
    });
    expect(out.lines.price_paid_vs_list.note).toMatch(/estimated.*claude_code/i);
  });
});
