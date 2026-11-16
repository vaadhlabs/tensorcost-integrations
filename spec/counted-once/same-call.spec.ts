// Runs in the public repository against ../../packages/contracts/src/same-call.ts and
// same-call.cases.ts, which the export copies there from TensorCost's packages/contracts. The
// monorepo runs this file from an export too, so a copy that drifts fails.
import { describe, expect, it } from "vitest";
import { SAME_CALL_CASES, sameCallCaseId } from "../../packages/contracts/src/same-call.cases.js";
import {
  SAME_CALL_FINGERPRINT_FN,
  SAME_CALL_FINGERPRINT_FN_SQL,
  SAME_CALL_RESPONSE_ID_FN,
  SAME_CALL_RESPONSE_ID_FN_SQL,
  aiRowSameCallSql,
  meteringSourceRankSql,
  sameCallRowOf,
  sameCallSurvivors,
} from "../../packages/contracts/src/same-call.js";

const rowsOf = (c: (typeof SAME_CALL_CASES)[number]) =>
  c.rows.map((r, i) => ({ ...sameCallRowOf({ ...r, id: sameCallCaseId(i) }), key: r.key }));

describe("sameCallSurvivors over the shared cases", () => {
  it("has cases to run", () => {
    expect(SAME_CALL_CASES.length).toBeGreaterThan(10);
  });

  for (const c of SAME_CALL_CASES) {
    it(c.name, () => {
      expect(sameCallSurvivors(rowsOf(c)).map((r) => r.key).sort()).toEqual([...c.survivors].sort());
    });
  }

  it("keeps the input order of the survivors and never rewrites a row", () => {
    const rows = rowsOf(SAME_CALL_CASES[4]!);
    const before = JSON.stringify(rows);
    const out = sameCallSurvivors(rows);
    expect(out.map((r) => r.id)).toEqual(rows.filter((r) => out.includes(r)).map((r) => r.id));
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("sameCallRowOf", () => {
  it("ranks the proxy, the SDK, a gateway and everything else 0 to 3", () => {
    const base = { id: "x", provider: "anthropic", input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, started_at: "2026-11-10T00:00:00Z", total_cost_cents: 10 };
    const rank = (source: string, metadata: object) => sameCallRowOf({ ...base, source, metadata }).source_rank;
    expect(rank("provider_api", { source: "applied-mode-proxy" })).toBe(0);
    expect(rank("provider_api", { source: "tier2-sdk" })).toBe(1);
    expect(rank("provider_api", { source: "tier2-sdk", gateway_source: "kong" })).toBe(2);
    expect(rank("raw_log", {})).toBe(3);
  });
});

describe("the SQL reference", () => {
  it("is a predicate over two functions, with the row's columns qualified by an alias", () => {
    const sql = aiRowSameCallSql("e.");
    expect(sql).toContain(`NOT ${SAME_CALL_RESPONSE_ID_FN}(`);
    expect(sql).toContain(`NOT ${SAME_CALL_FINGERPRINT_FN}(`);
    expect(sql).toContain(meteringSourceRankSql("e."));
    for (const fn of [SAME_CALL_RESPONSE_ID_FN_SQL, SAME_CALL_FINGERPRINT_FN_SQL]) {
      expect(fn).toContain("CREATE OR REPLACE FUNCTION");
    }
  });
});
