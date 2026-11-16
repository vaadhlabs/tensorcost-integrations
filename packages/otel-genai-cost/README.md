# @tensorcost/otel-genai-cost

Reads an OpenTelemetry GenAI span and returns one call shape: provider, model, input and output tokens, cache read and write tokens, the response id and who made the call. It is the same code TensorCost's inference proxy runs on spans from Kong, LiteLLM and plain OpenTelemetry exporters, published so the mapping can be read, checked and corrected in the open.

It has no runtime dependencies and does not read the network. Input is an OTLP/JSON span, output is a plain object.

```ts
import { mapGenAiSpan, storedInputTokens } from "@tensorcost/otel-genai-cost";

const call = mapGenAiSpan(span);        // null when the span is not an LLM call
call?.provider;                         // "anthropic" | "openai" | "bedrock" | "azure_openai" | "vertex" | null
call?.inputTokens;                      // already adjusted by storedInputTokens
```

Exports: `mapGenAiSpan`, `detectEmitter`, `storedInputTokens`, `spanCorrelationId`, `normalizeProviderName` and the types `GenAiCall`, `GatewayCaller`, `GatewayEmitter`, `GenAiProviderId`, `OtlpSpanLike`, `OtlpAttributeLike`.

## Attributes read

Where a row lists several keys, they are tried in order and the first one present wins, except for the provider, which is described below the table.

| Field | Attribute keys |
| --- | --- |
| provider | `gen_ai.provider.name`, then `gen_ai.system`, then `llm.provider` (first one that names a known provider) |
| model | `gen_ai.request.model`, `gen_ai.response.model`, `llm.model_name` |
| input tokens | `gen_ai.usage.input_tokens`, `llm.token_count.prompt` |
| output tokens | `gen_ai.usage.output_tokens`, `llm.token_count.completion` |
| cache read tokens | `gen_ai.usage.cache_read.input_tokens`, `llm.token_count.prompt_details.cache_read` |
| cache write tokens | `gen_ai.usage.cache_creation.input_tokens`, `llm.token_count.prompt_details.cache_write` |
| response id | `gen_ai.response.id` |
| max tokens | `gen_ai.request.max_tokens` |
| status | `gen_ai.response.status`, then `error.type`; any value other than `success` is an error |
| caller (consumer) | `kong.auth.consumer.name` |
| caller (workspace) | `kong.workspace.name` |
| caller (user) | `user.email` |

The operation is the span name, or `gen_ai.operation.name` when the span has none. Missing token and cache counts are 0.

Provider names are matched case-insensitively against a fixed list: `anthropic`; `openai`; `aws.bedrock`, `bedrock`, `amazon_bedrock` (all `bedrock`); `azure.ai.openai`, `azure.ai.inference`, `azure`, `azure_openai` (all `azure_openai`); `gcp.vertex_ai`, `gcp.gemini`, `gcp.gen_ai`, `vertex_ai`, `vertex` (all `vertex`). The raw value is kept in `providerRaw`.

## Unknown providers and non-LLM spans

The three provider keys are tried in order and the first value that matches the list gives `provider`. `providerRaw` is the first provider value present on the span, matched or not, so `gen_ai.provider.name=foo` with `gen_ai.system=anthropic` gives `provider: "anthropic"` and `providerRaw: "foo"`. If no key matches, `provider` is `null`. It is never replaced with a default vendor, because a guessed vendor prices the call from the wrong rate card. Check `providerRaw` to see what the gateway sent.

A span that is not an LLM call gives `null` from `mapGenAiSpan`. That is any span with no model, and any span with a model but no token usage and no response id, which is a wrapper around the real call and would count the spend twice if kept.

## Token convention

The stored input token count includes cache reads and cache writes. A call that sent 300 uncached input tokens, read 800 tokens from the cache and wrote 100 to it is stored as 1200 input tokens, with `cacheReadTokens` 800 and `cacheWriteTokens` 100 kept alongside.

Emitters do not agree on whether the number on the span already includes the cache, so `storedInputTokens(emitter, provider, reportedInput, cacheRead, cacheWrite)` adds the cache back where it is missing. `mapGenAiSpan` calls it for you.

| Emitter | Reported input | Stored input |
| --- | --- | --- |
| `otel` (OpenTelemetry semconv) | includes cache | as reported |
| `litellm` | includes cache | as reported |
| `kong`, provider `anthropic` | excludes cache (unverified) | reported + cache read + cache write |
| `kong`, any other provider | includes cache | as reported |

The Kong and Anthropic row is unverified. It follows Anthropic's own usage block, which reports the uncached remainder, and has not been checked against a live Kong gateway. If you run one and see otherwise, open an issue.

`detectEmitter` returns `kong` when any attribute starts with `kong.` and `otel` otherwise. LiteLLM spans carry no marker, so pass `"litellm"` to `mapGenAiSpan` yourself.

`spanCorrelationId(traceId, spanId)` returns a UUID-shaped id from both ids. A trace id alone is shared by every call in an agent run.

## Reporting a semconv rename

The OpenTelemetry GenAI conventions are still changing, and attribute names move between releases. If a gateway or SDK sends a name this package does not read, or a rename changes what a field means, open an issue on https://github.com/vaadhlabs/tensorcost-integrations. Include the attribute names, the semconv or gateway version, and one span as OTLP/JSON with prompts and any personal data removed. A pull request that adds the key to the table above and a test is welcome.

## License

Apache-2.0.
