# TensorCost integrations

The open-source pieces of TensorCost that sit in a customer's request path or
define how others talk to it: gateway integrations, the admit protocol, the
CLI and the OpenTelemetry mapping. This repository is their only source.
TensorCost's own product depends on the packages published from here, at
pinned versions, the same way you would.

| Directory | What it is | Published as |
| --- | --- | --- |
| `spec/admit/` | The admit protocol: what a gateway asks TensorCost before a model call, how it reports the call after, and its OpenAPI file | npm `@tensorcost/admit-spec` |
| `admit-mock/` | A local server that answers like TensorCost's admit and log routes | npm `@tensorcost/admit-mock` |
| `admit-conformance/` | The cases a gateway client is tested with against the mock | npm `@tensorcost/admit-conformance` |
| `packages/gateway-templates/` | Renders the APIM, Apigee and LiteLLM templates for your own URL and fail mode | npm `@tensorcost/gateway-templates` |
| `azure-apim/` | Azure API Management policy fragments that check budgets before each call | rendered by gateway-templates |
| `apigee/` | Apigee shared flows: one asks before each call, one counts tokens and reports the call | rendered by gateway-templates |
| `litellm/` | A LiteLLM proxy guardrail and spend logger | PyPI `tensorcost-litellm` |
| `kong/` | How to point Kong Gateway's OpenTelemetry plugin at TensorCost | a guide |
| `workato/` | A Workato custom connector: budget check, spend, headroom, a budget trigger | import `connector.rb` |
| `power-platform/` | A Power Automate and Copilot Studio custom connector with the same actions | import the connector |
| `packages/otel-genai-cost/` | Reads OpenTelemetry GenAI spans into one call shape with cost-relevant fields | npm `@tensorcost/otel-genai-cost` |
| `packages/cli/` | Estimate and compare LLM prompt costs from the command line | npm `@tensorcost/cli` |

Every integration takes the TensorCost URL of your own installation; none
assumes a hosted service.

## Building and testing

Node 20.12 or later and pnpm 9:

```sh
pnpm install
pnpm build
pnpm test
```

The Python, Ruby and Apigee pieces have their own test commands in their
READMEs, and `.github/workflows/ci.yml` runs all of them.

## Releases

Each package is released by pushing a tag `<name>-v<version>` (for example
`gateway-templates-v0.1.0` or `litellm-v0.1.5`). The release workflows check
that the tag matches the package's version, run the package's tests and
`tools/guard.mjs` on the exact tarball, and publish with provenance.

Repository: https://github.com/vaadhlabs/tensorcost-integrations

Code is Apache-2.0. The admit specification's prose is CC-BY-4.0, see
spec/admit/LICENSE.md.
