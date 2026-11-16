import { describe, expect, it } from "vitest";
import { renderEstimate, renderCompare, formatUsd, formatPct } from "../format.js";
import { getModel, estimateCost } from "../pricing.js";

describe("formatUsd", () => {
  it("shows 4 decimal places for amounts under $0.01", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.0038)).toBe("$0.0038");
  });

  it("shows 2 decimal places for amounts $0.01 and above", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(42)).toBe("$42.00");
  });
});

describe("formatPct", () => {
  it("includes a + sign for positive values", () => {
    expect(formatPct(0.105)).toBe("+10.5%");
  });

  it("omits the + sign for negative values", () => {
    expect(formatPct(-0.05)).toBe("-5.0%");
  });
});

describe("renderEstimate", () => {
  it("includes cost, input tokens, and output tokens", () => {
    const model = getModel("anthropic/claude-3-sonnet")!;
    const est = estimateCost(model, 1420, 284);
    const out = renderEstimate(est);
    expect(out).toContain("Estimated cost");
    expect(out).toContain("1,420");
    expect(out).toContain("284");
  });

  it("includes monthly projection when callsPerDay is set", () => {
    const model = getModel("anthropic/claude-3-sonnet")!;
    const est = estimateCost(model, 1420, 284);
    const out = renderEstimate(est, { callsPerDay: 1000 });
    expect(out).toContain("1,000 calls/day");
    expect(out).toContain("/month");
  });

  it("omits monthly projection when callsPerDay is not set", () => {
    const model = getModel("anthropic/claude-3-sonnet")!;
    const est = estimateCost(model, 1420, 284);
    const out = renderEstimate(est);
    expect(out).not.toContain("/month");
  });
});

describe("renderCompare", () => {
  it("contains baseline → candidate wording and a Verdict line", () => {
    const model = getModel("anthropic/claude-3-sonnet")!;
    const baseline = estimateCost(model, 1280, 256);
    const candidate = estimateCost(model, 1420, 284);
    const out = renderCompare(baseline, candidate);
    expect(out).toContain("baseline → candidate");
    expect(out).toContain("Verdict");
    expect(out).toContain("1,280");
    expect(out).toContain("1,420");
  });

  it("reports 'cheaper' when candidate costs less", () => {
    const model = getModel("openai/gpt-4o")!;
    const baseline = estimateCost(model, 2000, 400);
    const candidate = estimateCost(model, 1000, 200);
    const out = renderCompare(baseline, candidate);
    expect(out).toContain("cheaper");
  });

  it("reports 'more expensive' when candidate costs more", () => {
    const model = getModel("openai/gpt-4o")!;
    const baseline = estimateCost(model, 1000, 200);
    const candidate = estimateCost(model, 2000, 400);
    const out = renderCompare(baseline, candidate);
    expect(out).toContain("more expensive");
  });
});
