import type {
  AgentBillAuditEnvelopePreview,
  NativeCapKind,
} from "./types.js";

const NATIVE_CAP_BY_PROVIDER: Record<
  string,
  { kind: NativeCapKind; summary: string }
> = {
  openai: {
    kind: "monthly_period",
    summary: "Organization or project monthly hard limit (429 when exceeded).",
  },
  anthropic: {
    kind: "session_list_priced",
    summary:
      "Managed Agents session budget or Claude apps gateway period limit (list-priced).",
  },
  google: {
    kind: "monthly_period",
    summary: "AI Studio or Cloud Billing spend cap (often ~10 minute lag).",
  },
  vertex: {
    kind: "monthly_period",
    summary: "GCP billing budget / spend cap on the Vertex AI service.",
  },
  azure_openai: {
    kind: "monthly_period",
    summary: "Azure subscription or resource budget (period, not per-run).",
  },
  github: {
    kind: "credit_pool",
    summary: "Copilot / AI Credits pool (not dollars on the invoice).",
  },
  microsoft: {
    kind: "credit_pool",
    summary: "Copilot Studio Copilot Credits (actions and premium tokens).",
  },
};

function medianSorted(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function proposeRunCeilingUsdCents(
  runTotalsCents: number[],
  largestRunCents: number,
): number {
  const floor = 500;
  if (largestRunCents <= 0) {
    return floor;
  }
  const sorted = runTotalsCents.filter((r) => r > 0).sort((a, b) => a - b);
  const trimmed =
    sorted.length > 1 ? sorted.slice(0, sorted.length - 1) : sorted;
  const typical = medianSorted(trimmed);
  let proposed = Math.max(floor, typical || Math.round(largestRunCents * 0.25));
  if (proposed >= largestRunCents) {
    proposed = Math.max(floor, largestRunCents - 100);
  }
  return proposed;
}

export function proposeRunCeilingCredits(
  runCreditTotals: number[],
  largestRunCredits: number,
): number {
  const floor = 10;
  if (largestRunCredits <= 0) {
    return floor;
  }
  const sorted = runCreditTotals.filter((r) => r > 0).sort((a, b) => a - b);
  const trimmed =
    sorted.length > 1 ? sorted.slice(0, sorted.length - 1) : sorted;
  const typical = medianSorted(trimmed);
  let proposed = Math.max(
    floor,
    typical || Math.max(floor, Math.round(largestRunCredits * 0.25)),
  );
  if (proposed >= largestRunCredits) {
    proposed = Math.max(floor, largestRunCredits - 1);
  }
  return proposed;
}

export function buildEnvelopePreview(input: {
  provider: string;
  largest_run_cents: number;
  unowned_cents: number;
  run_totals_cents: number[];
  credit_pool_label?: string;
  credit_denominated?: boolean;
  run_credit_totals?: number[];
  largest_run_credits?: number;
  unowned_credits?: number;
}): AgentBillAuditEnvelopePreview {
  const key = input.provider.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const meta =
    NATIVE_CAP_BY_PROVIDER[key] ??
    (input.credit_pool_label || input.credit_denominated
      ? {
          kind: "credit_pool" as NativeCapKind,
          summary: input.credit_pool_label
            ? `Credit pool (${input.credit_pool_label}).`
            : "Credit pool (quantity column in export).",
        }
      : {
          kind: "unknown" as NativeCapKind,
          summary: "Native cap type not mapped — verify in vendor admin.",
        });

  const useCredits =
    meta.kind === "credit_pool" ||
    Boolean(input.credit_denominated || input.credit_pool_label);

  if (useCredits) {
    const largestCr = input.largest_run_credits ?? 0;
    const proposedAmount = proposeRunCeilingCredits(
      input.run_credit_totals ?? [],
      largestCr,
    );
    return {
      provider: input.provider,
      native_cap_kind: meta.kind,
      native_cap_summary: meta.summary,
      spend_native_cap_would_miss_cents: input.largest_run_cents,
      unowned_spend_cents: input.unowned_cents,
      largest_run_credits: largestCr,
      unowned_credits: input.unowned_credits ?? 0,
      proposed_envelope: {
        unit: "credits",
        amount: proposedAmount,
        scope_label: "Per engineer or agent run (not applied — preview only)",
      },
      applied: false,
      note: "Envelope is computed from your export only. We do not write to vendor admin APIs until you ask on a paid pilot.",
    };
  }

  const largestRun = input.largest_run_cents;
  const proposedAmount = proposeRunCeilingUsdCents(
    input.run_totals_cents,
    largestRun,
  );

  return {
    provider: input.provider,
    native_cap_kind: meta.kind,
    native_cap_summary: meta.summary,
    spend_native_cap_would_miss_cents: largestRun,
    unowned_spend_cents: input.unowned_cents,
    proposed_envelope: {
      unit: "usd_cents",
      amount: proposedAmount,
      scope_label: "Per engineer or agent run (not applied — preview only)",
    },
    applied: false,
    note: "Envelope is computed from your export only. We do not write to vendor admin APIs until you ask on a paid pilot.",
  };
}
