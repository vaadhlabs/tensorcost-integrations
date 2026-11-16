import { describe, expect, it } from "vitest";
import * as fixtures from "./trust-sample.fixtures.js";

/**
 * The fixtures ship in the public repo. They must hold no tenant name and no
 * AWS account id. The patterns are the export script's deny list.
 */
describe("trust-sample fixtures", () => {
  const strings = Object.entries(fixtures).filter(
    (e): e is [string, string] => typeof e[1] === "string",
  );

  it("exports the sample CSVs", () => {
    expect(strings.length).toBeGreaterThan(0);
  });

  it.each(strings)("%s names no tenant and holds no 12-digit account id", (_name, body) => {
    expect(body).not.toMatch(/zelvora|tensorcost-dev|\.internal\./i);
    expect(body).not.toMatch(/\b\d{12}\b/);
  });
});
