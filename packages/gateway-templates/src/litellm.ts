/**
 * The lines a LiteLLM proxy's config.yaml needs for the tensorcost-litellm
 * plugin: the guardrail that asks admit before each call, with its fail mode,
 * and the logger that reports each call's spend. TENSORCOST_URL and
 * TENSORCOST_GATEWAY_KEY are read from the proxy's environment, so the
 * snippet holds no secret. litellm/ci/tensorcost.yaml in this repository is
 * renderLiteLlmConfig({ failMode: "open" }), and the repository's end-to-end
 * job runs a real proxy with it.
 */

export type LiteLlmFailMode = "open" | "closed";

export interface LiteLlmConfigInput {
  failMode: LiteLlmFailMode;
  /** The gateway connection's instance label, when it has one. */
  instance?: string | null;
}

export function renderLiteLlmConfig(input: LiteLlmConfigInput): string {
  if (input.failMode !== "open" && input.failMode !== "closed") throw new Error("failMode must be open or closed");
  return [
    "guardrails:",
    "  - guardrail_name: tensorcost",
    "    litellm_params:",
    "      guardrail: tensorcost_litellm.TensorCostAdmit",
    "      mode: pre_call",
    "      default_on: true",
    "      api_base: os.environ/TENSORCOST_URL",
    "      api_key: os.environ/TENSORCOST_GATEWAY_KEY",
    `      fail_mode: ${input.failMode}`,
    ...(input.instance ? [`      instance: ${JSON.stringify(input.instance)}`] : []),
    "",
    "litellm_settings:",
    '  callbacks: ["tensorcost_litellm.spend_logger"]',
    "",
  ].join("\n");
}
