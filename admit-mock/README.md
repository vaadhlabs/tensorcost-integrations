# @tensorcost/admit-mock

A local server that answers TensorCost's gateway admit route the way
TensorCost does, so you can test a gateway client without a TensorCost
workspace. The protocol is `@tensorcost/admit-spec` (`spec/admit/` in this
repository), which this package depends on for its OpenAPI file.

Apache-2.0. Node 18.17 or later, no dependencies.

```sh
npx @tensorcost/admit-mock --port 8787
# or, from a checkout of this repository
node admit-mock/bin/admit-mock.mjs --port 8787
```

Point the client at `http://127.0.0.1:8787` with any bearer token (or only the
one given with `--key`). The mock serves `POST /v1/gateway/admit`,
`POST /v1/gateway/admit/{decision_id}/cancel`, `POST /v1/gateway/headroom`,
`POST /v1/gateway/subscriptions`, `DELETE /v1/gateway/subscriptions/{id}`
and `POST /v1/gateway/logs`, each also under `/api/inference-proxy`.

A log push with `format=tensorcost` checks each row against `GatewayLogRow`:
rows that fit are stored, the rest are named in `parse_errors`, and a `log_id`
the same key sent before counts as `deduped`. `litellm` and `portkey` rows are
stored unread. `GET /_mock/log` lists the pushes under `logs`.

Headroom answers about one budget, "Search team", a $100.00 hard cap with
$97.00 spent: `allowed` is true while `estimate_cents` is 300 or less. A
subscription is kept per key until it is deleted or the mock is reset, and
only the key that made it can delete it.

## Picking an answer

The caller ids in the request pick the answer: the first caller, in the order
sent, whose id starts with one of these prefixes decides. Use whatever the
client sends as a caller id, such as a LiteLLM team id, an APIM subscription
name, a Kong consumer or a tag.

| Caller id | Answer |
| --- | --- |
| anything else | `allow`, holding its reservation, `cache_ttl_seconds` 0 |
| `refuse-*` | `refuse`, reason `budget_hard_cap`, naming the "Search team" budget and who can raise it. `refuse-<reason>` gives that reason instead, for example `refuse-model_governance_denied` |
| `reroute-*` | `reroute` to the first model in `accepts_models` other than the one asked for, or `reroute-<model>` to that one if listed. An entry that names its deployment (`{name, model, provider}`) is judged by `model` and answered with `name`. An allow as asked when the gateway kind can't reroute, `can_reroute` is false, or no other model is listed |
| `slow-*` | an allow after 1,500 ms (`--slow-ms`), or `slow-<ms>` that many milliseconds |
| `error-*` | a 503, or `error-<status>` that status (400 to 599). `error-not-json` is a 200 with an HTML body |
| `degraded-*` | an open workspace's answer to a check that timed out: `allow` with `degraded: true`, detail `check_timeout` |
| `unavailable-*` | a closed workspace's answer to the same: `refuse` with reason `check_unavailable` |
| `throttled-*` | a connection past its admit rate, decided by `--fail-mode`: allow with detail `throttled`, or refuse `check_unavailable` with `retry_after_seconds` |
| `cache-*` | an allow that held nothing, with `cache_ttl_seconds` 5, or `cache-<n>` with n seconds (at most 5) |
| `unknown-mode-*` | an allow decided without the workspace's fail mode: `fail_mode_known: false`, no `x-tc-fail-mode` header |

A request with no readable `model` is answered by `--fail-mode`, as
TensorCost answers it: open allows with `degraded: true`, closed refuses with
reason `invalid_request`. A body that isn't a JSON object is a 400, and a
missing key a 401.

The mock prices every model at 0.3 cents per 1,000 input tokens and 1.5 cents
per 1,000 output tokens, with an 8,192-token maximum output. It has no
aliases, so every caller id that could have one is listed in
`attribution.unmapped`, and a caller kind the gateway doesn't send is dropped
and named in `detail`, as TensorCost does.

Real TensorCost takes the gateway kind from the connection the key belongs to.
The mock takes it from `--gateway-kind`, else the request's `gateway.kind`,
else `generic`. Reroute is answered only to `litellm`, `azure_apim` and
`apigee`.

## Options

| Option | |
| --- | --- |
| `--port <n>` | 8787; 0 picks a free port, printed on the first line |
| `--host <addr>` | 127.0.0.1 |
| `--fail-mode open\|closed` | the workspace's fail mode the answers carry (open) |
| `--gateway-kind <kind>` | the connection's gateway kind |
| `--key <tcgw_...>` | accept only this key |
| `--slow-ms <n>` | how long `slow-*` waits when the id names no time |
| `--openapi <path>` | the admit OpenAPI file to check against |
| `--no-openapi` | check nothing |

## What the mock saw

`GET /_mock/log` returns every admit, cancel, headroom and subscription call
the mock was sent (`admits`, `cancels`, `headrooms`, `subscriptions`), with the
request body, the answer, and the problems found checking each against the
OpenAPI file (`request_errors`, `response_errors`). `POST /_mock/reset`
clears the log, the holds and the subscriptions; with `{"fail_mode": "closed"}` it also switches
the fail mode.

The mock reads the OpenAPI file from `@tensorcost/admit-spec`, which it
depends on, so an install from npm checks requests and answers against the
same contract a checkout does. `TENSORCOST_ADMIT_OPENAPI` or `--openapi`
points it at another file, for instance a newer draft of the spec.

## Tests

`npm test` checks the mock's answers against the OpenAPI file, with every
field it sends required to be one the file names.
