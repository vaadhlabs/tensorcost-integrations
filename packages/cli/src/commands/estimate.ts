import { readFileSync } from "fs";
import {
  resolveModel,
  countTokens,
  defaultOutputTokens,
  estimateCost,
  type ModelPricing,
} from "../pricing.js";
import { modelsForProvider } from "../model-catalog.js";
import { formatUsd, formatNumber, renderEstimate } from "../format.js";
import type { CostEstimate } from "../pricing.js";

export interface EstimateArgs {
  prompt?: string;
  promptFile?: string;
  model?: string;
  provider?: string;
  includeLegacy?: boolean;
  tier?: "latest";
  expectedOutputTokens?: number;
  callsPerDay?: number;
  json: boolean;
}

function writeUnknownModel(requested: string, candidates?: string[]): never {
  if (candidates && candidates.length > 0) {
    process.stderr.write(
      `Ambiguous model: ${requested}. Matches:\n` +
        candidates.map((c) => `  ${c}`).join("\n") +
        `\nPass a full id (provider/model).\n`,
    );
  } else {
    process.stderr.write(
      `Unknown model: ${requested}. Try \`tensorcost models\`.\n`,
    );
  }
  process.exit(1);
}

export async function runEstimate(args: EstimateArgs): Promise<void> {
  const text = resolveText(args.prompt, args.promptFile, "estimate");
  const inputTokens = await countTokens(text);
  const outputTokens =
    args.expectedOutputTokens ?? defaultOutputTokens(inputTokens);

  const modelId = args.model?.trim();
  const provider = args.provider?.trim();

  if (modelId) {
    await runSingleModelEstimate({
      modelId,
      inputTokens,
      outputTokens,
      callsPerDay: args.callsPerDay,
      json: args.json,
    });
    return;
  }

  if (provider) {
    await runProviderEstimate({
      provider,
      inputTokens,
      outputTokens,
      callsPerDay: args.callsPerDay,
      includeLegacy: args.includeLegacy,
      tier: args.tier,
      json: args.json,
    });
    return;
  }

  process.stderr.write(
    "tensorcost estimate: provide --model <id> or --provider <name>.\n",
  );
  process.exit(1);
}

async function runSingleModelEstimate(opts: {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  callsPerDay?: number;
  json: boolean;
}): Promise<void> {
  const resolved = resolveModel(opts.modelId);
  if (resolved.kind === "not_found") {
    writeUnknownModel(opts.modelId);
  }
  if (resolved.kind === "ambiguous") {
    writeUnknownModel(opts.modelId, resolved.candidates);
  }
  const model = resolved.model;

  const est = estimateCost(model, opts.inputTokens, opts.outputTokens);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        buildEstimateJson(model.id, est, opts.callsPerDay),
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      renderEstimate(est, { callsPerDay: opts.callsPerDay }) + "\n",
    );
  }
}

async function runProviderEstimate(opts: {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  callsPerDay?: number;
  includeLegacy?: boolean;
  tier?: "latest";
  json: boolean;
}): Promise<void> {
  const models = modelsForProvider(opts.provider, {
    includeLegacy: opts.includeLegacy,
    tier: opts.tier,
  });
  if (models.length === 0) {
    process.stderr.write(
      `No models found for provider '${opts.provider}'.\n`,
    );
    process.exit(1);
  }

  const rows = models
    .map((model) => ({
      model,
      est: estimateCost(model, opts.inputTokens, opts.outputTokens),
    }))
    .sort((a, b) => a.est.totalCostUsd - b.est.totalCostUsd);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          provider: opts.provider,
          inputTokens: opts.inputTokens,
          outputTokens: opts.outputTokens,
          ...(opts.callsPerDay !== undefined
            ? { callsPerDay: opts.callsPerDay }
            : {}),
          estimates: rows.map(({ model, est }) =>
            buildEstimateJson(model.id, est, opts.callsPerDay),
          ),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write(
    renderProviderEstimateTable(rows, opts.inputTokens, opts.outputTokens, {
      provider: opts.provider,
      callsPerDay: opts.callsPerDay,
    }) + "\n",
  );
}

function buildEstimateJson(
  modelId: string,
  est: CostEstimate,
  callsPerDay?: number,
) {
  return {
    model: modelId,
    inputTokens: est.inputTokens,
    outputTokens: est.outputTokens,
    inputCostUsd: est.inputCostUsd,
    outputCostUsd: est.outputCostUsd,
    totalCostUsd: est.totalCostUsd,
    ...(callsPerDay !== undefined
      ? {
          callsPerDay,
          monthlyUsd: est.totalCostUsd * callsPerDay * 30,
        }
      : {}),
  };
}

function renderProviderEstimateTable(
  rows: Array<{ model: ModelPricing; est: CostEstimate }>,
  inputTokens: number,
  outputTokens: number,
  meta: { provider: string; callsPerDay?: number },
): string {
  const idWidth = Math.max(...rows.map((r) => r.model.id.length), 5);
  const monthly = meta.callsPerDay !== undefined && meta.callsPerDay > 0;
  const header = monthly
    ? `${"MODEL".padEnd(idWidth)}  ${"COST/CALL".padStart(12)}  ${"MONTHLY".padStart(12)}`
    : `${"MODEL".padEnd(idWidth)}  ${"COST/CALL".padStart(12)}`;
  const sep = "-".repeat(header.length);
  const intro = [
    `Provider: ${meta.provider}`,
    `Prompt tokens: ${formatNumber(inputTokens)} in / ${formatNumber(outputTokens)} out (estimated)`,
    ...(monthly
      ? [`At ${formatNumber(meta.callsPerDay!)} calls/day:`]
      : []),
    "",
    header,
    sep,
  ];

  const body = rows.map(({ model, est }) => {
    const cols = [
      model.id.padEnd(idWidth),
      formatUsd(est.totalCostUsd).padStart(12),
    ];
    if (monthly) {
      cols.push(
        formatUsd(est.totalCostUsd * meta.callsPerDay! * 30).padStart(12),
      );
    }
    return cols.join("  ");
  });

  return [...intro, ...body].join("\n");
}

export function resolveText(
  inline: string | undefined,
  filePath: string | undefined,
  subcommand: string,
): string {
  if (inline !== undefined) return inline;
  if (filePath !== undefined) {
    try {
      return readFileSync(filePath, "utf8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `tensorcost ${subcommand}: cannot read file '${filePath}': ${msg}\n`,
      );
      process.exit(1);
    }
  }
  process.stderr.write(
    `tensorcost ${subcommand}: provide --prompt or --prompt-file.\n`,
  );
  process.exit(1);
}
