import type { AgentBillAuditLineStatus } from "./types.js";
import type {
  AgentBillAuditPeopleAndTools,
  AgentBillAuditProspectCreditHeadline,
  AgentBillAuditProspectReconciliation,
  AgentBillAuditProspectRequest,
  AgentBillAuditProspectResponse,
  AgentBillAuditToolSlice,
} from "./types.js";
import {
  ProspectCsvParseError,
  type ProspectUsageRow,
} from "./prospect-csv.js";
import { buildEnvelopePreview } from "./prospect-envelope.js";
import { parseUsageExport } from "./usage-export.js";

const CAPITALISATION_DISCLAIMER =
  "Estimate of spend that could carry project or cost-centre tags for internal-use-software records. Not tax or accounting advice.";

const MAX_CSV_CHARS = 2_000_000;
const MAX_PROVIDERS = 3;

interface WorkflowAgg {
  workflow_id: string;
  /** USD cents or credits, depending on which map it came from. */
  total: number;
}

export interface BuildBillAuditOptions {
  /** The defaults guard the public endpoint; a local run has no reason to apply them. */
  maxCsvChars?: number;
  maxProviders?: number;
  source?: AgentBillAuditProspectResponse["source"];
}

export function buildProspectBillAudit(
  req: AgentBillAuditProspectRequest,
  options: BuildBillAuditOptions = {},
): AgentBillAuditProspectResponse {
  const maxCsvChars = options.maxCsvChars ?? MAX_CSV_CHARS;
  const maxProviders = options.maxProviders ?? MAX_PROVIDERS;

  if (!req.providers?.length) {
    throw new ProspectAuditValidationError("At least one provider export is required.");
  }
  if (req.providers.length > maxProviders) {
    throw new ProspectAuditValidationError(
      `At most ${maxProviders} provider exports per request.`,
    );
  }

  const windowDays = clampWindow(req.window_days ?? 90);
  // USD figures cover USD-denominated exports; credit figures cover the
  // credit-denominated ones. The two are never added or divided together.
  let instrumented = 0;
  let unowned = 0;
  let tagged = 0;
  let exportTotal = 0;
  let anyCredit = false;
  let usdProviderCount = 0;
  let instrumentedCreditsTotal = 0;
  let unownedCreditsTotal = 0;
  let creditInstrumented = 0;
  let creditUnowned = 0;
  let creditTagged = 0;

  const workflowMap = new Map<string, number>();
  const creditWorkflowMap = new Map<string, number>();
  const agentMap = new Map<string, { attempts: number; cents: number }>();
  const providerSpend = new Map<string, number>();
  const providerCredits = new Map<string, number>();
  const creditProviders: string[] = [];
  const reconciliation: AgentBillAuditProspectReconciliation[] = [];
  const envelopeInputs: Parameters<typeof buildEnvelopePreview>[0][] = [];
  const toolTotals = new Map<string, ToolTotal>();
  const personTotals = new Map<string, Map<string, number>>();
  const estimatedProviders: string[] = [];
  let anyPersonGrain = false;

  for (const block of req.providers) {
    const provider = block.provider?.trim();
    if (!provider) {
      throw new ProspectAuditValidationError("Each block needs a provider name.");
    }
    if (block.usage_csv.length > maxCsvChars) {
      throw new ProspectAuditValidationError("Usage export exceeds size limit.");
    }

    let parsed;
    try {
      parsed = parseUsageExport(block.usage_csv);
    } catch (err) {
      if (err instanceof ProspectCsvParseError) {
        throw new ProspectAuditValidationError(err.message);
      }
      throw err;
    }

    if (parsed.rows.length === 0) {
      throw new ProspectAuditValidationError(
        `${provider}: no data rows found in usage export.`,
      );
    }

    const personGrain = parsed.format !== "generic";
    anyPersonGrain ||= personGrain;
    if (parsed.cost_basis === "estimated") {
      estimatedProviders.push(provider);
    }

    if (parsed.credit_denominated || block.credit_pool_label) {
      anyCredit = true;
    }

    // A credits column with no dollars behind it. If the same export also
    // carries real USD cost, the dollars win and the credits are only noted.
    const creditOnly = parsed.credit_denominated && parsed.total_cents === 0;
    if (creditOnly) {
      creditProviders.push(provider);
    } else {
      usdProviderCount += 1;
    }

    const blockWorkflowMap = new Map<string, number>();
    const blockWorkflowCredits = new Map<string, number>();
    let blockUnowned = 0;
    let blockUnownedCredits = 0;
    let blockExportCents = 0;
    let blockExportCredits = 0;

    for (const row of parsed.rows) {
      // A person, an agent run or a session all answer "whose is this".
      const owned = Boolean(row.workflow_id || row.person);
      if (row.tool) {
        recordToolSpend(toolTotals, personTotals, row, parsed.cost_basis);
      }

      blockExportCents += row.cost_cents;
      blockExportCredits += row.credits;
      instrumentedCreditsTotal += row.credits;
      providerSpend.set(
        provider,
        (providerSpend.get(provider) ?? 0) + row.cost_cents,
      );

      if (!owned) {
        blockUnowned += row.cost_cents;
        blockUnownedCredits += row.credits;
        unownedCreditsTotal += row.credits;
      }

      if (creditOnly) {
        creditInstrumented += row.credits;
        providerCredits.set(
          provider,
          (providerCredits.get(provider) ?? 0) + row.credits,
        );
        if (!owned) creditUnowned += row.credits;
        if (row.tagged) creditTagged += row.credits;
        if (row.workflow_id) {
          creditWorkflowMap.set(
            row.workflow_id,
            (creditWorkflowMap.get(row.workflow_id) ?? 0) + row.credits,
          );
        }
      } else {
        instrumented += row.cost_cents;
        if (!owned) unowned += row.cost_cents;
        if (row.tagged) tagged += row.cost_cents;
        if (row.workflow_id) {
          const prev = workflowMap.get(row.workflow_id) ?? 0;
          workflowMap.set(row.workflow_id, prev + row.cost_cents);
        }
      }

      if (row.workflow_id) {
        const bPrev = blockWorkflowMap.get(row.workflow_id) ?? 0;
        blockWorkflowMap.set(row.workflow_id, bPrev + row.cost_cents);

        if (parsed.credit_denominated) {
          const cPrev = blockWorkflowCredits.get(row.workflow_id) ?? 0;
          blockWorkflowCredits.set(row.workflow_id, cPrev + row.credits);
        }
      }

      if (row.agent_id) {
        const cur = agentMap.get(row.agent_id) ?? { attempts: 0, cents: 0 };
        cur.attempts += 1;
        cur.cents += row.cost_cents;
        agentMap.set(row.agent_id, cur);
      }
    }

    exportTotal += blockExportCents;

    // Only a USD invoice against a USD export is a comparison. A credit
    // export has no dollar figure to set against the invoice.
    const invoiceCents = invoiceUsdToCents(block.invoice_total_usd);
    reconciliation.push({
      provider,
      unit: creditOnly ? "credits" : "usd_cents",
      invoice_cents: invoiceCents,
      export_cents: blockExportCents,
      export_credits: creditOnly ? blockExportCredits : null,
      gap_cents:
        invoiceCents !== null && !creditOnly
          ? blockExportCents - invoiceCents
          : null,
    });

    const blockRunTotals = [...blockWorkflowMap.values()];
    const blockLargestRun = largest(blockRunTotals);
    const blockCreditTotals = [...blockWorkflowCredits.values()];
    const blockLargestCredits = largest(blockCreditTotals);

    // A per-run ceiling needs runs. An export of people alone has none, so
    // anything proposed for it would only be the floor.
    if (!personGrain || blockRunTotals.length > 0) {
      envelopeInputs.push({
        provider,
        largest_run_cents: blockLargestRun,
        unowned_cents: blockUnowned,
        run_totals_cents: blockRunTotals,
        credit_pool_label: block.credit_pool_label,
        credit_denominated: parsed.credit_denominated,
        run_credit_totals: blockCreditTotals,
        largest_run_credits: blockLargestCredits,
        unowned_credits: blockUnownedCredits,
      });
    }
  }

  // Headline lines are USD over the USD exports. Only when there are no USD
  // exports at all do they switch to credits.
  const creditMode = usdProviderCount === 0;
  const headlineInstrumented = creditMode ? creditInstrumented : instrumented;
  const headlineUnowned = creditMode ? creditUnowned : unowned;
  const headlineTagged = creditMode ? creditTagged : tagged;
  const headlineWorkflows = creditMode ? creditWorkflowMap : workflowMap;

  const topWf = topRun(headlineWorkflows);
  const largestRun = topWf?.total ?? 0;
  const largestShare = pctOf(largestRun, headlineInstrumented, true);
  const nativeCapWouldMiss = Boolean(topWf?.workflow_id) && largestShare >= 5;

  let capStatus: AgentBillAuditLineStatus = topWf?.workflow_id
    ? "computed"
    : "account_level_only";
  if (capStatus === "computed" && nativeCapWouldMiss) {
    capStatus = "estimated";
  }
  if (headlineInstrumented === 0) {
    capStatus = "insufficient_data";
  }

  const reconciled = reconciliation.filter((r) => r.gap_cents !== null);
  const unreconciled = reconciliation.filter((r) => r.gap_cents === null);
  const invoiceProvided = reconciled.length > 0;
  const reconciledInvoiceCents = reconciled.reduce(
    (a, r) => a + (r.invoice_cents ?? 0),
    0,
  );
  const reconciledExportCents = reconciled.reduce(
    (a, r) => a + r.export_cents,
    0,
  );
  const exportTotalCents = exportTotal;
  const effectiveCents = invoiceProvided ? reconciledInvoiceCents : exportTotal;
  const listEstimateCents = invoiceProvided
    ? reconciledExportCents
    : exportTotalCents;
  const gap = listEstimateCents - effectiveCents;

  let priceStatus: AgentBillAuditLineStatus = "computed";
  if (!invoiceProvided) {
    priceStatus = "account_level_only";
  }

  const creditPools = anyCredit ? "noted_in_export" : "not_applicable";

  const providers = [...providerSpend.entries()].map(([provider, spend_cents]) => ({
    provider,
    spend_cents,
    share_pct: pctOf(
      creditMode ? (providerCredits.get(provider) ?? 0) : spend_cents,
      headlineInstrumented,
    ),
  }));

  const withWorkflow = [...headlineWorkflows.values()].reduce(
    (a, b) => a + b,
    0,
  );
  const sdkCoverage = pctOf(withWorkflow, headlineInstrumented);

  const envelope_preview = envelopeInputs.map((e) => buildEnvelopePreview(e));

  let credit_headline: AgentBillAuditProspectCreditHeadline | null = null;
  if (creditProviders.length > 0) {
    const creditTop = topRun(creditWorkflowMap);
    const creditShare = pctOf(
      creditTop?.total ?? 0,
      creditInstrumented,
      true,
    );
    credit_headline = {
      providers: creditProviders,
      instrumented_credits: creditInstrumented,
      unowned_credits: creditUnowned,
      largest_run_workflow_id: creditTop?.workflow_id ?? null,
      largest_run_credits: creditTop?.total ?? 0,
      largest_run_share_pct: creditShare,
      native_cap_would_miss: Boolean(creditTop?.workflow_id) && creditShare >= 5,
      tagged_credits: creditTagged,
      tagged_share_pct: pctOf(creditTagged, creditInstrumented),
    };
  }

  const priceNote = priceNoteFor(
    invoiceProvided,
    creditMode,
    unreconciled,
    estimatedProviders,
  );

  return {
    window_days: windowDays,
    generated_at: new Date().toISOString(),
    source: options.source ?? "prospect_upload",
    price_basis: "invoice_vs_export",
    export_total_cents: exportTotalCents,
    invoice_reconciled_cents: invoiceProvided ? reconciledInvoiceCents : null,
    headline_unit: creditMode ? "credits" : "usd_cents",
    reconciliation,
    credit_headline,
    instrumented_credits: anyCredit ? instrumentedCreditsTotal : null,
    unowned_credits: anyCredit ? unownedCreditsTotal : null,
    envelope_preview,
    people_and_tools: anyPersonGrain
      ? summarisePeopleAndTools(toolTotals, personTotals)
      : null,
    lines: {
      cap_blind_spot: {
        status: capStatus,
        largest_run_workflow_id: topWf?.workflow_id ?? null,
        // USD only: a credit-denominated headline leaves this at 0 and the
        // credit amount lives on credit_headline.
        largest_run_cost_cents: creditMode ? 0 : largestRun,
        largest_run_share_pct: largestShare,
        list_vs_effective_gap_cents: invoiceProvided ? gap : null,
        native_cap_would_miss: nativeCapWouldMiss,
        note:
          capStatus === "account_level_only"
            ? anyPersonGrain
              ? "Export has no run id, so no single run can be named. Spend by person is listed separately."
              : "Export has no run/session id column — audit is account-level only."
            : capStatus === "estimated"
              ? "Largest-run share heuristic; native monthly caps may miss runaway sessions."
              : capStatus === "insufficient_data"
                ? "No spend rows parsed from export."
                : undefined,
      },
      unowned_spend: {
        status: headlineInstrumented > 0 ? "computed" : "insufficient_data",
        unowned_cents: unowned,
        unowned_pct: pctOf(headlineUnowned, headlineInstrumented),
        instrumented_cents: instrumented,
      },
      price_paid_vs_list: {
        status: priceStatus,
        effective_cents: effectiveCents,
        list_estimate_cents: listEstimateCents,
        gap_cents: gap,
        credit_pools: creditPools,
        note: priceNote,
      },
      capitalisation_estimate: {
        status: headlineInstrumented > 0 ? "estimated" : "insufficient_data",
        tagged_cents: tagged,
        capitalisation_eligible_share_pct: pctOf(
          headlineTagged,
          headlineInstrumented,
        ),
        disclaimer: CAPITALISATION_DISCLAIMER,
      },
      seller_margin: {
        status: "requires_outcome_feed",
        cost_per_attempt_by_agent: [...agentMap.entries()].map(
          ([agent_id, v]) => ({
            agent_id,
            attempt_count: v.attempts,
            total_cost_cents: v.cents,
          }),
        ),
        note: "Margin per resolution requires an outcome feed (billing or helpdesk).",
      },
    },
    cross_vendor: { providers },
    sdk_workflow_coverage_pct: sdkCoverage,
  };
}

export class ProspectAuditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProspectAuditValidationError";
  }
}

interface ToolTotal {
  cost_basis: AgentBillAuditToolSlice["cost_basis"];
  spend_cents: number;
  gross_cents: number | null;
  people: Set<string>;
  unowned_cents: number;
}

function recordToolSpend(
  tools: Map<string, ToolTotal>,
  people: Map<string, Map<string, number>>,
  row: ProspectUsageRow,
  costBasis: AgentBillAuditToolSlice["cost_basis"],
): void {
  const tool = row.tool!;
  const total = tools.get(tool) ?? {
    cost_basis: costBasis,
    spend_cents: 0,
    gross_cents: null,
    people: new Set<string>(),
    unowned_cents: 0,
  };
  total.spend_cents += row.cost_cents;
  if (row.gross_cents != null) {
    total.gross_cents = (total.gross_cents ?? 0) + row.gross_cents;
  }
  if (row.person) {
    total.people.add(row.person);
    const byTool = people.get(row.person) ?? new Map<string, number>();
    byTool.set(tool, (byTool.get(tool) ?? 0) + row.cost_cents);
    people.set(row.person, byTool);
  } else if (!row.workflow_id) {
    total.unowned_cents += row.cost_cents;
  }
  tools.set(tool, total);
}

function summarisePeopleAndTools(
  tools: Map<string, ToolTotal>,
  people: Map<string, Map<string, number>>,
): AgentBillAuditPeopleAndTools {
  const by_tool = [...tools.entries()]
    .map(([tool, t]) => ({
      tool,
      cost_basis: t.cost_basis,
      spend_cents: t.spend_cents,
      gross_cents: t.gross_cents,
      people: t.people.size,
      unowned_cents: t.unowned_cents,
    }))
    .sort((a, b) => b.spend_cents - a.spend_cents);

  const by_person = [...people.entries()]
    .map(([person, byTool]) => {
      const personTools = [...byTool.entries()]
        .map(([tool, spend_cents]) => ({ tool, spend_cents }))
        .sort((a, b) => b.spend_cents - a.spend_cents);
      return {
        person,
        total_cents: personTools.reduce((sum, t) => sum + t.spend_cents, 0),
        tools: personTools,
      };
    })
    .sort((a, b) => b.total_cents - a.total_cents);

  return { by_tool, by_person };
}

/** Not Math.max(...values): a real export can hold more runs than an argument list. */
function largest(values: number[]): number {
  let top = 0;
  for (const v of values) {
    if (v > top) top = v;
  }
  return top;
}

function clampWindow(days: number): number {
  const n = Math.floor(days);
  if (n === 30 || n === 90) return n;
  return 90;
}

function invoiceUsdToCents(usd: number | undefined): number | null {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return null;
  return Math.round(usd * 100);
}

function topRun(runs: Map<string, number>): WorkflowAgg | null {
  let top: WorkflowAgg | null = null;
  for (const [workflow_id, total] of runs) {
    if (!top || total > top.total) {
      top = { workflow_id, total };
    }
  }
  return top;
}

/** One-decimal percentage; 0 when there is nothing to divide by. */
function pctOf(part: number, whole: number, capAt100 = false): number {
  if (whole <= 0) return 0;
  const raw = (part / whole) * 100;
  return Math.round((capAt100 ? Math.min(raw, 100) : raw) * 10) / 10;
}

function priceNoteFor(
  invoiceProvided: boolean,
  creditOnly: boolean,
  unreconciled: AgentBillAuditProspectReconciliation[],
  estimatedProviders: string[],
): string {
  const note = basePriceNote(invoiceProvided, creditOnly, unreconciled);
  return estimatedProviders.length > 0
    ? `${note} Estimated from token counts at list price, not billed: ${estimatedProviders.join(", ")}.`
    : note;
}

function basePriceNote(
  invoiceProvided: boolean,
  creditOnly: boolean,
  unreconciled: AgentBillAuditProspectReconciliation[],
): string {
  if (!invoiceProvided) {
    // Without a single USD export there is no dollar total to set an invoice
    // against, so asking for invoice_total_usd would send them nowhere.
    return creditOnly
      ? "Credit-denominated exports have no dollar total, so there is nothing to reconcile an invoice against."
      : "Add invoice_total_usd per provider to reconcile against your statement.";
  }
  if (unreconciled.length === 0) {
    return "Invoice total vs usage-export sum (export is not catalog list price).";
  }
  const names = unreconciled.map((r) => r.provider).join(", ");
  return `Invoice vs usage-export sum for invoiced providers only (export is not catalog list price). Not reconciled: ${names}.`;
}
