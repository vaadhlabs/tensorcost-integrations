# @tensorcost/cli

Estimate and compare LLM prompt costs from the command line, and audit an AI bill on your own machine. Works offline with a bundled seed catalogue; when online, refreshes from TensorCost's public CloudFront snapshot (no API key required). `audit` never goes online.

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

### `audit`

Reads a usage export and your invoice total, and prints five numbers a provider's spend cap and dashboard don't show. **It runs on your machine and your files go nowhere.** It makes no network calls, with one exception: pricing a Bedrock invocation log fetches TensorCost's public price catalogue (set `TENSORCOST_OFFLINE=1` to use the bundled prices instead). The test suite runs the built binary with a trap on every network call to hold it to that.

```bash
npx @tensorcost/cli audit usage.csv --invoice invoice.csv
```

The five numbers:

1. **The run your cap did not see:** the largest single run, and its share of spend.
2. **Spend with no owner:** spend that can't be tied to a person, agent or run.
3. **Price paid, not list:** the invoice against the usage export.
4. **Capitalisation-ready share (estimate):** spend carrying a project, team or cost-centre tag. Not tax or accounting advice.
5. **Cost per attempt:** per agent, when the export has an agent id.

When an export names people, the audit also lists spend by tool and by person.

| Flag | Description |
|------|-------------|
| `<usage-export>` | The export to audit. Repeat for several. `name=path` names the provider, for example `openai=usage.csv` |
| `--invoice [name=]<file-or-amount>` | Invoice total, as an amount or a text/CSV file. PDFs aren't read, so pass the total. Repeat to add up several invoices for one provider |
| `--window 30\|90` | Days the export covers, recorded in `--json` (default 90). It doesn't filter the file |
| `--json` | Output the full audit as JSON |

```bash
tensorcost audit openai=openai.csv anthropic=anthropic.csv \
  --invoice openai=1842.00 --invoice anthropic=invoice.csv
```

**Counted twice**

One call can sit in a gateway log, a provider export and a bill. Name those inputs and the audit shows the dollars that appear in more than one, by pair of inputs, with the total counted once next to the total added up:

```bash
tensorcost audit \
  --export litellm=spendlogs.csv \
  --export bedrock-invocations=invocations.jsonl \
  --export bedrock-cur=focus.csv \
  --invoice anthropic=1234.56
```

| Input | What it is |
|-------|------------|
| `litellm` | LiteLLM spend-log CSV. Calls are matched on its `id` column, the provider's response id |
| `bedrock-invocations` | Bedrock's model invocation log, JSON lines. Calls are matched on `requestId` and priced from the catalogue (cache reads aren't priced) |
| `bedrock-cur` | AWS FOCUS export as CSV (`BilledCost`, Bedrock rows). Parquet isn't read. Listed as a bill, not matched against calls |

Two rows are one call when they share a provider response id. A gateway row and an invocation-log row for one call are matched only that way. Bills, and invoices given with `--invoice`, are listed beside the calls and not netted against them.

**What it reads**

| Export | Where it comes from | Cost shown | People | Runs |
|--------|---------------------|------------|--------|------|
| Any usage CSV | Your provider. Needs a cost or credits column; `run_id`/`session_id`, `agent_id` and `project`/`team`/`cost_center` columns are used when present | As exported | No | Yes, if present |
| GitHub Copilot | The **AI usage report** from your billing settings | Billed (`net_amount`) | Yes | No |
| Claude Team or Enterprise | **Export spend report** in the analytics dashboard | Billed (`total_net_spend_usd`) | Yes | No |
| Claude Code on a Console org | Saved JSON from `GET /v1/organizations/usage_report/claude_code` | **Estimated** at list price | Yes | No |
| Cursor | Saved JSON from the Admin API, `POST /teams/filtered-usage-events` or `POST /teams/spend` | Billed (`chargedCents`, `spendCents`) | Yes | `conversationId`, events only |

The Claude Code endpoint returns one day per call and Cursor's returns pages. Save each response on its own line in one file, or as a JSON array of responses, and the audit reads them all.

Cursor's dashboard CSV isn't read, because its columns aren't documented. GitHub's docs list the report's fields without naming the file format or the currency of the amounts; the audit assumes CSV and USD. The file's dates aren't checked against your invoice, so compare the same period.

GitHub reports usernames and the other vendors report emails, so one person using Copilot and Cursor appears twice. Nothing in the files links the two, and the audit doesn't guess.

## Model catalogue

The CLI does **not** hardcode the full provider catalogue. On each run it:

1. Starts from a small bundled seed (`models.json`) so offline / CI works with zero network.
2. Merges the daily CloudFront snapshot at `https://console.tensorcost.com/cli/model-rates.json` (TensorCost `ai.model_pricing` + LiteLLM gap-fill), cached for 1 hour at `~/.tensorcost/rates-cache.json`.

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
