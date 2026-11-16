import { readFileSync } from "fs";
import { basename, extname } from "path";
import {
  buildProspectBillAudit,
  parseBedrockInvocationLog,
  parseFocusBill,
  parseInvoiceTotalUsd,
  parseLiteLlmSpendLog,
  parseUsageExport,
  ProspectCsvParseError,
  witnessOverlap,
  type AgentBillAuditProspectProviderInput,
  type AgentBillAuditProspectResponse,
  type PriceCents,
  type WitnessBill,
  type WitnessCall,
  type WitnessOverlap,
} from "@tensorcost/bill-audit";
import { formatCents, formatNumber } from "../format.js";
import { getModel, loadModelRates } from "../pricing.js";

export interface AuditExportArg {
  provider?: string;
  path: string;
}

export interface AuditInvoiceArg {
  provider?: string;
  value: string;
}

export interface AuditArgs {
  exports: AuditExportArg[];
  invoices: AuditInvoiceArg[];
  windowDays?: number;
  json: boolean;
}

type ReadFile = (path: string) => string;

/** Export names that hold the same calls as another input, not a usage report. */
const WITNESS_NAMES = ["litellm", "bedrock-invocations", "bedrock-cur"] as const;
type WitnessName = (typeof WITNESS_NAMES)[number];

function witnessName(provider: string | undefined): WitnessName | null {
  return WITNESS_NAMES.find((n) => n === provider) ?? null;
}

export const CONNECT_LINE =
  "Connected, TensorCost counts this daily and lets your gateways enforce one budget: https://tensorcost.com/connect";

const NAMED_ARG = /^([A-Za-z0-9_-]+)=(.+)$/;
const TOP_PEOPLE = 10;
const TOP_AGENTS = 5;
const AMOUNT_EXAMPLE = "--invoice 1842.00";

function splitNamed(arg: string): { provider?: string; rest: string } {
  const match = NAMED_ARG.exec(arg);
  return match ? { provider: match[1], rest: match[2]! } : { rest: arg };
}

export function parseAuditArgs(argv: string[]): AuditArgs {
  const parsed: AuditArgs = { exports: [], invoices: [], json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--export") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--export needs name=path, for example --export litellm=spendlogs.csv");
      }
      const { provider, rest } = splitNamed(next);
      parsed.exports.push(provider ? { provider, path: rest } : { path: rest });
    } else if (arg === "--invoice") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--invoice needs a file or an amount.");
      }
      const { provider, rest } = splitNamed(next);
      parsed.invoices.push(provider ? { provider, value: rest } : { value: rest });
    } else if (arg === "--window") {
      const next = argv[++i];
      if (next !== "30" && next !== "90") {
        throw new Error("--window must be 30 or 90.");
      }
      parsed.windowDays = Number(next);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option for audit: ${arg}`);
    } else {
      const { provider, rest } = splitNamed(arg);
      parsed.exports.push(provider ? { provider, path: rest } : { path: rest });
    }
  }

  if (parsed.exports.length === 0) {
    throw new Error(
      "audit needs a usage export: tensorcost audit <usage-export> --invoice <file-or-amount>",
    );
  }
  return parsed;
}

function nameFromFile(path: string): string {
  const stem = basename(path, extname(path));
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "usage";
}

function readOrExplain(path: string, readFile: ReadFile): string {
  try {
    return readFile(path);
  } catch {
    throw new Error(`Could not read ${path}.`);
  }
}

function invoiceTotalUsd(value: string, readFile: ReadFile): number {
  const amount = parseInvoiceTotalUsd(value);
  if (amount !== null) return amount;

  const content = readOrExplain(value, readFile);
  if (content.startsWith("%PDF")) {
    throw new Error(
      `${value}: PDF invoices can't be read. Pass the total instead: ${AMOUNT_EXAMPLE}`,
    );
  }
  const total = parseInvoiceTotalUsd(content);
  if (total === null) {
    throw new Error(
      `Could not find a total in ${value}. Pass it instead: ${AMOUNT_EXAMPLE}`,
    );
  }
  return total;
}

function readProviderBlock(
  arg: AuditExportArg,
  readFile: ReadFile,
): AgentBillAuditProspectProviderInput {
  const usage_csv = readOrExplain(arg.path, readFile);
  try {
    const { format } = parseUsageExport(usage_csv);
    const provider =
      arg.provider ?? (format === "generic" ? nameFromFile(arg.path) : format);
    return { provider, usage_csv };
  } catch (err) {
    if (err instanceof ProspectCsvParseError) {
      throw new Error(`${arg.path}: ${err.message}`);
    }
    throw err;
  }
}

function invoicesByProvider(
  invoices: AuditInvoiceArg[],
  providers: string[],
  readFile: ReadFile,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const invoice of invoices) {
    if (!invoice.provider && providers.length > 1) {
      throw new Error(
        `With several exports, name each invoice: --invoice ${providers[0]}=1842.00`,
      );
    }
    const provider = invoice.provider ?? providers[0]!;
    if (!providers.includes(provider)) {
      throw new Error(
        `No export named ${provider}. Exports here: ${providers.join(", ")}.`,
      );
    }
    const total = invoiceTotalUsd(invoice.value, readFile);
    totals.set(provider, (totals.get(provider) ?? 0) + total);
  }
  return totals;
}

export function auditFiles(
  args: AuditArgs,
  readFile: ReadFile = (path) => readFileSync(path, "utf8"),
): AgentBillAuditProspectResponse {
  const blocks = args.exports.map((arg) => readProviderBlock(arg, readFile));
  const invoices = invoicesByProvider(
    args.invoices,
    blocks.map((b) => b.provider),
    readFile,
  );

  return buildProspectBillAudit(
    {
      window_days: args.windowDays,
      providers: blocks.map((block) => ({
        ...block,
        invoice_total_usd: invoices.get(block.provider),
      })),
    },
    // The limits guard a public endpoint. This is someone's own file on their
    // own machine, and a real 90-day export can pass them.
    {
      maxCsvChars: Number.POSITIVE_INFINITY,
      maxProviders: Number.POSITIVE_INFINITY,
      source: "local_cli",
    },
  );
}

function credits(n: number): string {
  return `${formatNumber(n)} credits`;
}

function renderCapBlindSpot(r: AgentBillAuditProspectResponse): string[] {
  const line = r.lines.cap_blind_spot;
  const out = ["1. The run your cap did not see"];
  if (line.status === "computed" || line.status === "estimated") {
    const amount =
      r.headline_unit === "credits"
        ? credits(r.credit_headline?.largest_run_credits ?? 0)
        : formatCents(line.largest_run_cost_cents);
    out.push(
      `   ${line.largest_run_workflow_id}: ${amount}, ${line.largest_run_share_pct}% of spend.`,
    );
  }
  if (line.note) out.push(`   ${line.note}`);
  return out;
}

function renderUnowned(r: AgentBillAuditProspectResponse): string[] {
  const line = r.lines.unowned_spend;
  const amounts =
    r.headline_unit === "credits"
      ? `${formatNumber(r.credit_headline?.unowned_credits ?? 0)} of ${credits(
          r.credit_headline?.instrumented_credits ?? 0,
        )}`
      : `${formatCents(line.unowned_cents)} of ${formatCents(line.instrumented_cents)}`;
  return [
    "2. Spend with no owner",
    `   ${amounts} (${line.unowned_pct}%) can't be tied to a person, agent or run.`,
  ];
}

function renderPricePaid(r: AgentBillAuditProspectResponse): string[] {
  const line = r.lines.price_paid_vs_list;
  const out = ["3. Price paid, not list"];
  if (line.status === "account_level_only") {
    out.push(
      r.headline_unit === "credits"
        ? `   ${line.note}`
        : "   No invoice given. Add --invoice to compare the export against your statement.",
    );
    return out;
  }

  const invoice = formatCents(line.effective_cents);
  const usage = formatCents(line.list_estimate_cents);
  const gap = formatCents(Math.abs(line.gap_cents));
  out.push(`   Invoice ${invoice}, usage export ${usage}.`);
  if (line.gap_cents < 0) {
    out.push(`   The invoice is ${gap} higher than the export.`);
  } else if (line.gap_cents > 0) {
    out.push(`   The export is ${gap} higher than the invoice.`);
  } else {
    out.push("   They match.");
  }
  if (line.note) out.push(`   ${line.note}`);
  return out;
}

function renderCapitalisation(r: AgentBillAuditProspectResponse): string[] {
  const line = r.lines.capitalisation_estimate;
  return [
    "4. Capitalisation-ready share (estimate)",
    `   ${line.capitalisation_eligible_share_pct}% of spend carries a project, team or cost-centre tag.`,
    `   ${line.disclaimer}`,
  ];
}

function renderCostPerAttempt(r: AgentBillAuditProspectResponse): string[] {
  const line = r.lines.seller_margin;
  const agents = [...line.cost_per_attempt_by_agent]
    .sort((a, b) => b.total_cost_cents - a.total_cost_cents)
    .slice(0, TOP_AGENTS);

  const out = ["5. Cost per attempt"];
  if (agents.length === 0) {
    out.push("   No agent id in this export.");
  }
  for (const agent of agents) {
    const each = formatCents(agent.total_cost_cents / agent.attempt_count);
    out.push(
      `   ${agent.agent_id}: ${formatCents(agent.total_cost_cents)} over ${formatNumber(agent.attempt_count)} attempts (${each} each).`,
    );
  }
  if (line.note) out.push(`   ${line.note}`);
  return out;
}

function renderPeopleAndTools(r: AgentBillAuditProspectResponse): string[] {
  const section = r.people_and_tools;
  if (!section) return [];

  const toolWidth = Math.max(...section.by_tool.map((t) => t.tool.length));
  const spendWidth = Math.max(
    ...section.by_tool.map((t) => formatCents(t.spend_cents).length),
  );
  const out = ["By tool"];
  for (const t of section.by_tool) {
    const people = t.people === 1 ? "1 person" : `${t.people} people`;
    const gross =
      t.gross_cents !== null && t.gross_cents !== t.spend_cents
        ? `, ${formatCents(t.gross_cents)} before discounts`
        : "";
    out.push(
      `   ${t.tool.padEnd(toolWidth)}  ${formatCents(t.spend_cents).padStart(spendWidth)}  ${people}  ${t.cost_basis}${gross}`,
    );
  }
  if (section.by_tool.some((t) => t.cost_basis === "estimated")) {
    out.push("   Estimated figures are tokens at list price, not charges.");
  }

  const top = section.by_person.slice(0, TOP_PEOPLE);
  if (top.length === 0) return out;

  const count = section.by_person.length;
  const nameWidth = Math.max(...top.map((p) => p.person.length));
  const totalWidth = Math.max(
    ...top.map((p) => formatCents(p.total_cents).length),
  );
  out.push(
    "",
    count > TOP_PEOPLE ? `By person (top ${TOP_PEOPLE} of ${count})` : "By person",
  );
  for (const p of top) {
    const tools = p.tools
      .map((t) => `${t.tool} ${formatCents(t.spend_cents)}`)
      .join(", ");
    out.push(
      `   ${p.person.padEnd(nameWidth)}  ${formatCents(p.total_cents).padStart(totalWidth)}  ${tools}`,
    );
  }
  return out;
}

export function renderAudit(
  r: AgentBillAuditProspectResponse,
  withClosing = true,
): string {
  const sections = [
    [
      "TensorCost bill audit",
      "Computed on this machine from your files. Nothing was sent anywhere.",
    ],
    renderCapBlindSpot(r),
    renderUnowned(r),
    renderPricePaid(r),
    renderCapitalisation(r),
    renderCostPerAttempt(r),
    renderPeopleAndTools(r),
    ["Questions about these numbers: hello@tensorcost.com"],
  ];
  const body = sections
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
  return withClosing ? `${body}\n\n${CONNECT_LINE}` : body;
}

export interface AuditReport {
  /** The usage-export audit. Null when every input was a gateway log or bill. */
  audit: AgentBillAuditProspectResponse | null;
  counted_twice: WitnessOverlap | null;
  /** Invoices named for a provider with no usage export, listed beside the calls. */
  other_invoices: Array<{ provider: string; cents: number }>;
}

export interface AuditDeps {
  readFile?: ReadFile;
  /** Loads the public price catalogue. Called only when an invocation log needs pricing. */
  loadRates?: () => Promise<void>;
}

/** Bedrock ids reach the log with a region prefix the catalogue doesn't carry. */
function bedrockPrice(modelId: string): { in: number; out: number } | null {
  const bare = modelId.replace(/^(?:us|eu|apac|global|us-gov)\./, "");
  const model = getModel(`bedrock/${bare}`) ?? getModel(`bedrock/${modelId}`);
  return model
    ? { in: model.input_per_million_usd, out: model.output_per_million_usd }
    : null;
}

/** Cache reads aren't in the catalogue's rates, so they are left out of the price. */
const priceInvocation: PriceCents = (modelId, input, output) => {
  const rate = bedrockPrice(modelId);
  if (!rate) return null;
  return ((input * rate.in + output * rate.out) / 1_000_000) * 100;
};

function readWitness(
  name: WitnessName,
  path: string,
  readFile: ReadFile,
): { calls: WitnessCall[]; bill?: WitnessBill; unpriced: number } {
  if (name === "bedrock-cur" && /\.parquet$/i.test(path)) {
    throw new Error(
      `${path}: Parquet isn't read here. Export AWS's FOCUS CSV and pass that.`,
    );
  }
  const text = readOrExplain(path, readFile);
  try {
    if (name === "litellm") return { calls: parseLiteLlmSpendLog(text), unpriced: 0 };
    if (name === "bedrock-cur") return { calls: [], bill: parseFocusBill(text), unpriced: 0 };
    const { calls, unpriced } = parseBedrockInvocationLog(text, priceInvocation);
    return { calls, unpriced };
  } catch (err) {
    if (err instanceof ProspectCsvParseError) throw new Error(`${path}: ${err.message}`);
    throw err;
  }
}

export async function auditReport(
  args: AuditArgs,
  deps: AuditDeps = {},
): Promise<AuditReport> {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const witnessArgs = args.exports.filter((e) => witnessName(e.provider));
  const usageArgs = args.exports.filter((e) => !witnessName(e.provider));

  // Usage exports and their invoices go through the audit as before. An
  // invoice that names no usage export belongs to the witness inputs.
  const usageNames = usageArgs.map((e) => e.provider ?? nameFromFile(e.path));
  const toUsage: AuditInvoiceArg[] = [];
  const other: AuditInvoiceArg[] = [];
  for (const inv of args.invoices) {
    const forUsage =
      usageArgs.length > 0 &&
      (witnessArgs.length === 0 ||
        (inv.provider ? usageNames.includes(inv.provider) : usageArgs.length === 1));
    (forUsage ? toUsage : other).push(inv);
  }

  const audit =
    usageArgs.length > 0
      ? auditFiles({ ...args, exports: usageArgs, invoices: toUsage }, readFile)
      : null;
  if (witnessArgs.length === 0) {
    return { audit, counted_twice: null, other_invoices: [] };
  }

  // Only an invocation log has tokens and no price, so only it needs the catalogue.
  if (witnessArgs.some((e) => e.provider === "bedrock-invocations")) {
    await (deps.loadRates ?? (() => loadModelRates()))();
  }
  const calls: WitnessCall[] = [];
  const bills: WitnessBill[] = [];
  let unpriced = 0;
  for (const arg of witnessArgs) {
    const read = readWitness(witnessName(arg.provider)!, arg.path, readFile);
    calls.push(...read.calls);
    if (read.bill) bills.push(read.bill);
    unpriced += read.unpriced;
  }

  const byProvider = new Map<string, number>();
  for (const inv of other) {
    const provider = inv.provider ?? "invoice";
    byProvider.set(
      provider,
      (byProvider.get(provider) ?? 0) + invoiceTotalUsd(inv.value, readFile) * 100,
    );
  }
  return {
    audit,
    counted_twice: witnessOverlap(calls, bills, unpriced),
    other_invoices: [...byProvider].map(([provider, cents]) => ({ provider, cents })),
  };
}

const SOURCE_LABEL: Record<string, string> = {
  litellm: "LiteLLM spend log",
  "bedrock-invocations": "Bedrock invocation log",
  "bedrock-cur": "AWS FOCUS export",
};

function renderCountedTwice(
  o: WitnessOverlap,
  invoices: AuditReport["other_invoices"],
): string[] {
  const out = ["Counted twice"];
  for (const input of o.inputs) {
    out.push(
      `   ${SOURCE_LABEL[input.source]}: ${formatNumber(input.calls)} calls, ${formatCents(input.cents)}`,
    );
  }
  out.push(
    `   Added up: ${formatCents(o.naive_cents)}. Counted once: ${formatCents(o.counted_cents)}.`,
    `   Counted twice: ${formatCents(o.counted_twice_cents)}`,
  );
  for (const pair of o.by_pair) {
    out.push(
      `      ${pair.sources.join(" + ")}: ${formatNumber(pair.calls)} calls, ${formatCents(pair.cents)}`,
    );
  }
  if (o.by_pair.length === 0 && o.inputs.length > 1) {
    out.push("   No call showed up in more than one input.");
  }
  if (o.inputs.some((i) => i.source === "bedrock-invocations")) {
    out.push(
      "   A gateway row and an invocation-log row for one call are matched only on the response id, so a call without the same id in both counts twice here.",
    );
  }
  if (o.unpriced_calls > 0) {
    out.push(
      `   ${formatNumber(o.unpriced_calls)} invocation-log calls use a model with no price and count as $0.`,
    );
  }
  const bills = [
    ...o.bills.map((b) => `${SOURCE_LABEL[b.source]} ${formatCents(b.cents)}`),
    ...invoices.map((i) => `${i.provider} ${formatCents(i.cents)}`),
  ];
  if (bills.length > 0) {
    out.push(`   Bills, not matched against calls here: ${bills.join(", ")}.`);
  }
  return out;
}

export function renderReport(r: AuditReport): string {
  const parts: string[] = [];
  if (r.audit) {
    parts.push(renderAudit(r.audit, false));
  } else {
    parts.push(
      "TensorCost bill audit\nComputed on this machine from your files. Nothing was sent anywhere.",
    );
  }
  if (r.counted_twice) {
    parts.push(renderCountedTwice(r.counted_twice, r.other_invoices).join("\n"));
  }
  if (!r.audit) parts.push("Questions about these numbers: hello@tensorcost.com");
  parts.push(CONNECT_LINE);
  return parts.join("\n\n");
}

export async function runAudit(argv: string[]): Promise<void> {
  try {
    const args = parseAuditArgs(argv);
    const report = await auditReport(args);
    const body = args.json
      ? JSON.stringify(
          {
            ...(report.audit ?? { source: "local_cli" }),
            ...(report.counted_twice ? { counted_twice: report.counted_twice } : {}),
          },
          null,
          2,
        )
      : renderReport(report);
    process.stdout.write(`${body}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`tensorcost audit: ${message}\n`);
    process.exit(1);
  }
}
