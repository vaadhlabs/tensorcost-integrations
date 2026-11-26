#!/usr/bin/env node
/**
 * tensorcost CLI — estimate and compare LLM prompt costs from the command line.
 *
 * Usage:
 *   tensorcost estimate --prompt-file <path> --model <id>
 *   tensorcost compare  --baseline-file <path> --candidate-file <path> --model <id>
 *   tensorcost models
 *   tensorcost --version
 */

import { runEstimate } from "./commands/estimate.js";
import { runCompare } from "./commands/compare.js";
import { runModels } from "./commands/models.js";
import { loadModelRates } from "./pricing.js";

const VERSION = "0.3.0";

// Piped output (e.g. `tc models | head`) closes stdout early; ignore EPIPE.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});

const HELP = `
tensorcost (alias: tc) <subcommand> [options]

Subcommands:
  estimate    Estimate cost for a single prompt or all models in a provider
  compare     Compare cost between a baseline and a candidate prompt
  models      List known models and their current rates

Global flags:
  --json      Output machine-readable JSON instead of human-readable text
  --version   Print version and exit
  --help      Show this help

estimate options:
  --prompt <text>                  Inline prompt text (alias: --text)
  --prompt-file <path>             Path to a prompt file
  --model <id>                     Model identifier — see \`tensorcost models\`
  --provider <name>                Estimate the same prompt across all models for a provider
  --tier latest                    Only current-generation models (Claude 3.5+/4.x, GPT-4o+, Nova, …)
  --include-legacy                 Include deprecated models (claude-2, claude-instant, …)
  --expected-output-tokens <n>     Override output token count (default: max(64, input/5))
  --calls-per-day <n>              Also print a monthly cost projection

compare options:
  --baseline <text>                Inline baseline prompt
  --baseline-file <path>           Path to baseline prompt file
  --candidate <text>               Inline candidate prompt
  --candidate-file <path>          Path to candidate prompt file
  --model <id>                     Model identifier (required)
  --expected-output-tokens <n>     Override output token count for both sides

models options:
  --provider <name>                Filter by provider (includes hosted variants for anthropic/openai)
  --tier latest                    Only current-generation models
  --include-legacy                 Include deprecated models (claude-2, claude-instant, …)
  --json                           Output the full catalogue as JSON
`.trim();

function parseArgv(argv: string[]): {
  subcommand: string | null;
  flags: Record<string, string | boolean>;
} {
  const args = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  let subcommand: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (!arg.startsWith("-")) {
      if (subcommand === null) subcommand = arg;
      continue;
    }

    // Normalize --foo-bar to fooBar for flag lookup
    const key = arg.replace(/^-+/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { subcommand, flags };
}

function tierFlag(flags: Record<string, string | boolean>): "latest" | undefined {
  return flags["tier"] === "latest" ? "latest" : undefined;
}

async function main(): Promise<void> {
  const { subcommand, flags } = parseArgv(process.argv);

  if (flags["version"] === true || flags["v"] === true) {
    process.stdout.write(`tensorcost/${VERSION}\n`);
    process.exit(0);
  }

  if (flags["help"] === true || flags["h"] === true || subcommand === null) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  // Merge live/cached rates into the in-process pricing map before dispatching
  // the subcommand. Falls back silently on missing key / network / fs errors,
  // so offline use is never affected.
  await loadModelRates();

  const json = flags["json"] === true;

  switch (subcommand) {
    case "estimate": {
      const promptText =
        typeof flags["prompt"] === "string"
          ? flags["prompt"]
          : typeof flags["text"] === "string"
            ? flags["text"]
            : undefined;
      await runEstimate({
        prompt: promptText,
        promptFile: typeof flags["promptFile"] === "string" ? flags["promptFile"] : undefined,
        model: typeof flags["model"] === "string" ? flags["model"] : undefined,
        provider: typeof flags["provider"] === "string" ? flags["provider"] : undefined,
        includeLegacy: flags["includeLegacy"] === true,
        tier: tierFlag(flags),
        expectedOutputTokens:
          typeof flags["expectedOutputTokens"] === "string"
            ? parseInt(flags["expectedOutputTokens"], 10)
            : undefined,
        callsPerDay:
          typeof flags["callsPerDay"] === "string"
            ? parseInt(flags["callsPerDay"], 10)
            : undefined,
        json,
      });
      break;
    }

    case "compare": {
      await runCompare({
        baseline: typeof flags["baseline"] === "string" ? flags["baseline"] : undefined,
        baselineFile: typeof flags["baselineFile"] === "string" ? flags["baselineFile"] : undefined,
        candidate: typeof flags["candidate"] === "string" ? flags["candidate"] : undefined,
        candidateFile:
          typeof flags["candidateFile"] === "string" ? flags["candidateFile"] : undefined,
        model: typeof flags["model"] === "string" ? flags["model"] : "",
        expectedOutputTokens:
          typeof flags["expectedOutputTokens"] === "string"
            ? parseInt(flags["expectedOutputTokens"], 10)
            : undefined,
        json,
      });
      break;
    }

    case "models": {
      runModels({
        json,
        provider:
          typeof flags["provider"] === "string" ? flags["provider"] : undefined,
        includeLegacy: flags["includeLegacy"] === true,
        tier: tierFlag(flags),
      });
      break;
    }

    default: {
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${HELP}\n`);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`tensorcost: unexpected error: ${msg}\n`);
  process.exit(1);
});
