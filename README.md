# TensorCost integrations

Open-source pieces of TensorCost that sit in a customer's request path or define
how others talk to us: gateway integrations, the admit protocol, the CLI and the
OpenTelemetry package.

- `litellm/`: a LiteLLM proxy guardrail that checks TensorCost budgets
  before each call, and a logger that reports each call's spend back
  (Python package `tensorcost-litellm`).
- `azure-apim/`: Azure API Management policy fragments that check TensorCost
  budgets before each call, follow its decision, and read pushed token
  quotas.
- `apigee/`: two Apigee shared flows. One asks TensorCost before each call
  and follows its decision; the other counts each call's tokens against the
  pushed product quota and reports the call back.
- `kong/`: how to point Kong Gateway's OpenTelemetry plugin at TensorCost,
  so each AI call Kong proxies is counted with the consumer that made it.
- `workato/`: a Workato custom connector with budget check, spend and
  headroom actions and a budget-threshold trigger.
- `power-platform/`: a Power Platform custom connector (Power Automate and
  Copilot Studio) with the same actions and trigger.
- `spec/admit/`: the admit protocol those integrations speak, as an open
  specification and its OpenAPI file.
- `admit-mock/`: a local server that answers like TensorCost's admit route
  (npm package `@tensorcost/admit-mock`), and `admit-conformance/`: the cases
  a gateway client is tested with against it.

This repository is published from the TensorCost monorepo by a scripted export
of an allowlist of paths. Its history starts at the first export.

Repository: https://github.com/vaadhlabs/tensorcost-integrations

Code is Apache-2.0. The admit specification's prose is CC-BY-4.0, see
spec/LICENSE.md.
