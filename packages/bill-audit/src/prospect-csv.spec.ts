import { describe, expect, it } from "vitest";
import {
  parseProspectUsageCsv,
  parseInvoiceTotalUsd,
  ProspectCsvParseError,
} from "./prospect-csv.js";

describe("parseProspectUsageCsv", () => {
  it("throws when no cost or credits column", () => {
    expect(() =>
      parseProspectUsageCsv("date,model\n2026-01-01,gpt-4\n"),
    ).toThrow(ProspectCsvParseError);
  });

  it("parses quoted commas", () => {
    const out = parseProspectUsageCsv(
      'workflow_id,cost\nrun-1,"1,234.56"\n',
    );
    expect(out.total_cents).toBe(123_456);
    expect(out.rows[0]?.workflow_id).toBe("run-1");
  });

  it("does not treat api_key_id as run owner for unowned math (builder)", () => {
    const out = parseProspectUsageCsv(
      "api_key_id,cost\nsk-abc,10\n",
    );
    expect(out.rows[0]?.workflow_id).toBeNull();
    expect(out.rows[0]?.agent_id).toBeNull();
  });

  it("strips UTF-8 BOM from header row", () => {
    const out = parseProspectUsageCsv("\uFEFFcost\n10\n");
    expect(out.total_cents).toBe(1000);
  });

  it("skips Total summary rows", () => {
    const out = parseProspectUsageCsv("cost\n10\nTotal,99\n");
    expect(out.total_cents).toBe(1000);
  });

  it("keeps credit rows whose dollar cell is blank", () => {
    const out = parseProspectUsageCsv("run_id,credits_used,cost\nr1,500,\nr2,120,0\n");
    expect(out.rows.map((r) => r.credits)).toEqual([500, 120]);
    expect(out.total_credits).toBe(620);
    expect(out.total_cents).toBe(0);
  });

  it("keeps dollar rows whose credit cell is blank", () => {
    const out = parseProspectUsageCsv("credits_used,cost\n,12.50\n");
    expect(out.rows).toHaveLength(1);
    expect(out.total_cents).toBe(1250);
  });

  it("sums credits_used column", () => {
    const out = parseProspectUsageCsv("credits_used,cost\n50,0\n50,0\n");
    expect(out.credit_denominated).toBe(true);
    expect(out.total_credits).toBe(100);
  });
});

describe("parseInvoiceTotalUsd", () => {
  it("parses plain dollar string", () => {
    expect(parseInvoiceTotalUsd("$1,842.00")).toBe(1842);
  });

  it("rejects zero", () => {
    expect(parseInvoiceTotalUsd("0")).toBeNull();
  });

  it("reads a dollar string with a currency word", () => {
    expect(parseInvoiceTotalUsd("USD 1,842.00")).toBe(1842);
  });

  it("does not run a CSV's digits together into one number", () => {
    expect(
      parseInvoiceTotalUsd("vendor,amount\nOpenAI,100\nTotal,100\n"),
    ).toBe(100);
  });

  it("sums the lines of a multi-row invoice CSV", () => {
    expect(
      parseInvoiceTotalUsd("vendor,amount\nOpenAI,100\nAzure,50.50\n"),
    ).toBe(150.5);
  });

  it("returns null for prose rather than guessing from its digits", () => {
    expect(parseInvoiceTotalUsd("Invoice 2026 for 3 seats")).toBeNull();
  });
});
