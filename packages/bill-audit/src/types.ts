/**
 * Wire shapes for the bill audit. No runtime dependencies, because this package
 * is bundled into the published CLI as well as used by TensorCost's own
 * services.
 */

export const AGENT_BILL_AUDIT_LINE_STATUSES = [
  "computed",
  "estimated",
  "insufficient_data",
  "requires_outcome_feed",
  "account_level_only",
] as const;

export type AgentBillAuditLineStatus =
  (typeof AGENT_BILL_AUDIT_LINE_STATUSES)[number];

export interface AgentBillAuditCapBlindSpot {
  status: AgentBillAuditLineStatus;
  largest_run_workflow_id: string | null;
  largest_run_cost_cents: number;
  largest_run_share_pct: number;
  list_vs_effective_gap_cents: number | null;
  native_cap_would_miss: boolean;
  note?: string;
}

export interface AgentBillAuditUnownedSpend {
  status: AgentBillAuditLineStatus;
  unowned_cents: number;
  unowned_pct: number;
  instrumented_cents: number;
}

export interface AgentBillAuditPricePaid {
  status: AgentBillAuditLineStatus;
  effective_cents: number;
  list_estimate_cents: number;
  gap_cents: number;
  credit_pools: "not_applicable" | "noted_in_export" | "unsupported";
  note?: string;
}

export interface AgentBillAuditCapitalisation {
  status: AgentBillAuditLineStatus;
  tagged_cents: number;
  capitalisation_eligible_share_pct: number;
  disclaimer: string;
}

export interface AgentBillAuditSellerMargin {
  status: AgentBillAuditLineStatus;
  cost_per_attempt_by_agent: Array<{
    agent_id: string;
    attempt_count: number;
    total_cost_cents: number;
  }>;
  note?: string;
}

export interface AgentBillAuditProviderSlice {
  provider: string;
  spend_cents: number;
  share_pct: number;
}

export interface AgentBillAuditCacheMeta {
  /** True when served from Redis; false on a fresh compute. */
  hit: boolean;
  ttl_seconds: number;
}

export interface AgentBillAuditResponse {
  window_days: number;
  generated_at: string;
  /** Present on API responses; omitted from the Redis payload. */
  cache?: AgentBillAuditCacheMeta;
  lines: {
    cap_blind_spot: AgentBillAuditCapBlindSpot;
    unowned_spend: AgentBillAuditUnownedSpend;
    price_paid_vs_list: AgentBillAuditPricePaid;
    capitalisation_estimate: AgentBillAuditCapitalisation;
    seller_margin: AgentBillAuditSellerMargin;
  };
  cross_vendor: {
    providers: AgentBillAuditProviderSlice[];
  };
  sdk_workflow_coverage_pct: number;
}

export type NativeCapKind =
  | "monthly_period"
  | "session_list_priced"
  | "credit_pool"
  | "unknown";

export interface AgentBillAuditEnvelopePreview {
  provider: string;
  native_cap_kind: NativeCapKind;
  native_cap_summary: string;
  /** Largest single run in USD (period caps miss run grain, not unowned totals). */
  spend_native_cap_would_miss_cents: number;
  unowned_spend_cents: number;
  /** Credit exports only: the same two figures in the export's own unit. */
  largest_run_credits?: number;
  unowned_credits?: number;
  proposed_envelope: {
    unit: "usd_cents" | "credits";
    amount: number;
    scope_label: string;
  };
  applied: false;
  note: string;
}

export interface AgentBillAuditProspectProviderInput {
  provider: string;
  usage_csv: string;
  /** Invoice total for the same window, in USD (optional). */
  invoice_total_usd?: number;
  /** When the export is credit-denominated (Copilot, Flex, GitHub). */
  credit_pool_label?: string;
}

export interface AgentBillAuditProspectRequest {
  window_days?: number;
  providers: AgentBillAuditProspectProviderInput[];
}

export type ProspectPriceBasis = "invoice_vs_export";

/** Unit the headline lines (largest run, unowned, tagged) are measured in. */
export type ProspectHeadlineUnit = "usd_cents" | "credits";

/** One entry per uploaded export; `gap_cents` is export minus invoice. */
export interface AgentBillAuditProspectReconciliation {
  provider: string;
  unit: ProspectHeadlineUnit;
  /** Null when the prospect did not supply an invoice for this export. */
  invoice_cents: number | null;
  /** USD sum of the export; 0 for a credit-denominated export. */
  export_cents: number;
  /** Credit sum of the export; null for a USD export. */
  export_credits: number | null;
  /** Null unless a USD invoice and a USD export can be compared. */
  gap_cents: number | null;
}

/** Credit-denominated exports only, never blended with the USD figures. */
export interface AgentBillAuditProspectCreditHeadline {
  providers: string[];
  instrumented_credits: number;
  unowned_credits: number;
  largest_run_workflow_id: string | null;
  largest_run_credits: number;
  largest_run_share_pct: number;
  native_cap_would_miss: boolean;
  tagged_credits: number;
  tagged_share_pct: number;
}

/** Which vendor's export a file turned out to be. */
export type UsageExportFormat =
  | "generic"
  | "cursor"
  | "github_copilot"
  | "claude_code";

/** `billed` came from the vendor's charges; `estimated` from tokens at list price. */
export type UsageCostBasis = "billed" | "estimated";

export interface AgentBillAuditToolSlice {
  tool: string;
  cost_basis: UsageCostBasis;
  spend_cents: number;
  /** Before discounts and included usage. Null when the export has no such figure. */
  gross_cents: number | null;
  people: number;
  unowned_cents: number;
}

export interface AgentBillAuditPersonSlice {
  person: string;
  total_cents: number;
  tools: Array<{ tool: string; spend_cents: number }>;
}

/** Spend from exports that name people, largest first. */
export interface AgentBillAuditPeopleAndTools {
  by_tool: AgentBillAuditToolSlice[];
  by_person: AgentBillAuditPersonSlice[];
}

export interface AgentBillAuditProspectResponse extends AgentBillAuditResponse {
  /** `local_cli` means the audit ran on the caller's machine; nothing was uploaded. */
  source: "prospect_upload" | "local_cli";
  price_basis: ProspectPriceBasis;
  /** Sum of usage-export USD across every provider, invoiced or not. */
  export_total_cents: number;
  /**
   * Invoices summed over the providers that were actually compared (USD
   * export plus a USD invoice). Null when nothing was reconciled.
   * `lines.price_paid_vs_list` is computed over the same set, so it matches
   * `export_total_cents` only when every provider is reconciled.
   */
  invoice_reconciled_cents: number | null;
  /**
   * `credits` only when every export is credit-denominated; the run share,
   * unowned and tagged lines are then credit percentages. Any USD export
   * keeps them in USD over the USD exports alone.
   */
  headline_unit: ProspectHeadlineUnit;
  reconciliation: AgentBillAuditProspectReconciliation[];
  /** Present whenever at least one export is credit-denominated. */
  credit_headline: AgentBillAuditProspectCreditHeadline | null;
  instrumented_credits: number | null;
  unowned_credits: number | null;
  envelope_preview: AgentBillAuditEnvelopePreview[];
  /** Null unless at least one export names people. */
  people_and_tools: AgentBillAuditPeopleAndTools | null;
}
