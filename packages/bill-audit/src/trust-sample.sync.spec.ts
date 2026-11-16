import { describe, expect, it } from "vitest";
import { buildProspectBillAudit } from "./prospect-audit.builder.js";
import {
  TRUST_SAMPLE_ANTHROPIC_CSV,
  TRUST_SAMPLE_OPENAI_CSV,
} from "./trust-sample.fixtures.js";

/** Numeric snapshot — keep in sync with frontend `bill-audit-sample.ts`. */
const EXPECTED = {
  invoice_reconciled_cents: 184_200,
  export_total_cents: 127_750,
  sdk_workflow_coverage_pct: 51.2,
  cap_largest_run_cost_cents: 42_800,
  cap_largest_run_share_pct: 33.5,
  unowned_cents: 62_400,
  unowned_pct: 48.8,
  instrumented_cents: 127_750,
  effective_cents: 184_200,
  gap_cents: -56_450,
  openai_spend: 76_350,
  anthropic_spend: 51_400,
  envelope_openai_miss: 42_800,
  envelope_openai_proposed: 2350,
  envelope_anthropic_miss: 18_000,
  envelope_anthropic_proposed: 2200,
  gap_openai: -35_950,
  gap_anthropic: -20_500,
};

describe("trust sample sync", () => {
  it("matches frontend bill-audit-sample numbers", () => {
    const out = buildProspectBillAudit({
      window_days: 90,
      providers: [
        {
          provider: "openai",
          usage_csv: TRUST_SAMPLE_OPENAI_CSV,
          invoice_total_usd: 1123,
        },
        {
          provider: "anthropic",
          usage_csv: TRUST_SAMPLE_ANTHROPIC_CSV,
          invoice_total_usd: 719,
        },
      ],
    });

    expect(out.export_total_cents).toBe(EXPECTED.export_total_cents);
    expect(out.invoice_reconciled_cents).toBe(EXPECTED.invoice_reconciled_cents);
    expect(out.sdk_workflow_coverage_pct).toBe(EXPECTED.sdk_workflow_coverage_pct);
    expect(out.lines.cap_blind_spot.largest_run_cost_cents).toBe(
      EXPECTED.cap_largest_run_cost_cents,
    );
    expect(out.lines.cap_blind_spot.largest_run_share_pct).toBe(
      EXPECTED.cap_largest_run_share_pct,
    );
    expect(out.lines.unowned_spend).toMatchObject({
      unowned_cents: EXPECTED.unowned_cents,
      unowned_pct: EXPECTED.unowned_pct,
      instrumented_cents: EXPECTED.instrumented_cents,
    });
    expect(out.lines.price_paid_vs_list).toMatchObject({
      effective_cents: EXPECTED.effective_cents,
      gap_cents: EXPECTED.gap_cents,
    });
    expect(out.price_basis).toBe("invoice_vs_export");
    expect(out.headline_unit).toBe("usd_cents");
    expect(out.credit_headline).toBeNull();
    expect(out.reconciliation).toEqual([
      {
        provider: "openai",
        unit: "usd_cents",
        invoice_cents: 112_300,
        export_cents: EXPECTED.openai_spend,
        export_credits: null,
        gap_cents: EXPECTED.gap_openai,
      },
      {
        provider: "anthropic",
        unit: "usd_cents",
        invoice_cents: 71_900,
        export_cents: EXPECTED.anthropic_spend,
        export_credits: null,
        gap_cents: EXPECTED.gap_anthropic,
      },
    ]);

    const openai = out.envelope_preview.find((e) => e.provider === "openai");
    const anthropic = out.envelope_preview.find((e) => e.provider === "anthropic");
    expect(openai?.spend_native_cap_would_miss_cents).toBe(
      EXPECTED.envelope_openai_miss,
    );
    expect(openai?.proposed_envelope.amount).toBe(
      EXPECTED.envelope_openai_proposed,
    );
    expect(anthropic?.spend_native_cap_would_miss_cents).toBe(
      EXPECTED.envelope_anthropic_miss,
    );
    expect(anthropic?.proposed_envelope.amount).toBe(
      EXPECTED.envelope_anthropic_proposed,
    );
  });
});
