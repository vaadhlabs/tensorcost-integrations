import { describe, expect, it } from "vitest";
import { buildProspectBillAudit } from "./prospect-audit.builder.js";
import {
  TRUST_SAMPLE_ANTHROPIC_CSV,
  TRUST_SAMPLE_OPENAI_CSV,
} from "./trust-sample.fixtures.js";

describe("prospect audit golden (trust sample)", () => {
  it("builds two-vendor audit with envelopes below missed spend", () => {
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

    expect(out.cross_vendor.providers).toHaveLength(2);
    expect(out.lines.cap_blind_spot.native_cap_would_miss).toBe(true);
    for (const env of out.envelope_preview) {
      if (env.proposed_envelope.unit === "usd_cents") {
        expect(env.proposed_envelope.amount).toBeLessThan(
          env.spend_native_cap_would_miss_cents,
        );
      }
    }
    expect(out.lines.price_paid_vs_list.note).toContain("not catalog list");
  });
});
