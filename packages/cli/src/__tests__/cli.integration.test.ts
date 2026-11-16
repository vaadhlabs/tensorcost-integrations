/**
 * Integration tests — these spawn the built `dist/index.js` binary and assert
 * on stdout/stderr/exit-code. They require a prior `pnpm build` to produce
 * dist/index.js, so they are excluded from the default `pnpm test` run and
 * only execute when INTEGRATION=1 (or via `pnpm test:integration`).
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Two levels up from src/__tests__/ → packages/cli/
const DIST_INDEX = resolve(__dirname, "../../dist/index.js");

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnCli(args: string[]): SpawnResult {
  const result = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      // Keep integration tests deterministic — bundled models.json only.
      TENSORCOST_OFFLINE: "1",
    },
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("estimate subcommand", () => {
  it("outputs JSON cost estimate for an inline prompt with a known model", () => {
    const { stdout, exitCode } = spawnCli([
      "estimate",
      "--prompt", "Hello world",
      "--model", "anthropic/claude-3-5-sonnet",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed["model"]).toBe("anthropic/claude-3-5-sonnet");
    expect(typeof parsed["inputTokens"]).toBe("number");
    expect(typeof parsed["outputTokens"]).toBe("number");
    expect(typeof parsed["totalCostUsd"]).toBe("number");
    expect(parsed["totalCostUsd"] as number).toBeGreaterThan(0);
  });

  it("outputs human-readable text without --json", () => {
    const { stdout, exitCode } = spawnCli([
      "estimate",
      "--prompt", "Summarize this document.",
      "--model", "openai/gpt-4o",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Estimated cost/);
    expect(stdout).toMatch(/Input tokens/);
    expect(stdout).toMatch(/Output tokens/);
  });

  it("exits 1 and writes to stderr for an unknown model", () => {
    const { stdout, stderr, exitCode } = spawnCli([
      "estimate",
      "--prompt", "test",
      "--model", "fake/model-9000",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown model/);
    expect(stdout).toBe("");
  });

  it("reads from a --prompt-file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tc-int-test-"));
    const filePath = join(tmpDir, "prompt.txt");
    writeFileSync(filePath, "A".repeat(4000), "utf8");

    const { stdout, exitCode } = spawnCli([
      "estimate",
      "--prompt-file", filePath,
      "--model", "openai/gpt-4o",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    // 4000 chars → ceil(4000/4) = 1000 input tokens
    expect(parsed["inputTokens"]).toBe(1000);
  });

  it("exits 1 for a missing --prompt-file", () => {
    const { exitCode, stderr } = spawnCli([
      "estimate",
      "--prompt-file", "/nonexistent/path/to/prompt.txt",
      "--model", "openai/gpt-4o",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/cannot read file/);
  });
});

describe("models subcommand", () => {
  it("outputs a human-readable table with at least 25 rows", () => {
    const { stdout, exitCode } = spawnCli(["models"]);

    expect(exitCode).toBe(0);
    // Each model occupies one line; count lines that look like table rows
    // (start with an id that contains a slash, e.g. "anthropic/..." or "openai/...")
    const rows = stdout.split("\n").filter((line) => /^[a-z_]+\/\S+/.test(line.trim()));
    expect(rows.length).toBeGreaterThanOrEqual(25);
  });

  it("--json outputs a JSON array with at least 25 elements", () => {
    const { stdout, exitCode } = spawnCli(["models", "--json"]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(25);

    // Spot-check shape of first element
    const first = parsed[0] as Record<string, unknown>;
    expect(typeof first["id"]).toBe("string");
    expect(typeof first["display_name"]).toBe("string");
    expect(typeof first["input_per_million_usd"]).toBe("number");
    expect(typeof first["output_per_million_usd"]).toBe("number");
  });
});

describe("compare subcommand", () => {
  it("outputs a human-readable verdict comparing two inline prompts", () => {
    const { stdout, exitCode } = spawnCli([
      "compare",
      "--baseline", "A".repeat(4000),
      "--candidate", "A".repeat(5000),
      "--model", "anthropic/claude-3-5-sonnet",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/baseline → candidate/);
    expect(stdout).toMatch(/Verdict/);
    expect(stdout).toMatch(/more expensive|cheaper|No meaningful/);
  });

  it("--json produces a valid comparison object", () => {
    const { stdout, exitCode } = spawnCli([
      "compare",
      "--baseline", "Hello world",
      "--candidate", "Hello world and more text here",
      "--model", "openai/gpt-4o",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed["model"]).toBe("openai/gpt-4o");
    expect(typeof parsed["costDelta"]).toBe("number");
    expect(typeof parsed["inputTokensDelta"]).toBe("number");

    const baseline = parsed["baseline"] as Record<string, unknown>;
    const candidate = parsed["candidate"] as Record<string, unknown>;
    expect(typeof baseline["totalCostUsd"]).toBe("number");
    expect(typeof candidate["totalCostUsd"]).toBe("number");
    // candidate is longer, so cost delta should be non-negative
    expect(parsed["costDelta"] as number).toBeGreaterThanOrEqual(0);
  });

  it("exits 1 when --baseline-file is missing", () => {
    const { exitCode, stderr } = spawnCli([
      "compare",
      "--baseline-file", "/nonexistent/baseline.txt",
      "--candidate", "test",
      "--model", "openai/gpt-4o",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/cannot read file/);
  });
});

describe("--version flag", () => {
  it("prints the current version and exits 0", () => {
    const { stdout, exitCode } = spawnCli(["--version"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^tensorcost\/0\.\d+\.\d+/);
  });
});

describe("audit subcommand", () => {
  function fixture(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tc-audit-"));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }
  const usage = "cost,run_id,team\n40,r1,search\n10,,\n";

  it("prints the five numbers from a file and an invoice", () => {
    const { stdout, exitCode } = spawnCli([
      "audit",
      fixture("usage.csv", usage),
      "--invoice",
      fixture("invoice.csv", "vendor,amount\nOpenAI,75\n"),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("1. The run your cap did not see");
    expect(stdout).toContain("5. Cost per attempt");
    expect(stdout).toMatch(/invoice is \$25\.00 higher/i);
  });

  it("emits JSON marked as a local run", () => {
    const { stdout, exitCode } = spawnCli([
      "audit",
      "--json",
      fixture("usage.csv", usage),
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).source).toBe("local_cli");
  });

  it("exits 1 with a message for a file that isn't there", () => {
    const { stderr, exitCode } = spawnCli(["audit", "/no/such/file.csv"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("/no/such/file.csv");
  });

  describe("network", () => {
    const TRIPWIRE = resolve(__dirname, "no-network.cjs");

    // No TENSORCOST_OFFLINE, and an empty HOME so no cached catalogue short-cuts
    // the fetch: exactly the conditions a first-time npx user runs under.
    function spawnWatched(args: string[]): SpawnResult {
      const { TENSORCOST_OFFLINE: _offline, ...env } = process.env;
      const result = spawnSync(
        process.execPath,
        ["--require", TRIPWIRE, DIST_INDEX, ...args],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...env, HOME: mkdtempSync(join(tmpdir(), "tc-home-")) },
        },
      );
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? 1,
      };
    }

    it("the tripwire fires on a command that does use the network", () => {
      const { stderr, exitCode } = spawnWatched(["models"]);
      expect(exitCode).toBe(99);
      expect(stderr).toContain("NETWORK_ATTEMPT");
    });

    it("audit of a gateway log and a bill never reaches for the network", () => {
      const { stdout, stderr, exitCode } = spawnWatched([
        "audit",
        "--export",
        `litellm=${fixture(
          "spend.csv",
          "request_id,id,model,spend,prompt_tokens,completion_tokens,startTime\nr1,a,gpt-4o,0.02,10,5,2026-11-10T12:00:00Z\n",
        )}`,
        "--export",
        `bedrock-cur=${fixture("focus.csv", "ServiceName,BilledCost\nAmazon Bedrock,1.00\n")}`,
      ]);
      expect(stderr).not.toContain("NETWORK_ATTEMPT");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Counted twice");
    });

    it("audit never reaches for the network", () => {
      const { stderr, exitCode } = spawnWatched([
        "audit",
        fixture("usage.csv", usage),
      ]);
      expect(stderr).not.toContain("NETWORK_ATTEMPT");
      expect(exitCode).toBe(0);
    });
  });
});
