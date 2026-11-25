# Changelog

All notable changes to `@tensorcost/cli` are documented here.

## [Unreleased]

### Changed

- The published package is a single bundled `dist/index.js`, still with no runtime dependencies.
- `--help` and `--version` no longer load the rate catalogue first.

## [0.2.7] — 2026-08-14

### Added

- `--tier latest` on `models` and `estimate` — current-generation families only (Claude 3.5+/4.x, GPT-4o+, Nova, Gemini 2.x, …).

## [0.2.6] — 2026-08-14

### Added

- `--include-legacy` on `models` and `estimate` to show deprecated rows (claude-2, claude-instant).
- Provider scopes: `--provider anthropic` includes Bedrock, Vertex, and OpenRouter Claude models; `--provider openai` includes Azure OpenAI and OpenRouter.
- Regional Bedrock dedupe (drops `us.`/`eu.` rows when the global id exists).

### Changed

- Legacy models hidden by default in provider listings and estimates.

## [0.2.5] — 2026-08-14

### Added

- `estimate --provider <name>` — compare per-call (and optional monthly) cost for the same prompt across all models in a provider. Versioned LiteLLM duplicates are deduplicated when a friendly alias exists.

## [0.2.4] — 2026-08-14

### Fixed

- Restore bundled friendly model ids (e.g. `anthropic/claude-3-haiku`) after a live catalogue fetch by mapping them to the newest matching versioned LiteLLM row.

## [0.2.3] — 2026-08-14

### Fixed

- Exit cleanly when stdout is closed early (e.g. `tc models | head`) instead of crashing with `EPIPE`.

## [0.2.2] — 2026-08-14

### Fixed

- Rates disk cache is keyed by catalogue URL so stale or test caches no longer wipe the model list when switching environments.
- Legacy cache entries without `catalog_url` are ignored and refreshed from the network.

### Added

- `estimate --text` as an alias for `--prompt`.

## [0.2.1] — 2026-08-14

### Added

- Live model catalogue from CloudFront (`/cli/model-rates.json`) with 1-hour disk cache; bundled `models.json` remains offline fallback.
- `TENSORCOST_CATALOG_URL` and `TENSORCOST_INSTANCE`-aware default console URL.
- `TENSORCOST_OFFLINE=1` to skip network fetch.
- `models --provider <prefix>` filter.
- Bare-slug model resolution with ambiguous-model errors on `estimate` / `compare`.

### Changed

- Successful catalogue fetch replaces bundled rates (avoids stale alias rows).
- Requires catalogue `schema_version: 2`.

## [0.1.0] — 2026-05-28

Initial release.

### Added

- `tensorcost estimate` — estimate input/output token counts and total cost for a prompt. Accepts `--prompt` or `--prompt-file`, requires `--model`, supports `--expected-output-tokens` and `--calls-per-day` for a monthly projection.
- `tensorcost compare` — side-by-side diff of baseline vs. candidate prompts, reporting token and cost delta with a one-line verdict.
- `tensorcost models` — list all bundled models with current input/output rates.
- `--json` flag on `estimate` and `compare` for machine-readable output (CI / PR-review-bot integration).
- Offline pricing table (`src/pricing/models.json`) covering 10 models across Anthropic direct, OpenAI, and AWS Bedrock. Rates sourced from provider public pricing pages 2026-05-28.
- Heuristic tokenizer (`ceil(charCount / 4)`) with optional real-tokenizer fallback via dynamic import of `tiktoken` or `@anthropic-ai/tokenizer` — neither is a hard dependency.
