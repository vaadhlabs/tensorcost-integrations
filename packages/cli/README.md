# @tensorcost/cli

Estimate and compare LLM prompt costs from the command line. Works offline with a bundled seed catalogue; when online, refreshes from TensorCost's public CloudFront snapshot (no API key required).

```
npx @tensorcost/cli estimate --prompt-file prompts/rerank.v3.txt \
                              --model anthropic/claude-3-5-sonnet
Estimated cost : $0.0042 / call
Input tokens   : 1,420
Output tokens  : 284
At 1,000 calls/day: $126.00/month
```

```
npx @tensorcost/cli compare \
      --baseline-file prompts/rerank.v2.txt \
      --candidate-file prompts/rerank.v3.txt \
      --model anthropic/claude-3-5-sonnet
baseline → candidate:
  Input tokens : 1,280 → 1,420  (+10.9%)
  Cost/call    : $0.0038 → $0.0042  (+10.9%)
  Verdict      : candidate is 10.9% more expensive per call.
```

## Installation

```bash
npm install -g @tensorcost/cli
# or run without installing:
npx @tensorcost/cli <subcommand>
```

Both `tensorcost` and `tc` are registered as binary names, so after a global install you can use either:

```bash
tensorcost estimate --prompt "Hello" --model openai/gpt-4o
tc estimate --prompt "Hello" --model openai/gpt-4o
```

## Commands

### `estimate`

Estimate the cost of a single prompt invocation.

| Flag | Description |
|------|-------------|
| `--prompt <text>` | Inline prompt text |
| `--prompt-file <path>` | Path to a prompt file |
| `--model <id>` | Model identifier — see `tensorcost models` |
| `--provider <name>` | Estimate the same prompt across all models for a provider (e.g. `anthropic`) |
| `--expected-output-tokens <n>` | Override output token estimate (default: `max(64, input/5)`) |
| `--calls-per-day <n>` | Also print a monthly cost projection |
| `--json` | Output machine-readable JSON |

```bash
tensorcost estimate \
  --prompt "Summarize the following document in three bullet points." \
  --model anthropic/claude-3-haiku \
  --calls-per-day 5000
```

Compare every Anthropic model (direct API + Bedrock + Vertex + OpenRouter) for the same prompt:

```bash
tensorcost estimate \
  --provider anthropic \
  --tier latest \
  --prompt "Hello world" \
  --calls-per-day 5000
```

List all Bedrock-hosted models:

```bash
tensorcost models --provider bedrock
```

Deprecated models (claude-2, claude-instant) are hidden by default; pass `--include-legacy` to show them.

`tensorcost models` lists **list prices** in dollars per **million** tokens (`$/M`), not per-call cost. Use `estimate` to see what a specific prompt actually costs. The live catalogue is refreshed daily from TensorCost pricing plus LiteLLM gap-fill (~2,500+ models including Bedrock, Azure, Vertex, Groq, etc.).

### `compare`

Compare cost between a baseline and a candidate prompt.

| Flag | Description |
|------|-------------|
| `--baseline <text>` / `--baseline-file <path>` | Baseline prompt |
| `--candidate <text>` / `--candidate-file <path>` | Candidate prompt |
| `--model <id>` | Model identifier (required) |
| `--expected-output-tokens <n>` | Override output token estimate for both sides |
| `--json` | Output machine-readable JSON |

```bash
tensorcost compare \
  --baseline-file prompts/v1.txt \
  --candidate-file prompts/v2.txt \
  --model openai/gpt-4o \
  --json
```

### `models`

List models from the live catalogue (or the offline seed) and their input/output rates.

| Flag | Description |
|------|-------------|
| `--provider <name>` | Filter by provider (`openai`, `anthropic`, `bedrock`, `azure`, `vertex`, …) |
| `--json` | Output the full catalogue as JSON |

```bash
tensorcost models
tensorcost models --provider openai
tensorcost models --json
```

## Model catalogue

The CLI does **not** hardcode the full provider catalogue. On each run it:

1. Starts from a small bundled seed (`models.json`) so offline / CI works with zero network.
2. Merges the daily CloudFront snapshot at `https://console.tensorcost.com/cli/model-rates.json` (TensorCost's own rates, with LiteLLM's catalogue filling the gaps), cached for 1 hour at `~/.tensorcost/rates-cache.json`.

Use full ids (`openai/gpt-4o`). Bare slugs (`gpt-4o`) resolve when unique; if several providers match, the CLI lists the candidates and exits.

Run `tensorcost models` (or `tensorcost models --provider anthropic`) to see what is currently known.

## Environment variables

| Variable | Description |
|----------|-------------|
| `TENSORCOST_CATALOG_URL` | Override the catalogue URL. Defaults to `https://console.tensorcost.com/cli/model-rates.json`. Point at staging with `https://console.<env>.tensorcost.com/cli/model-rates.json`. |
| `TENSORCOST_OFFLINE` | Set to `1` / `true` to skip the network fetch and use the bundled seed (plus any on-disk cache). |

### Live rates

No API key is required for rates — the snapshot is public list pricing. Any model in the live response takes precedence over the bundled seed. On network / HTML / schema errors the CLI proceeds silently with the bundled table (and a stale cache when present).

## Tokenization

Token counts are estimated using `ceil(charCount / 4)`, which is accurate to within ~10% for typical English text. If `tiktoken` or `@anthropic-ai/tokenizer` is installed in the same environment, the CLI will use it automatically — no configuration needed.

## JSON output

Both `estimate` and `compare` accept `--json` for CI / scripting:

```bash
result=$(tensorcost estimate --prompt-file prompt.txt --model openai/gpt-4o --json)
total=$(echo "$result" | jq '.totalCostUsd')
```

## PR review workflow

```makefile
# Makefile target — compare your branch's prompt against main
.PHONY: cost-check
cost-check:
	tensorcost compare \
	  --baseline-file $(shell git show main:$(PROMPT)) \
	  --candidate-file $(PROMPT) \
	  --model $(MODEL)
```
