# @tensorcost/gateway-templates

Renders the gateway templates that put TensorCost's admit check in front of a
model call, for your own TensorCost URL and fail mode:

- the Azure API Management policy fragments `tensorcost-admit` and
  `tensorcost-on-error`;
- the Apigee shared flows `tensorcost-admit`, `tensorcost-usage` and
  `tensorcost-usage-final`, and an example API proxy that attaches them;
- the lines a LiteLLM proxy's `config.yaml` needs for the
  `tensorcost-litellm` plugin.

The `azure-apim/`, `apigee/` and `litellm/ci/` directories of
[tensorcost-integrations](https://github.com/vaadhlabs/tensorcost-integrations)
are this package's output for a placeholder host, and their READMEs say how
to install what it renders. What the templates send and how they read the
answer is the admit protocol, `@tensorcost/admit-spec`.

Apache-2.0. No runtime dependencies. The renderers are pure functions with no
Node imports, so they also run in a browser; only the command line tool reads
and writes files.

## Command line

```sh
npx @tensorcost/gateway-templates apim --base-url https://tensorcost.example.com/api/inference-proxy --out ./fragments
npx @tensorcost/gateway-templates apigee --base-url https://tensorcost.example.com/api/inference-proxy --zip --out ./bundles
npx @tensorcost/gateway-templates litellm --fail-mode closed > tensorcost.yaml
```

| Option | Templates | Meaning |
| --- | --- | --- |
| `--base-url <url>` | apim, apigee | Your TensorCost gateway base: https, no query. Admit is `{base}/v1/gateway/admit`. |
| `--fail-mode open\|closed` | all | What the gateway does when TensorCost can't answer. Default `open`. |
| `--key-name <name>` | apim, apigee | The APIM named value or Apigee KVM entry that holds the `tcgw_` key. The key itself never goes in a template. |
| `--deployment <name>=<model>` | apim | An Azure OpenAI deployment and the model it runs. Repeat for each. |
| `--quota-product <id>` | apim | A product whose token quota TensorCost pushes to `tensorcost-quota-<id>`. Repeat for each. |
| `--verify-api-key-policy <name>` | apigee | The VerifyAPIKey policy your proxies run, when it isn't `VerifyAPIKey`. |
| `--zip` | apigee | Write each bundle as a zip ready to import, instead of a directory. |
| `--instance <label>` | litellm | The gateway connection's instance label. |

## Library

```ts
import { renderApimFragment, renderApigeeSharedFlows, renderLiteLlmConfig } from "@tensorcost/gateway-templates";

const xml = renderApimFragment({
  baseUrl: "https://tensorcost.example.com/api/inference-proxy",
  failMode: "closed",
  connectionKey: "tensorcost-gateway-key",
  callerExpr: { subscription: true, user: true, product: true },
  deploymentModels: { "prod-mini": "gpt-4o-mini" },
});
const zips = renderApigeeSharedFlows({ baseUrl: "https://tensorcost.example.com/api/inference-proxy", failMode: "open", connectionKey: "tensorcost-gateway-key" });
```

Every renderer checks its input and throws (`ApimSnippetError`,
`ApigeeSnippetError`) rather than produce a template that wouldn't parse or
could be steered by a value: the base URL must be https with no credentials or
query, names must be valid APIM or Apigee names, and a value that looks like a
`tcgw_` key is refused as a key name.

Each template names itself in a User-Agent, `TensorCost-APIM/<v>` or
`TensorCost-Apigee/<v>`, where `<v>` is `GATEWAY_TEMPLATE_VERSION`: the
templates' version, raised when the requests they send change, not this
package's.
