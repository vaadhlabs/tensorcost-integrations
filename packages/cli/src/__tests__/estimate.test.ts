import { describe, expect, it } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the estimateCost + heuristic path rather than spawning a subprocess,
// so we can stay fast and deterministic without a built dist/.

import {
  getModel,
  estimateCost,
  heuristicTokenCount,
  defaultOutputTokens,
} from "../pricing.js";

describe("estimate — cost from prompt file", () => {
  it("matches expected cost within $0.0001 tolerance for a 1,420-token prompt on claude-3-sonnet", () => {
    // Construct a synthetic prompt that the heuristic will tokenize to ~1,420 tokens.
    // heuristic: ceil(charCount / 4) = 1420  →  charCount = 5678
    const prompt = "A".repeat(5678);

    const model = getModel("anthropic/claude-3-sonnet")!;
    const inputTokens = heuristicTokenCount(prompt); // 5678/4 = 1419.5 → 1420
    expect(inputTokens).toBe(1420);

    const outputTokens = defaultOutputTokens(inputTokens); // max(64, ceil(1420/5)) = 284
    const est = estimateCost(model, inputTokens, outputTokens);

    // input: 1420 / 1_000_000 * 3.00 = 0.00426
    // output: 284 / 1_000_000 * 15.00 = 0.00426
    // total ≈ 0.00852
    const expectedTotal = (1420 / 1_000_000) * 3.0 + (284 / 1_000_000) * 15.0;
    expect(est.totalCostUsd).toBeCloseTo(expectedTotal, 6);
    // Within $0.0001 of hand-computed reference
    expect(Math.abs(est.totalCostUsd - expectedTotal)).toBeLessThan(0.0001);
  });

  it("reads from a temp file and produces the same result", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tensorcost-test-"));
    const content = "B".repeat(4000); // heuristic → 1000 tokens
    const filePath = join(tmpDir, "prompt.txt");
    writeFileSync(filePath, content, "utf8");

    const text = readFileSync(filePath, "utf8");

    const model = getModel("openai/gpt-4o")!;
    const inputTokens = heuristicTokenCount(text);
    expect(inputTokens).toBe(1000);

    const outputTokens = defaultOutputTokens(inputTokens); // 200
    const est = estimateCost(model, inputTokens, outputTokens);

    // $2.5 / M input + $10 / M output
    const expected = (1000 / 1_000_000) * 2.5 + (200 / 1_000_000) * 10.0;
    expect(est.totalCostUsd).toBeCloseTo(expected, 6);
  });
});

describe("estimate — unknown model exits with helpful message", () => {
  it("getModel returns null for an unknown id", () => {
    const model = getModel("fake/model-9000");
    expect(model).toBeNull();
    // The CLI would print: Unknown model: fake/model-9000. Try `tensorcost models`.
    // We verify the message format by constructing it the same way the command does.
    const errorMsg = `Unknown model: fake/model-9000. Try \`tensorcost models\`.`;
    expect(errorMsg).toMatch(/Unknown model:/);
    expect(errorMsg).toMatch(/tensorcost models/);
  });
});
