/** Minimal CSV parser for prospect usage exports (no deps). */

export interface ProspectUsageRow {
  cost_cents: number;
  credits: number;
  workflow_id: string | null;
  agent_id: string | null;
  tagged: boolean;
  /** Who the spend belongs to, on exports that name people. */
  person?: string | null;
  /** Product the spend came from, on exports that name one. */
  tool?: string;
  /** Before discounts and included usage. Null when the export has no such figure. */
  gross_cents?: number | null;
}

export interface ParsedProspectUsage {
  rows: ProspectUsageRow[];
  total_cents: number;
  credit_denominated: boolean;
  total_credits: number;
}

export class ProspectCsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProspectCsvParseError";
  }
}

const COST_HEADERS = [
  "cost",
  "amount",
  "amount_usd",
  "total_cost",
  "spend",
  "cost_usd",
  "total",
];
const CREDIT_QUANTITY_HEADERS = [
  "credits_used",
  "credits",
  "copilot_credits",
  "credit_amount",
  "credit_units",
];
const WORKFLOW_HEADERS = [
  "workflow_id",
  "session_id",
  "run_id",
  "conversation_id",
];
const AGENT_HEADERS = ["agent_id"];
const TAG_HEADERS = [
  "project",
  "cost_center",
  "cost_centre",
  "team",
  "application",
];

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function pickColumn(headers: string[], candidates: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  for (const cand of candidates) {
    const idx = lower.indexOf(cand);
    if (idx >= 0) return idx;
  }
  return -1;
}

export function parseUsd(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || /^(-|n\/a|na|null)$/i.test(trimmed)) {
    return null;
  }
  let cleaned = trimmed.replace(/[$,\s"]/g, "");
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    cleaned = `-${cleaned.slice(1, -1)}`;
  }
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseUsdToCents(raw: string): number | null {
  const usd = parseUsd(raw);
  return usd === null ? null : Math.round(usd * 100);
}

function parseCreditQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || /^(-|n\/a|na|null)$/i.test(trimmed)) {
    return null;
  }
  const cleaned = trimmed.replace(/[,\s"]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

export function isLikelySummaryRow(firstCell: string): boolean {
  return /^(total|subtotal|grand total|sum)$/i.test(firstCell.trim());
}

export function parseProspectUsageCsv(csvText: string): ParsedProspectUsage {
  const lines = stripBom(csvText)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    return {
      rows: [],
      total_cents: 0,
      credit_denominated: false,
      total_credits: 0,
    };
  }

  const headers = splitCsvLine(lines[0]!);
  const costIdx = pickColumn(headers, COST_HEADERS);
  const creditsIdx = pickColumn(headers, CREDIT_QUANTITY_HEADERS);
  const creditDenominated = creditsIdx >= 0;

  if (costIdx < 0 && !creditDenominated) {
    throw new ProspectCsvParseError(
      "Could not find a cost or credits column. Expected headers like cost, amount_usd, or credits_used.",
    );
  }

  const wfIdx = pickColumn(headers, WORKFLOW_HEADERS);
  const agentIdx = pickColumn(headers, AGENT_HEADERS);
  const tagIdxs = TAG_HEADERS.map((t) => pickColumn(headers, [t])).filter(
    (i) => i >= 0,
  );

  const rows: ProspectUsageRow[] = [];
  let total = 0;
  let totalCredits = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]!);
    if (isLikelySummaryRow(cols[0] ?? "")) {
      continue;
    }

    // A credits export often leaves the dollar column blank (or has none), so
    // a row survives as long as either quantity parses.
    const parsedCost =
      costIdx >= 0 ? parseUsdToCents(cols[costIdx] ?? "") : null;
    const parsedCredits =
      creditsIdx >= 0 ? parseCreditQuantity(cols[creditsIdx] ?? "") : null;
    if (parsedCost === null && parsedCredits === null) {
      continue;
    }

    const cost_cents = parsedCost ?? 0;
    const credits = parsedCredits ?? 0;
    if (cost_cents === 0 && credits === 0) {
      continue;
    }
    total += cost_cents;
    totalCredits += credits;

    const workflow_id =
      wfIdx >= 0 && cols[wfIdx]?.trim() ? cols[wfIdx]!.trim() : null;
    const agent_id =
      agentIdx >= 0 && cols[agentIdx]?.trim() ? cols[agentIdx]!.trim() : null;
    const tagged = tagIdxs.some((idx) => Boolean(cols[idx]?.trim()));

    rows.push({ cost_cents, credits, workflow_id, agent_id, tagged });
  }

  return {
    rows,
    total_cents: total,
    credit_denominated: creditDenominated,
    total_credits: totalCredits,
  };
}

export function parseInvoiceTotalUsd(text: string): number | null {
  const trimmed = stripBom(text).trim();
  if (!trimmed) return null;
  // Only a lone amount is read as one. Stripping non-digits from anything
  // longer runs a CSV's cells together into a number nobody wrote.
  if (/^(usd\s*)?\$?\s*-?[\d,]+(\.\d+)?(\s*usd)?$/i.test(trimmed)) {
    const n = parseUsd(trimmed.replace(/usd/i, ""));
    return n !== null && n > 0 ? n : null;
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  if (lines.length >= 2) {
    const headers = splitCsvLine(lines[0]!);
    const amountIdx = pickColumn(headers, [
      "invoice_total",
      "total_due",
      "amount_due",
      "amount",
      "total",
    ]);
    if (amountIdx >= 0) {
      let sum = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = splitCsvLine(lines[i]!);
        if (isLikelySummaryRow(cols[0] ?? "")) continue;
        const cents = parseUsdToCents(cols[amountIdx] ?? "0");
        if (cents === null) continue;
        sum += cents;
      }
      return sum > 0 ? sum / 100 : null;
    }
  }
  return null;
}
