import {
  resolveModel,
  countTokens,
  defaultOutputTokens,
  estimateCost,
} from "../pricing.js";
import { renderCompare } from "../format.js";
import { resolveText } from "./estimate.js";

export interface CompareArgs {
  baseline?: string;
  baselineFile?: string;
  candidate?: string;
  candidateFile?: string;
  model: string;
  expectedOutputTokens?: number;
  json: boolean;
}

export async function runCompare(args: CompareArgs): Promise<void> {
  const baselineText = resolveText(
    args.baseline,
    args.baselineFile,
    "compare (--baseline / --baseline-file)",
  );
  const candidateText = resolveText(
    args.candidate,
    args.candidateFile,
    "compare (--candidate / --candidate-file)",
  );

  const resolved = resolveModel(args.model);
  if (resolved.kind === "not_found") {
    process.stderr.write(
      `Unknown model: ${args.model}. Try \`tensorcost models\`.\n`,
    );
    process.exit(1);
  }
  if (resolved.kind === "ambiguous") {
    process.stderr.write(
      `Ambiguous model: ${args.model}. Matches:\n` +
        resolved.candidates.map((c) => `  ${c}`).join("\n") +
        `\nPass a full id (provider/model).\n`,
    );
    process.exit(1);
  }
  const model = resolved.model;

  const [baselineInput, candidateInput] = await Promise.all([
    countTokens(baselineText),
    countTokens(candidateText),
  ]);

  const baselineOutput =
    args.expectedOutputTokens ?? defaultOutputTokens(baselineInput);
  const candidateOutput =
    args.expectedOutputTokens ?? defaultOutputTokens(candidateInput);

  const baselineEst = estimateCost(model, baselineInput, baselineOutput);
  const candidateEst = estimateCost(model, candidateInput, candidateOutput);

  if (args.json) {
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
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write(renderCompare(baselineEst, candidateEst) + "\n");
  }
}
