/**
 * Reads a usage export whichever vendor it came from.
 *
 * Formats, as documented on 2026-11-05:
 *   GitHub Copilot  AI usage report. GitHub lists the fields but not the file
 *                   format or the currency of the amounts; this assumes CSV and
 *                   USD (1 AI credit is documented as $0.01).
 *   Cursor          Admin API JSON: /teams/filtered-usage-events, /teams/spend.
 *                   The dashboard CSV has no documented columns, so it is not
 *                   read.
 *   Claude Code     Analytics API JSON (estimates at list price), or the
 *                   Team/Enterprise spend report CSV (net spend). The support
 *                   article gives the spend columns exactly but describes the
 *                   email and product columns only in words, so those two are
 *                   matched loosely.
 *
 * Amounts are added up before rounding, because vendors report sub-cent charges
 * and thousands of them round to nothing one at a time.
 */

import {
  isLikelySummaryRow,
  parseProspectUsageCsv,
  parseUsd,
  ProspectCsvParseError,
  splitCsvLine,
  stripBom,
  type ParsedProspectUsage,
  type ProspectUsageRow,
} from "./prospect-csv.js";
import type { UsageCostBasis, UsageExportFormat } from "./types.js";

export interface ParsedUsageExport extends ParsedProspectUsage {
  format: UsageExportFormat;
  cost_basis: UsageCostBasis;
}

const SUPPORTED_JSON =
  "Expected a Cursor Admin API response (usageEvents or teamMemberSpend) or a Claude Code Analytics API response.";

type JsonRecord = Record<string, unknown>;

interface Charge {
  person: string | null;
  run: string | null;
  tool: string;
  cents: number;
  grossCents: number | null;
  tagged: boolean;
}

export function parseUsageExport(text: string): ParsedUsageExport {
  const body = stripBom(text).trim();
  if (body.startsWith("{") || body.startsWith("[")) {
    return parseJsonExport(body);
  }

  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = splitCsvLine(lines[0] ?? "").map(normaliseHeader);

  if (headers.includes("total_net_spend_usd")) {
    return parseClaudeSpendReport(lines, headers);
  }
  if (headers.includes("net_amount") && headers.includes("username")) {
    if (!headers.includes("model")) {
      throw new ProspectCsvParseError(
        "This looks like a GitHub usage report covering every paid product. Download the AI usage report instead, which is Copilot only.",
      );
    }
    return parseCopilotReport(lines, headers);
  }
  return {
    ...parseProspectUsageCsv(text),
    format: "generic",
    cost_basis: "billed",
  };
}

function parseJsonExport(body: string): ParsedUsageExport {
  const pages = readJsonPages(body);

  if (pages.some((p) => Array.isArray(p["usageEvents"]))) {
    return toParsed(
      "cursor",
      "billed",
      pages.flatMap((p) => records(p["usageEvents"])).map(cursorEventCharge),
    );
  }
  if (pages.some((p) => Array.isArray(p["teamMemberSpend"]))) {
    return toParsed(
      "cursor",
      "billed",
      pages.flatMap((p) => records(p["teamMemberSpend"])).map(cursorSpendCharge),
    );
  }
  const analytics = pages.filter(isClaudeCodeAnalyticsPage);
  if (analytics.length > 0) {
    return toParsed(
      "claude_code",
      "estimated",
      analytics.flatMap((p) => records(p["data"])).map(claudeCodeCharge),
    );
  }
  throw new ProspectCsvParseError(`JSON export not recognised. ${SUPPORTED_JSON}`);
}

/** One response, an array of saved pages, or one response per line. */
function readJsonPages(body: string): JsonRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = body
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as unknown);
    } catch {
      throw new ProspectCsvParseError(`Export is not valid JSON. ${SUPPORTED_JSON}`);
    }
  }
  return records(Array.isArray(parsed) ? parsed : [parsed]);
}

function isClaudeCodeAnalyticsPage(page: JsonRecord): boolean {
  const data = page["data"];
  return (
    Array.isArray(data) &&
    records(data).every((r) => Array.isArray(r["model_breakdown"]))
  );
}

function cursorEventCharge(event: JsonRecord): Charge {
  const serviceAccount = text(event["serviceAccountName"]);
  const usage = isRecord(event["tokenUsage"]) ? event["tokenUsage"] : null;
  return {
    person:
      text(event["userEmail"]) ??
      (serviceAccount ? `service:${serviceAccount}` : null),
    run: text(event["conversationId"]),
    tool: "Cursor",
    cents: amount(event["chargedCents"]),
    grossCents: usage ? amount(usage["totalCents"]) : null,
    tagged: false,
  };
}

/** spendCents is on-demand only; overallSpendCents adds included usage. */
function cursorSpendCharge(member: JsonRecord): Charge {
  return {
    person:
      text(member["email"]) ?? text(member["name"]) ?? text(member["userId"]),
    run: null,
    tool: "Cursor",
    cents: amount(member["spendCents"]),
    grossCents: amount(member["overallSpendCents"]),
    tagged: false,
  };
}

function claudeCodeCharge(record: JsonRecord): Charge {
  const actor = isRecord(record["actor"]) ? record["actor"] : {};
  const keyName = text(actor["api_key_name"]);
  let cents = 0;
  for (const model of records(record["model_breakdown"])) {
    const cost = model["estimated_cost"];
    if (isRecord(cost)) cents += amount(cost["amount"]);
  }
  return {
    person: text(actor["email_address"]) ?? (keyName ? `key:${keyName}` : null),
    run: null,
    tool: "Claude Code",
    cents,
    grossCents: null,
    tagged: false,
  };
}

function parseCopilotReport(
  lines: string[],
  headers: string[],
): ParsedUsageExport {
  const net = headers.indexOf("net_amount");
  const gross = headers.indexOf("gross_amount");
  const username = headers.indexOf("username");
  const costCentre = headers.indexOf("cost_center_name");

  return toParsed(
    "github_copilot",
    "billed",
    dataRows(lines).map((cols) => ({
      person: cell(cols, username),
      run: null,
      tool: "GitHub Copilot",
      cents: dollarsToCents(cols[net]),
      grossCents: gross >= 0 ? dollarsToCents(cols[gross]) : null,
      tagged: cell(cols, costCentre) !== null,
    })),
  );
}

function parseClaudeSpendReport(
  lines: string[],
  headers: string[],
): ParsedUsageExport {
  const net = headers.indexOf("total_net_spend_usd");
  const gross = headers.indexOf("total_gross_spend_usd");
  const email = headers.findIndex((h) => h.includes("email"));
  const product = headers.findIndex((h) => h.includes("product"));

  return toParsed(
    "claude_code",
    "billed",
    dataRows(lines).map((cols) => ({
      person: cell(cols, email),
      run: null,
      tool: claudeToolName(cell(cols, product)),
      cents: dollarsToCents(cols[net]),
      grossCents: gross >= 0 ? dollarsToCents(cols[gross]) : null,
      tagged: false,
    })),
  );
}

function claudeToolName(product: string | null): string {
  if (!product) return "Claude";
  return /^claude\b/i.test(product) ? product : `Claude ${product}`;
}

function toParsed(
  format: UsageExportFormat,
  cost_basis: UsageCostBasis,
  charges: Charge[],
): ParsedUsageExport {
  const totals = new Map<string, Charge>();
  for (const raw of charges) {
    const charge = { ...raw, person: canonicalPerson(raw.person) };
    const key = JSON.stringify([
      charge.person,
      charge.run,
      charge.tool,
      charge.tagged,
    ]);
    const total = totals.get(key);
    if (!total) {
      totals.set(key, charge);
      continue;
    }
    total.cents += charge.cents;
    if (charge.grossCents !== null) {
      total.grossCents = (total.grossCents ?? 0) + charge.grossCents;
    }
  }

  const rows: ProspectUsageRow[] = [...totals.values()].map((t) => ({
    cost_cents: Math.round(t.cents),
    credits: 0,
    workflow_id: t.run,
    agent_id: null,
    tagged: t.tagged,
    person: t.person,
    tool: t.tool,
    gross_cents: t.grossCents === null ? null : Math.round(t.grossCents),
  }));

  return {
    rows,
    total_cents: rows.reduce((sum, r) => sum + r.cost_cents, 0),
    credit_denominated: false,
    total_credits: 0,
    format,
    cost_basis,
  };
}

/** Vendors differ on an email's case, and one person shouldn't become two. */
function canonicalPerson(person: string | null): string | null {
  return person?.includes("@") ? person.toLowerCase() : person;
}

function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/\s+/g, "_");
}

function dataRows(lines: string[]): string[][] {
  return lines
    .slice(1)
    .map(splitCsvLine)
    .filter((cols) => !isLikelySummaryRow(cols[0] ?? ""));
}

function cell(cols: string[], index: number): string | null {
  if (index < 0) return null;
  return cols[index]?.trim() || null;
}

function dollarsToCents(raw: string | undefined): number {
  return (parseUsd(raw ?? "") ?? 0) * 100;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function amount(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}
