import { describe, expect, it } from "vitest";
import {
  buildEnvelopePreview,
  proposeRunCeilingUsdCents,
} from "./prospect-envelope.js";

describe("proposeRunCeilingUsdCents", () => {
  it("stays below the largest run", () => {
    const largest = 42_800;
    const proposed = proposeRunCeilingUsdCents(
      [5000, 6000, 7000, largest],
      largest,
    );
    expect(proposed).toBeLessThan(largest);
    expect(proposed).toBeGreaterThanOrEqual(500);
  });
});

describe("buildEnvelopePreview", () => {
  it("proposed envelope is below spend_native_cap_would_miss", () => {
    const env = buildEnvelopePreview({
      provider: "openai",
      largest_run_cents: 20_000,
      unowned_cents: 50_000,
      run_totals_cents: [2000, 3000, 20_000],
    });
    expect(env.proposed_envelope.unit).toBe("usd_cents");
    expect(env.spend_native_cap_would_miss_cents).toBe(20_000);
    expect(env.unowned_spend_cents).toBe(50_000);
    expect(env.proposed_envelope.amount).toBeLessThan(20_000);
  });

  it("reports the credit export's run and unowned figures in credits", () => {
    const env = buildEnvelopePreview({
      provider: "github-copilot",
      largest_run_cents: 0,
      unowned_cents: 0,
      run_totals_cents: [],
      credit_denominated: true,
      run_credit_totals: [120, 500],
      largest_run_credits: 500,
      unowned_credits: 30,
    });
    expect(env.proposed_envelope.unit).toBe("credits");
    expect(env.largest_run_credits).toBe(500);
    expect(env.unowned_credits).toBe(30);
    expect(env.proposed_envelope.amount).toBeLessThan(500);
  });
});
