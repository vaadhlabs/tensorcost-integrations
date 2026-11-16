/**
 * Whether the provider billed a proxied call, from what the proxy saw come
 * back. The proxy sends the upstream's HTTP status on every decision it
 * records (`upstreamStatus`), or, when no answer came back, why
 * (`upstreamFailure`), plus an error code when the answer's body says more
 * than its status (`upstreamErrorCode`). The applied-mode spend mapper
 * costs the call's row from this ruling, and the proxy resends a
 * call elsewhere only when it is `not_billed` (provablyNeverBilled).
 *
 * The principle: "never billed" needs proof. Proof is the proxy's own
 * observation (nothing left the socket), a refusal that by protocol comes
 * before any model work (401, 403, 404, 429, at every provider), or the
 * provider's own billing documentation, cited next to each rule. Anything else is "unknown", which
 * books the request-side estimate flagged cost_estimated and cost_unknown,
 * so caps and floors stay on the safe side until a provider usage report or
 * bill reconciles it (counted once at read time).
 *
 * - "billed": a 2xx (a stream cut after a 2xx is billed for what it
 *   reported), or any answer that reported usage, whatever its status:
 *   reported usage beats any status.
 * - "prompt_billed": the provider charged the prompt and produced nothing
 *   (Azure's content filter on the prompt, Azure's 408). Booked at the
 *   request-side input estimate, with no output.
 * - "not_billed": proven free. No cost, no tokens.
 * - "unknown": the call may have run and been billed.
 *
 * Null when the decision says nothing about the upstream (a proxy from
 * before these fields): the row is costed as it always was.
 */

/** Why there is no upstream status. */
export const UPSTREAM_FAILURES = [
  /** Connection refused, DNS, host unreachable: nothing left (provider-fetch isBeforeSendError). */
  "connect_error",
  /** A TLS handshake or certificate failure, before a byte of the request. */
  "tls_error",
  /** The request left and no answer came in time. */
  "timeout",
  /** Any other transport failure once the request may have left. */
  "upstream_error",
  /** This decision was recorded before the call was sent (a policy gate's rejection); another decision records the call. */
  "not_sent",
] as const;
export type UpstreamFailure = (typeof UPSTREAM_FAILURES)[number];

/** What an answer's body says beyond its status. */
export const UPSTREAM_ERROR_CODES = [
  /** Azure OpenAI's content filter refused the prompt (400 `error.code: content_filter`, innererror ResponsibleAIPolicyViolation). */
  "content_filter",
  /** A Bedrock guardrail intervened (a 200: `stopReason: guardrail_intervened`, or `amazon-bedrock-guardrailAction: INTERVENED`). */
  "guardrail_intervened",
  /** Vertex blocked the prompt or answer for safety (a 200: promptFeedback.blockReason, or finishReason SAFETY and kin). */
  "safety_blocked",
  /** A 2xx stream carried an error event and reported no usage. */
  "stream_error",
  /**
   * A 2xx stream that ended without its final usage (a partial last frame,
   * no terminal event, a connection drop mid-stream), or that the proxy's
   * parser gave up on. Whatever partial usage it saw is not the call's.
   */
  "stream_incomplete",
] as const;
export type UpstreamErrorCode = (typeof UPSTREAM_ERROR_CODES)[number];

export type UpstreamBilling = "billed" | "prompt_billed" | "not_billed" | "unknown";

/** The spend row metadata keys a ruled call is marked with. Reserved: no tag may set them. */
export const UPSTREAM_METADATA_KEYS = [
  "upstream_status",
  "upstream_failure",
  "upstream_error_code",
  "upstream_provider",
  "cost_unknown",
] as const;

/**
 * The first-party provider whose API a hostname is, matched exactly on the
 * parsed hostname, never a substring of the URL: an EC2, ELB, SageMaker or
 * API Gateway host on amazonaws.com is not Bedrock, and an Azure VM on
 * azure.com is not Azure OpenAI. Azure AI Foundry inference hosts
 * (*.services.ai.azure.com, *.cognitiveservices.azure.com) are left out:
 * the proxy doesn't route to them as Azure OpenAI (its detectTargetProvider).
 * Null for any other host. The proxy's endpoint rule and the gateway log
 * parsers both read providers from it.
 */
export function firstPartyProviderOfHost(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (/^bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/.test(h)) return "bedrock";
  if (/^[a-z0-9-]+\.openai\.azure\.com$/.test(h)) return "azure_openai";
  if (h === "api.openai.com") return "openai";
  if (h === "api.anthropic.com") return "anthropic";
  if (/^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(h)) return "vertex";
  return null;
}

/** Third-party inference hosts: they bill per call under their own account, whatever the registry says. */
export const THIRD_PARTY_INFERENCE_HOSTS: readonly string[] = [
  "together.xyz",
  "together.ai",
  "fireworks.ai",
  "groq.com",
  "replicate.com",
  "deepinfra.com",
  "perplexity.ai",
  "mistral.ai",
  "openrouter.ai",
  "anyscale.com",
  "cohere.com",
  "cohere.ai",
];

/** True for one of THIRD_PARTY_INFERENCE_HOSTS or a subdomain of one (a label boundary, never a substring). */
export function isThirdPartyInferenceHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return THIRD_PARTY_INFERENCE_HOSTS.some((t) => h === t || h.endsWith(`.${t}`));
}

/** The parsed hostname of a URL (a bare host is read as https), or null when it doesn't parse. */
export function hostnameOf(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Statuses that refuse a call before any model work, at every provider. */
const REFUSED_BEFORE_WORK: ReadonlySet<number> = new Set([401, 403, 404, 429]);

/**
 * The statuses that mean "never billed" at every provider (401, 403, 404,
 * 429), for a caller that can't say which provider answered: a gateway log
 * (gateway-log-billing.ts).
 */
export const NEVER_BILLED_STATUSES: ReadonlySet<number> = REFUSED_BEFORE_WORK;

/**
 * What the answer itself reported having used: the provider's token counts,
 * or a cost a provider or gateway reported. `true` when the caller has
 * already checked.
 */
export type ReportedUsage =
  | boolean
  | { inputTokens?: number | null; outputTokens?: number | null; costCents?: number | null }
  | null
  | undefined;

/** True when `reported` shows real usage: a token count or a cost above 0. */
export function reportsUsage(reported: ReportedUsage): boolean {
  if (typeof reported === "boolean") return reported;
  if (!reported) return false;
  const pos = (n: number | null | undefined) => typeof n === "number" && Number.isFinite(n) && n > 0;
  return pos(reported.inputTokens) || pos(reported.outputTokens) || pos(reported.costCents);
}

/** An edge timeout in front of a provider (Cloudflare's 524 in front of OpenAI): the backend may have accepted the call and finished it. */
const GATEWAY_TIMEOUTS: ReadonlySet<number> = new Set([504, 524]);

/**
 * Azure OpenAI bills whenever the service did processing, whatever the
 * status; it names a content-filtered 400 and a 408 as charged, and a 401
 * and a 429 as not.
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/faq
 * ("We noticed charges associated with API calls that failed to complete
 * with status code 400.")
 */
function azureOpenAi(status: number, errorCode: string | null | undefined): UpstreamBilling {
  if (status === 401 || status === 429) return "not_billed";
  if (status === 408) return "prompt_billed";
  if (status === 400 && errorCode === "content_filter") return "prompt_billed";
  return "unknown";
}

export function upstreamBilling(
  provider: string,
  outcome: number | UpstreamFailure | null | undefined,
  errorCode?: UpstreamErrorCode | string | null,
  /**
   * What the answer reported having used. Reported usage beats any status:
   * a call whose answer carries real tokens or a reported cost was billed
   * for them, whatever status sits beside it (a 4xx with a usage block, an
   * error after a stream reported its usage). The rules below only decide
   * calls that report nothing. A stream that ended before its final usage
   * reports nothing: its partial counts are not the call's, and callers
   * don't pass them.
   */
  reported?: ReportedUsage,
): UpstreamBilling | null {
  if (outcome === null || outcome === undefined) return null;
  if (reportsUsage(reported)) return "billed";
  if (typeof outcome === "string") {
    switch (outcome) {
      // The proxy's own observation: nothing left the socket, or nothing was sent.
      case "connect_error":
      case "tls_error":
      case "not_sent":
        return "not_billed";
      // The request had left. Anthropic: a request the client timed out on
      // that was on track to succeed "is still charged"
      // (https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-api-usage);
      // Azure names a 408 timeout as charged (the FAQ above).
      case "timeout":
      case "upstream_error":
        return "unknown";
      default:
        return null;
    }
  }
  if (!Number.isFinite(outcome)) return null;
  const s = outcome;

  if (s >= 200 && s < 300) {
    // An error event inside the stream, with no usage reported: whether the
    // provider did any work before it is not on the wire.
    if (errorCode === "stream_error" || errorCode === "stream_incomplete") return "unknown";
    // A guardrail that blocks the prompt costs no inference; one that blocks
    // the answer bills the inference; the answer doesn't say which without a
    // trace.
    // https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-how.html#guardrails-charges
    if (provider === "bedrock" && errorCode === "guardrail_intervened") return "unknown";
    // No Google statement on billing a safety-blocked Gemini call; the
    // safety docs cover the finish reasons only.
    // https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/configure-safety-filters
    if (provider === "vertex" && errorCode === "safety_blocked") return "unknown";
    return "billed";
  }
  if (s < 400 || s > 599) return "unknown";
  if (GATEWAY_TIMEOUTS.has(s)) return "unknown";
  // Authentication (401), authorization (403), resource lookup (404) and
  // rate limiting (429) refuse a call before any model work, by protocol
  // semantics, at every provider: that is the proof. Bedrock names them
  // AccessDeniedException, ResourceNotFoundException and
  // ThrottlingException / ModelNotReadyException
  // (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html#API_runtime_InvokeModel_Errors).
  // A provider that documents billing one of them would win over this rule;
  // none does (Azure names 401 and 429 as not charged, the FAQ below).
  if (REFUSED_BEFORE_WORK.has(s)) return "not_billed";

  switch (provider) {
    // "You're billed only for successful API calls and completed tasks.
    // Failed requests aren't charged."
    // https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-api-usage
    case "anthropic":
      return "not_billed";
    case "azure_openai":
      return azureOpenAi(s, errorCode);
    // A routing policy's serving endpoint registered on the tenant's GPU
    // fleet (gpu.serving_endpoint.instance_id set; the proxy's
    // endpointBillingProvider). Nobody bills its answers per call. An
    // endpoint on a third-party inference host (Together, Fireworks, Groq,
    // Replicate, or any host that isn't the tenant's fleet or a provider
    // API) is "third_party", which falls to the default: unknown.
    case "self_hosted":
      return "not_billed";
    // A 400 from Bedrock is ValidationException or
    // ServiceQuotaExceededException: the request is refused before the model
    // is invoked (the InvokeModel errors list above). A model that fails
    // while running answers 424 ModelErrorException instead.
    case "bedrock":
      return s === 400 ? "not_billed" : "unknown";
    // Past the refusals above, OpenAI, Bedrock and Vertex publish no
    // first-party statement that a failed call isn't billed (checked Nov
    // 2026: OpenAI's help center, Bedrock's pricing and error reference,
    // Vertex's pricing), so their other errors are unknown. Bedrock's 408
    // ModelTimeoutException ("Processing time exceeded the model timeout
    // length") and 424 ModelErrorException ("an error while processing the
    // model") come after the model started.
    // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html#API_runtime_InvokeModel_Errors
    default:
      return "unknown";
  }
}

/**
 * The one rule for sending a call again anywhere (a step-down's resend, a
 * live swap's or an endpoint route's fall back to the origin): only when the
 * attempt is proven never billed. A resend after an attempt that may have
 * been billed can bill the call twice.
 */
export function provablyNeverBilled(
  provider: string,
  outcome: number | UpstreamFailure | null | undefined,
  errorCode?: UpstreamErrorCode | string | null,
  /** An attempt that reported usage was billed for it, so it is never resent. */
  reported?: ReportedUsage,
): boolean {
  return upstreamBilling(provider, outcome, errorCode, reported) === "not_billed";
}
