# TensorCost for Kong

Kong Gateway's OpenTelemetry plugin can send the spans of every AI call it
proxies to TensorCost. Each LLM span becomes one spend row: its provider,
model, tokens and response id, priced by TensorCost, and the Kong consumer
that made the call. There is nothing to install in Kong. You configure two
bundled plugins and turn tracing on.

TensorCost reads traces only. It doesn't read Kong's metrics export, since a
metric point names no single call and can't be counted once against the
other records of the same call.

## Before you start

- Kong Gateway with the AI Proxy (or AI Proxy Advanced) plugin in front of
  your model calls.
- A Kong gateway connection in TensorCost (Connect › Gateways, kind Kong). It
  gives you a key, `tcgw_...`, once. If you run more than one Kong workspace,
  give the connection the workspace as its instance.

## 1. The OpenTelemetry plugin

Add the plugin globally, or to the services and routes that carry AI traffic.
As decK YAML:

```yaml
plugins:
  - name: opentelemetry
    config:
      traces_endpoint: https://<your TensorCost API host>/v1/traces
      headers:
        Authorization: "Bearer YOUR_TENSORCOST_GATEWAY_KEY"
      sampling_rate: 1.0
```

Or with the Admin API:

```sh
curl -X POST http://localhost:8001/plugins \
  --data name=opentelemetry \
  --data config.traces_endpoint=https://<your TensorCost API host>/v1/traces \
  --data "config.headers.Authorization=Bearer $TENSORCOST_GATEWAY_KEY" \
  --data config.sampling_rate=1.0
```

Replace `YOUR_TENSORCOST_GATEWAY_KEY` with the connection's key. The key is
the plugin's only credential: TensorCost takes it on `/v1/traces` without an
exchange step, because the plugin can only send a fixed header. It works on no
other TensorCost route except `/v1/gateway/*`.

The sampling rate must be 1.0. A trace that isn't sampled never reaches
TensorCost, and its call's spend is never counted.

The plugin sends OTLP over HTTP as protobuf, which TensorCost reads.
TensorCost also reads OTLP JSON on the same route, for a collector in
between.

TensorCost's edge refuses a request with no `User-Agent` header. The plugin
sends one without being asked: its HTTP client, lua-resty-http, adds its own
(`lua-resty-http/<version> (Lua) ngx_lua/<version>`) to any request that has
none. To have TensorCost's logs name the source plainly, add one to the
plugin's headers, which take precedence:

```yaml
      headers:
        Authorization: "Bearer YOUR_TENSORCOST_GATEWAY_KEY"
        User-Agent: "TensorCost-Kong/1.0.0"
```

Send Kong's spans to TensorCost once, on `/v1/traces` with the gateway key.
A Kong that also exports to TensorCost's SDK OTLP route, or through a
collector that forwards to both, stores each call twice under the same
source, and the two rows pair only when the span carries the provider's
response id.

## Batch size

One request may carry at most 500 AI calls (LLM spans), the same as a log
push, and at most 10,000 spans, 128 attributes a span, 100,000 attributes
and 1,000 resource spans in all. A request past any of these is answered
413 with the limit named, and nothing in it is stored.

Kong's plugin sends batches of 200 spans by default
(`queue.max_batch_size`); keep it at 500 or below. An OpenTelemetry
Collector between Kong and TensorCost batches 8,192 spans by default, with
no upper bound, so cap its batch processor:

```yaml
processors:
  batch:
    send_batch_size: 500
    send_batch_max_size: 500
```

## 2. AI Proxy statistics

Token counts are on the span only when AI Proxy logs its statistics. In each
`ai-proxy` or `ai-proxy-advanced` plugin's config:

```yaml
config:
  logging:
    log_statistics: true
    log_payloads: false
```

TensorCost never needs the prompts or responses; leave `log_payloads` off.

## 3. Tracing in kong.conf

```
tracing_instrumentations = all
tracing_sampling_rate = 1.0
```

The same settings as environment variables are
`KONG_TRACING_INSTRUMENTATIONS=all` and `KONG_TRACING_SAMPLING_RATE=1.0`.
Restart Kong after changing them.

## What TensorCost reads from a span

A span is an LLM call when it names a model and carries usage or a response
id. Kong's request, balancer and other plugin spans are read and dropped.

| Attribute | Used as |
| --- | --- |
| `gen_ai.provider.name`, else `gen_ai.system` | The provider. A provider TensorCost doesn't know is read from the model id's prefix; a span with neither is refused as `unknown_provider`. |
| `gen_ai.request.model`, else `gen_ai.response.model` | The model. |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | Tokens. For Anthropic, Kong reports input without the cache, so the cache reads and writes are added back. |
| `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` | Cache reads and writes. |
| `gen_ai.response.id` | The provider's response id, which matches this call's other records (an SDK's, the provider's invocation log). |
| `kong.auth.consumer.name` | The caller, as alias kind `kong_consumer`. |
| `user.email` | The developer, when it is an email. |
| `http.response.status_code` on a CLIENT span | The provider's own status for the call; a 4xx or 5xx marks the call failed. A SERVER span's status is Kong's answer to its caller, which can be Kong's own refusal or timeout, and is never read as the provider's. |
| span status ERROR, `error.type` | The call failed. |
| span start and end | When the call ran. |
| span id | The row's id. A batch sent again is stored once. |

This list comes from Kong's documentation and has not yet been checked
against a trace captured from a live Kong. If your spend rows are missing
tokens or callers, the attribute names on your Kong version may differ;
please open an issue with a redacted span.

## Callers and teams

Each call carries its Kong consumer's name. In TensorCost, map consumer names
to teams or developers under Connect › Gateways (Unmapped callers lists the
ones seen without a mapping). On a connection with an instance, the mapped
value is `instance/consumer`, for example `eu-1/checkout-svc`.

## Answers

The route follows OTLP over HTTP:

| Status | Meaning | Kong |
| --- | --- | --- |
| 200 | Taken. For protobuf, the body is an empty `ExportTraceServiceResponse`. Spans TensorCost couldn't use are counted under the connection's refused rows. | Done. |
| 400 | The body isn't OTLP, or isn't a shape TensorCost can read. | Not resent. |
| 401 | The key is missing, revoked, or isn't a gateway key. | Not resent. |
| 403 | The key belongs to a connection of another kind. | Not resent. |
| 413 | Past a batch limit (see Batch size); the message names it. Nothing was stored. | Not resent: lower the batch size. |
| 415 | The body is neither protobuf nor JSON. | Not resent. |
| 429 | Over the connection's rate (6,000 requests a minute). | Resent. |
| 503 | TensorCost didn't store all of the spans, for any reason on its side. | Resent. Spans already stored aren't counted twice. |

## Kong version notes

- `config.traces_endpoint` is the name from Kong Gateway 3.8 on. Earlier
  versions call it `config.endpoint`; use that name there, with the same
  value.
- `config.sampling_rate` on the plugin is in Kong Gateway 3.6 and later. On
  older versions only `tracing_sampling_rate` in kong.conf sets the rate.
- Keep the plugin's `queue.max_batch_size` at its default (200), or at
  most 500.

## What isn't here yet

Kong doesn't ask TensorCost before a call: there is no admit plugin for Kong
yet. A budget at its cap therefore doesn't stop Kong's traffic, though the
spend still counts toward the budget. If you need calls refused at a cap,
open an issue. When an admit plugin exists, it will send the same consumer
name as caller kind `consumer`, so one mapping covers both.
