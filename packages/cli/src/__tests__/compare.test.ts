import { describe, expect, it } from "vitest";
import {
  getModel,
  estimateCost,
  heuristicTokenCount,
  defaultOutputTokens,
} from "../pricing.js";

describe("compare — pct delta calculation", () => {
  it("reports the correct percentage difference between baseline and candidate", () => {
    const model = getModel("anthropic/claude-3-sonnet")!;

    // baseline: 1280 input chars * 4 ≈ 320 tokens; candidate: 1420 tokens
    const baselineText = "C".repeat(5120); // 5120/4 = 1280 tokens
    const candidateText = "C".repeat(5680); // 5680/4 = 1420 tokens

    const baselineInput = heuristicTokenCount(baselineText);
    const candidateInput = heuristicTokenCount(candidateText);

    expect(baselineInput).toBe(1280);
    expect(candidateInput).toBe(1420);

    const baselineOutput = defaultOutputTokens(baselineInput); // max(64, 256) = 256
    const candidateOutput = defaultOutputTokens(candidateInput); // max(64, 284) = 284

    const baselineEst = estimateCost(model, baselineInput, baselineOutput);
    const candidateEst = estimateCost(model, candidateInput, candidateOutput);

    const inputDelta =
      (candidateInput - baselineInput) / baselineInput;
    const costDelta =
      (candidateEst.totalCostUsd - baselineEst.totalCostUsd) /
      baselineEst.totalCostUsd;

    // Input went up by 140/1280 ≈ 10.94%
    expect(inputDelta).toBeCloseTo(0.109375, 4);
    // Cost also went up — verify it's positive and in a similar ballpark
    expect(costDelta).toBeGreaterThan(0.09);
    expect(costDelta).toBeLessThan(0.13);
  });

  it("reports zero delta when baseline === candidate", () => {
    const model = getModel("openai/gpt-4o")!;
    const text = "D".repeat(4000);
    const tokens = heuristicTokenCount(text);
    const outputTokens = defaultOutputTokens(tokens);

    const est = estimateCost(model, tokens, outputTokens);
    const costDelta =
      (est.totalCostUsd - est.totalCostUsd) / est.totalCostUsd;

    expect(costDelta).toBe(0);
  });
});

describe("compare — JSON output round-trips", () => {
  it("produces valid JSON with the expected shape", () => {
    const model = getModel("openai/gpt-4o")!;

    const baselineInput = 500;
    const candidateInput = 600;
    const baselineOutput = defaultOutputTokens(baselineInput);
    const candidateOutput = defaultOutputTokens(candidateInput);

    const baselineEst = estimateCost(model, baselineInput, baselineOutput);
    const candidateEst = estimateCost(model, candidateInput, candidateOutput);

    const inputDelta =
      (candidateInput - baselineInput) / Math.max(baselineInput, 1);
    const costDelta =
      (candidateEst.totalCostUsd - baselineEst.totalCostUsd) /
      Math.max(baselineEst.totalCostUsd, 1e-12);

    const out = {
      model: model.id,
      baseline: {
        inputTokens: baselineEst.inputTokens,
        outputTokens: baselineEst.outputTokens,
        totalCostUsd: baselineEst.totalCostUsd,
      },
      candidate: {
        inputTokens: candidateEst.inputTokens,
        outputTokens: candidateEst.outputTokens,
        totalCostUsd: candidateEst.totalCostUsd,
      },
      inputTokensDelta: inputDelta,
      costDelta: costDelta,
    };

    const json = JSON.stringify(out, null, 2);
    const parsed = JSON.parse(json) as typeof out;

    expect(parsed.model).toBe("openai/gpt-4o");
    expect(parsed.baseline.inputTokens).toBe(500);
    expect(parsed.candidate.inputTokens).toBe(600);
    expect(typeof parsed.costDelta).toBe("number");
    expect(typeof parsed.inputTokensDelta).toBe("number");
  });
});
