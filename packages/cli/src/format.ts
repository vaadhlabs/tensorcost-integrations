import type { CostEstimate } from "./pricing.js";

// ---------------------------------------------------------------------------
// Human-readable formatters
// ---------------------------------------------------------------------------

export function formatUsd(amount: number): string {
  // Show enough precision to be useful at the per-call level.
  // < $0.01 → 4 decimal places; otherwise 2.
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** Whole-report amounts, where thousands matter more than sub-cent precision. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  return `${sign}$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatPct(ratio: number): string {
  const pct = ratio * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export interface EstimateFormatOptions {
  callsPerDay?: number;
}

export function renderEstimate(
  est: CostEstimate,
  opts: EstimateFormatOptions = {},
): string {
  const lines: string[] = [
    `Estimated cost : ${formatUsd(est.totalCostUsd)} / call`,
    `Input tokens   : ${formatNumber(est.inputTokens)}`,
    `Output tokens  : ${formatNumber(est.outputTokens)}`,
  ];

  if (opts.callsPerDay !== undefined && opts.callsPerDay > 0) {
    const monthlyUsd = est.totalCostUsd * opts.callsPerDay * 30;
    lines.push(
      `At ${formatNumber(opts.callsPerDay)} calls/day: ${formatUsd(monthlyUsd)}/month`,
    );
  }

  return lines.join("\n");
}

export function renderCompare(
  baseline: CostEstimate,
  candidate: CostEstimate,
): string {
  const inputDelta =
    (candidate.inputTokens - baseline.inputTokens) / baseline.inputTokens;
  const costDelta =
    (candidate.totalCostUsd - baseline.totalCostUsd) / baseline.totalCostUsd;

  const absPct = (Math.abs(costDelta) * 100).toFixed(1) + "%";
  const verdict =
    Math.abs(costDelta) < 0.001
      ? "No meaningful cost difference."
      : costDelta > 0
        ? `candidate is ${absPct} more expensive per call.`
        : `candidate is ${absPct} cheaper per call.`;

  return [
    `baseline → candidate:`,
    `  Input tokens : ${formatNumber(baseline.inputTokens)} → ${formatNumber(candidate.inputTokens)}  (${formatPct(inputDelta)})`,
    `  Cost/call    : ${formatUsd(baseline.totalCostUsd)} → ${formatUsd(candidate.totalCostUsd)}  (${formatPct(costDelta)})`,
    `  Verdict      : ${verdict}`,
  ].join("\n");
}
