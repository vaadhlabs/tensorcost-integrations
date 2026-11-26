import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// --version prints a constant in src/index.ts; a release that bumps
// package.json without it would print the old version.
describe("the CLI's version", () => {
  it("is package.json's version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(/const VERSION = "([^"]+)";/.exec(src)?.[1]).toBe(pkg.version);
  });
});
