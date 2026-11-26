/**
 * The Azure API Management policy fragments: the admit fragment
 * (tensorcost-admit) and its on-error partner (tensorcost-on-error), rendered
 * with a TensorCost URL, a fail mode and the name of the APIM named value that
 * holds the gateway connection's key.
 *
 * The copies in azure-apim/ in this repository are this renderer's output for
 * APIM_REFERENCE_INPUT, and the repository's CI fails if they differ. It is
 * pure and holds nothing secret, so it runs in a browser as well as in Node.
 *
 * What the admit fragment does, in order, on every call it is included in:
 *
 *   1. Mints the call's correlation id from APIM's own context.RequestId and
 *      overwrites any x-tensorcost-correlation-id the caller sent. The same
 *      id is ApiManagementGatewayLlmLog's CorrelationId, so a call's log row
 *      and its admit answer meet, and a caller can never name another call's
 *      admit.
 *   2. Token quotas pushed down by TensorCost, one llm-token-limit per
 *      product whose named value tensorcost-quota-{id} has been pushed. The
 *      value is "{tokens}|{push id}": token-quota reads the count before the
 *      "|", and the counter key holds the whole value, so each push starts a
 *      new count. They run before the check, so a call they refuse never
 *      asked TensorCost and holds nothing.
 *   3. A cached allow for the same callers, model, max_tokens and customer,
 *      when the last answer said it could be reused (cache_ttl_seconds above
 *      0 and nothing reserved).
 *   4. Otherwise POST /v1/gateway/admit: callers (subscription id, user id,
 *      product id: the same ids the gateway log carries, so a call and its
 *      log row map through the same aliases), the model (the body's, else the
 *      deployment in the path), max_tokens, stream, and the end customer from
 *      the request's x-tc-customer header when it has one, so the call is
 *      judged against that customer's limits. Never the prompt. A 1 s
 *      timeout; ignore-error "true" under open, "false" under closed.
 *   5. No usable answer (timeout, error, non-200, a body that isn't JSON):
 *      the fail mode TensorCost last sent in x-tc-fail-mode decides, else the
 *      rendered one. Closed refuses with a 503; open lets the call through.
 *      The last-sent mode lives in APIM's cache, which the Consumption tier
 *      doesn't have (Microsoft: internal caching isn't available there; an
 *      external cache is). There the lookup finds nothing and the rendered
 *      mode is the only one, so render it with the workspace's current mode
 *      and import the fragment again after a change. A lookup that leaves the
 *      variable unset or null reads as the rendered mode too.
 *   6. refuse: 429 with TensorCost's message (and Retry-After when given), or
 *      503 when the refusal is check_unavailable or invalid_request (not a
 *      spent budget). reroute: the body's model becomes the answer's model.
 *      A call with a deployment in the path (Azure OpenAI's
 *      /deployments/{id}/..., which the OpenAI SDK's Azure client uses with a
 *      body model too) sends can_reroute false, so admit never answers it
 *      reroute; the deployment, never the body's model, is checked, as the
 *      model deploymentModels maps it to, else by its own name.
 *      allow: cached only as step 3 says.
 *
 * The on-error fragment cancels an allowed call's hold only when the error
 * came from the inbound section after the check, before anything was
 * forwarded (a later inbound policy refused it), and under closed answers a
 * failed check with the same 503 as step 5.
 *
 * Every policy expression is escaped as XML (`<` as &lt;, `&` as &amp;),
 * so the output is well-formed XML that any parser reads.
 */

import { GATEWAY_TEMPLATE_VERSION } from "./version.js";

/** An Azure OpenAI deployment name. */
export const APIM_DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A model id a deployment runs. */
export const APIM_DEPLOYMENT_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** The most deployments one fragment maps. */
export const APIM_MAX_DEPLOYMENTS = 100;

export const APIM_QUOTA_NAMED_VALUE_PREFIX = "tensorcost-quota-";
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The APIM named value a product's token quota is pushed into,
 * tensorcost-quota-{product id, lowercased}, or null when the product id
 * can't name one (named value ids take letters, digits, '.', '-' and '_').
 * The fragment reads it as {{tensorcost-quota-…}}.
 */
export function apimQuotaNamedValue(product: string): string | null {
  return PRODUCT_ID.test(product) ? `${APIM_QUOTA_NAMED_VALUE_PREFIX}${product.toLowerCase()}` : null;
}

export type ApimFailMode = "open" | "closed";

export interface ApimFragmentInput {
  /** TensorCost's gateway base, e.g. https://tensorcost.example.com/api/inference-proxy (admit is at /v1/gateway/admit under it). */
  baseUrl: string;
  failMode: ApimFailMode;
  /**
   * The APIM named value that holds the connection's tcgw_ key (secret, or a
   * Key Vault reference). The key itself never goes in a policy: policies are
   * readable by everyone who can read the API.
   */
  connectionKey: string;
  /**
   * The callers sent to admit: APIM subscription id, user id and product id.
   * The user is its id, not its email: ApiManagementGatewayLogs carries only
   * the id, and the call's log row must map through the same alias.
   */
  callerExpr: { subscription: true; user: true; product: true };
  /** Products whose token quota TensorCost has pushed (tensorcost-quota-{product} exists). */
  quotaProducts?: readonly string[];
  /**
   * The Azure OpenAI deployments and the model each runs. A call whose model is
   * the deployment in the path is checked as that model; a deployment not
   * listed is sent by its own name, which is priced only if a price list has
   * that name, else at the workspace's default reservation.
   */
  deploymentModels?: Readonly<Record<string, string>>;
}

export const APIM_KEY_NAMED_VALUE = "tensorcost-gateway-key";
export const APIM_ADMIT_FRAGMENT_ID = "tensorcost-admit";
export const APIM_ON_ERROR_FRAGMENT_ID = "tensorcost-on-error";
/** What the admit request names as the provider: APIM's LLM APIs front Azure OpenAI (OTel gen_ai.provider.name). */
export const APIM_PROVIDER = "azure.ai.openai";
/** Admit's answer deadline in the fragment, seconds (send-request timeout is in seconds). */
export const APIM_ADMIT_TIMEOUT_SECONDS = 1;
/**
 * Every request the fragments send names itself: send-request mode="new"
 * sets only the headers it is given, and a web application firewall in front
 * of TensorCost may block a request with no User-Agent.
 */
export const APIM_USER_AGENT = `TensorCost-APIM/${GATEWAY_TEMPLATE_VERSION}`;
/** The request header the fragment reads the end customer from: the SDK's own. */
export const APIM_CUSTOMER_HEADER = "x-tc-customer";
/** How long the fragment remembers the fail mode TensorCost last sent. */
export const APIM_FAIL_MODE_MEMORY_SECONDS = 86_400;

/** The inputs the copies in azure-apim/ are rendered with. */
export const APIM_REFERENCE_INPUT: ApimFragmentInput = {
  baseUrl: "https://tensorcost.example.com/api/inference-proxy",
  failMode: "open",
  connectionKey: APIM_KEY_NAMED_VALUE,
  callerExpr: { subscription: true, user: true, product: true },
};

const NAMED_VALUE = /^[A-Za-z0-9._-]{1,80}$/;

export class ApimSnippetError extends Error {}

const DEPLOYMENT = APIM_DEPLOYMENT_NAME;
const MODEL = APIM_DEPLOYMENT_MODEL;
const MAX_DEPLOYMENTS = APIM_MAX_DEPLOYMENTS;

/** The deployment map, checked: every name and model is safe inside a C# string literal. */
export function checkApimDeploymentModels(map: Readonly<Record<string, string>> | undefined): Array<[string, string]> {
  const entries = Object.entries(map ?? {});
  if (entries.length > MAX_DEPLOYMENTS) throw new ApimSnippetError(`at most ${MAX_DEPLOYMENTS} deployments`);
  for (const [d, m] of entries) {
    if (!DEPLOYMENT.test(d)) throw new ApimSnippetError(`deployment ${JSON.stringify(d)} isn't an Azure OpenAI deployment name`);
    if (typeof m !== "string" || !MODEL.test(m)) throw new ApimSnippetError(`model ${JSON.stringify(m)} for deployment ${d} isn't a model id`);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}


/** The TensorCost gateway base as the fragment calls it: https, no query, no trailing slash. */
export function apimGatewayBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ApimSnippetError("baseUrl must be an https URL");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) {
    throw new ApimSnippetError("baseUrl must be an https URL with no credentials, query or fragment");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function keyName(raw: string): string {
  const name = raw.trim();
  if (/^tcgw_/i.test(name)) throw new ApimSnippetError("connectionKey is the name of the APIM named value that holds the key, not the key itself");
  if (!NAMED_VALUE.test(name)) throw new ApimSnippetError("connectionKey must be an APIM named value name (letters, digits, '.', '-', '_')");
  return name;
}

// ------------------------------------------------------------------ XML

/** Element text: `&`, `<` and `>` escaped. */
function text(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A single-quoted attribute value: `&`, `<`, `>` and `'` escaped. Policy expressions keep their double quotes readable. */
function attr(s: string): string {
  return `'${text(s).replace(/'/g, "&apos;")}'`;
}

const v = (name: string, type = "string") => `((${type})context.Variables["${name}"])`;
const answerField = (field: string) => `(string)(((JObject)context.Variables["tcAnswer"])["${field}"] as JValue)`;

function errorBody(type: string, message: string, extra = ""): string {
  return `@{
    var a = (JObject)context.Variables["tcAnswer"];
    var e = new JObject(new JProperty("type", "${type}"), new JProperty("message", ${message}));${extra}
    return new JObject(new JProperty("error", e)).ToString(Newtonsoft.Json.Formatting.None);
}`;
}

const UNAVAILABLE_MESSAGE = `"TensorCost couldn't check this call's budget, and this gateway refuses calls it can't check."`;

/** The admit fragment (fragment id tensorcost-admit). */
export function renderApimFragment(input: ApimFragmentInput): string {
  const base = apimGatewayBaseUrl(input.baseUrl);
  const key = keyName(input.connectionKey);
  if (input.failMode !== "open" && input.failMode !== "closed") throw new ApimSnippetError("failMode must be open or closed");
  const quotas = [...new Set(input.quotaProducts ?? [])].map((p) => {
    const nv = apimQuotaNamedValue(p);
    if (!nv) throw new ApimSnippetError(`product ${JSON.stringify(p)} can't name an APIM named value`);
    return { product: p, nv };
  });
  const deployments = checkApimDeploymentModels(input.deploymentModels);
  // The deployment in the path decides the model, whatever the body says:
  // Azure routes by the path, and the OpenAI SDK's Azure client sends both.
  const pathModel = deployments.length
    ? `switch (d) { ${deployments.map(([dep, m]) => `case "${dep}": m = "${m}"; break; `).join("")}default: m = d; break; }`
    : `m = d;`;
  const open = input.failMode === "open";
  const L: string[] = [];
  const push = (...lines: string[]) => L.push(...lines);

  push(
    `<!--`,
    `  TensorCost admit, an Azure API Management policy fragment (id ${APIM_ADMIT_FRAGMENT_ID}).`,
    `  Include it in the inbound section of each LLM API, right after <base />`,
    `  and before your own policies that can refuse a call:`,
    `    <include-fragment fragment-id="${APIM_ADMIT_FRAGMENT_ID}" />`,
    `  and ${APIM_ON_ERROR_FRAGMENT_ID} in on-error. It needs the named value`,
    `  ${key} (secret) holding the gateway connection's key.`,
    `  Fail mode when TensorCost can't answer: ${input.failMode}.`,
    `  The fragment remembers a newer mode TensorCost sends in APIM's cache. The`,
    `  Consumption tier has no internal cache, so there this rendered mode always`,
    `  applies: after changing the fail mode, render and import this fragment`,
    `  again, or configure an external cache for the instance.`,
    `  Apache-2.0. See README.md.`,
    `-->`,
    `<fragment>`,
    `\t<!-- The call's correlation id is APIM's own request id; a caller's header is overwritten. -->`,
    `\t<set-header name="x-tensorcost-correlation-id" exists-action="override">`,
    `\t\t<value>${text(`@(context.RequestId.ToString())`)}</value>`,
    `\t</set-header>`,
  );

  if (quotas.length > 0) {
    push(`\t<!-- Token quotas TensorCost pushes into named values. A new value starts a new count. -->`, `\t<choose>`);
    for (const q of quotas) {
      push(
        `\t\t<when condition=${attr(`@(context.Product?.Id == "${q.product}")`)}>`,
        `\t\t\t<llm-token-limit counter-key=${attr(`@("tensorcost:" + context.Product.Id + ":{{${q.nv}}}")`)} token-quota=${attr(`@(int.Parse("{{${q.nv}}}".Split('|')[0]))`)} token-quota-period="Yearly" estimate-prompt-tokens="false" />`,
        `\t\t</when>`,
      );
    }
    push(`\t</choose>`);
  }

  push(
    `\t<!-- What the check needs from the body: model, max_tokens, stream. The prompt is never sent. -->`,
    `\t<set-variable name="tcBody" value=${attr(`@{ try { return context.Request.Body?.As<JObject>(preserveContent: true) ?? new JObject(); } catch { return new JObject(); } }`)} />`,
    `\t<!-- A deployment in the path decides the model and can't be rewritten, so such a call is never rerouted; Azure ignores the body's model. -->`,
    `\t<set-variable name="tcModelInPath" value=${attr(`@(!string.IsNullOrEmpty(context.Request.MatchedParameters.GetValueOrDefault("deployment-id", "")))`)} />`,
    `\t<set-variable name="tcModel" value=${attr(`@{ var b = ${v("tcBody", "JObject")}; var d = context.Request.MatchedParameters.GetValueOrDefault("deployment-id", ""); var m = ""; if (!string.IsNullOrEmpty(d)) { ${pathModel} } else { m = (string)(b["model"] as JValue); } return m ?? ""; }`)} />`,
    `\t<set-variable name="tcMaxTokens" value=${attr(`@{ var b = ${v("tcBody", "JObject")}; var t = (b["max_completion_tokens"] ?? b["max_tokens"]) as JValue; return t == null ? "" : (string)t; }`)} />`,
    `\t<!-- The end customer the call is for, as the SDK sends it: judged against that customer's limits. -->`,
    `\t<set-variable name="tcCustomer" value=${attr(`@(context.Request.Headers.GetValueOrDefault("${APIM_CUSTOMER_HEADER}", "").Trim())`)} />`,
    `\t<set-variable name="tcCacheKey" value=${attr(`@("tensorcost:allow:" + (context.Subscription?.Id ?? "") + "|" + (context.User?.Id ?? "") + "|" + (context.Product?.Id ?? "") + "|" + ${v("tcModel")} + "|" + ${v("tcMaxTokens")} + "|" + ${v("tcCustomer")})`)} />`,
    `\t<cache-lookup-value key="tensorcost:fail-mode" variable-name="tcLastFailMode" default-value="${input.failMode}" />`,
    `\t<!-- With no cache to read (Consumption tier, or a failed cache call) the lookup can leave nothing or null: the rendered mode applies. -->`,
    `\t<set-variable name="tcLastFailMode" value=${attr(`@{ var m = context.Variables.GetValueOrDefault<string>("tcLastFailMode", ""); return m == "open" || m == "closed" ? m : "${input.failMode}"; }`)} />`,
    `\t<cache-lookup-value key=${attr(`@(${v("tcCacheKey")})`)} variable-name="tcCachedAllow" />`,
    `\t<choose>`,
    `\t\t<when condition=${attr(`@(!context.Variables.ContainsKey("tcCachedAllow"))`)}>`,
    `\t\t\t<send-request mode="new" response-variable-name="tcAdmit" timeout="${APIM_ADMIT_TIMEOUT_SECONDS}" ignore-error="${open ? "true" : "false"}">`,
    `\t\t\t\t<set-url>${text(`${base}/v1/gateway/admit`)}</set-url>`,
    `\t\t\t\t<set-method>POST</set-method>`,
    `\t\t\t\t<set-header name="Authorization" exists-action="override">`,
    `\t\t\t\t\t<value>Bearer {{${key}}}</value>`,
    `\t\t\t\t</set-header>`,
    `\t\t\t\t<set-header name="Content-Type" exists-action="override">`,
    `\t\t\t\t\t<value>application/json</value>`,
    `\t\t\t\t</set-header>`,
    `\t\t\t\t<set-header name="User-Agent" exists-action="override">`,
    `\t\t\t\t\t<value>${text(APIM_USER_AGENT)}</value>`,
    `\t\t\t\t</set-header>`,
    `\t\t\t\t<set-body>${text(`@{
    var callers = new JArray();
    if (context.Subscription != null) { callers.Add(new JObject(new JProperty("kind", "subscription"), new JProperty("id", context.Subscription.Id))); }
    if (context.User != null && !string.IsNullOrEmpty(context.User.Id)) { callers.Add(new JObject(new JProperty("kind", "user"), new JProperty("id", context.User.Id))); }
    if (context.Product != null) { callers.Add(new JObject(new JProperty("kind", "product"), new JProperty("id", context.Product.Id))); }
    var req = new JObject(
        new JProperty("gateway", new JObject(new JProperty("kind", "azure_apim"))),
        new JProperty("callers", callers),
        new JProperty("provider", "${APIM_PROVIDER}"),
        new JProperty("model", ${v("tcModel")}),
        new JProperty("correlation_id", context.RequestId.ToString()));
    var maxTokens = ${v("tcMaxTokens")};
    if (maxTokens != "") { req["max_tokens"] = maxTokens; }
    var stream = ${v("tcBody", "JObject")}["stream"] as JValue;
    if (stream != null) { req["stream"] = stream; }
    if (${v("tcModelInPath", "bool")}) { req["can_reroute"] = false; }
    var customer = ${v("tcCustomer")};
    if (customer != "") { req["customer"] = customer; }
    return req.ToString(Newtonsoft.Json.Formatting.None);
}`)}</set-body>`,
    `\t\t\t</send-request>`,
    `\t\t\t<!-- An answer is a 200 with a JSON body. Anything else is no answer, and the fail mode decides. -->`,
    `\t\t\t<set-variable name="tcAnswer" value=${attr(`@{ var r = (IResponse)context.Variables.GetValueOrDefault("tcAdmit"); if (r == null || r.StatusCode != 200) { return new JObject(); } try { return r.Body.As<JObject>() ?? new JObject(); } catch { return new JObject(); } }`)} />`,
    `\t\t\t<set-variable name="tcSeenFailMode" value=${attr(`@{ var r = (IResponse)context.Variables.GetValueOrDefault("tcAdmit"); if (r == null || r.StatusCode != 200) { return ""; } var m = r.Headers.GetValueOrDefault("x-tc-fail-mode", ""); return m == "open" || m == "closed" ? m : ""; }`)} />`,
    `\t\t\t<choose>`,
    `\t\t\t\t<when condition=${attr(`@(${v("tcSeenFailMode")} != "" && ${v("tcSeenFailMode")} != ${v("tcLastFailMode")})`)}>`,
    `\t\t\t\t\t<cache-store-value key="tensorcost:fail-mode" value=${attr(`@(${v("tcSeenFailMode")})`)} duration="${APIM_FAIL_MODE_MEMORY_SECONDS}" />`,
    `\t\t\t\t\t<set-variable name="tcLastFailMode" value=${attr(`@(${v("tcSeenFailMode")})`)} />`,
    `\t\t\t\t</when>`,
    `\t\t\t</choose>`,
    `\t\t\t<set-variable name="tcDecision" value=${attr(`@(${answerField("decision")} ?? "")`)} />`,
    `\t\t\t<choose>`,
    `\t\t\t\t<!-- No answer: the fail mode TensorCost last sent, else the one this fragment was rendered with. -->`,
    `\t\t\t\t<when condition=${attr(`@(${v("tcDecision")} == "" && ${v("tcLastFailMode")} == "closed")`)}>`,
    returnResponse("\t\t\t\t\t", 503, errorBody("budget_check_unavailable", UNAVAILABLE_MESSAGE)),
    `\t\t\t\t</when>`,
    ...[true, false].flatMap((retryAfter) => [
      // A closed workspace's throttled answer carries retry_after_seconds: keep it.
      `\t\t\t\t<when condition=${attr(`@(${v("tcDecision")} == "refuse" && (${answerField("reason")} == "check_unavailable" || ${answerField("reason")} == "invalid_request")${retryAfter ? ` && ${answerField("retry_after_seconds")} != null` : ""})`)}>`,
      returnResponse("\t\t\t\t\t", 503, errorBody("budget_check_unavailable", `${answerField("message")} ?? ${UNAVAILABLE_MESSAGE}`, `
    e["reason"] = ${answerField("reason")};${retryAfter ? `
    e["retry_after_seconds"] = a["retry_after_seconds"];` : ""}`), retryAfter),
      `\t\t\t\t</when>`,
    ]),
    `\t\t\t\t<when condition=${attr(`@(${v("tcDecision")} == "refuse" && ${answerField("retry_after_seconds")} != null)`)}>`,
    refusal("\t\t\t\t\t", true),
    `\t\t\t\t</when>`,
    `\t\t\t\t<when condition=${attr(`@(${v("tcDecision")} == "refuse")`)}>`,
    refusal("\t\t\t\t\t", false),
    `\t\t\t\t</when>`,
    `\t\t\t\t<when condition=${attr(`@(${v("tcDecision")} == "reroute")`)}>`,
    `\t\t\t\t\t<set-variable name="tcDecisionId" value=${attr(`@(${answerField("decision_id")} ?? "")`)} />`,
    `\t\t\t\t\t<choose>`,
    `\t\t\t\t\t\t<when condition=${attr(`@(!${v("tcModelInPath", "bool")} && ${v("tcBody", "JObject")}["model"] != null && !string.IsNullOrEmpty(${answerField("model")}))`)}>`,
    `\t\t\t\t\t\t\t<set-body>${text(`@{ var b = ${v("tcBody", "JObject")}; b["model"] = ${answerField("model")}; return b.ToString(Newtonsoft.Json.Formatting.None); }`)}</set-body>`,
    `\t\t\t\t\t\t</when>`,
    `\t\t\t\t\t</choose>`,
    `\t\t\t\t</when>`,
    `\t\t\t\t<when condition=${attr(`@(${v("tcDecision")} == "allow")`)}>`,
    `\t\t\t\t\t<set-variable name="tcDecisionId" value=${attr(`@(${answerField("decision_id")} ?? "")`)} />`,
    `\t\t\t\t\t<!-- Reused only when TensorCost says so: cache_ttl_seconds above 0, nothing reserved, a full check. -->`,
    `\t\t\t\t\t<set-variable name="tcCacheTtl" value=${attr(`@{ var a = (JObject)context.Variables["tcAnswer"]; var ttl = a["cache_ttl_seconds"] as JValue; var held = a["reservation_cents"] as JValue; if (ttl == null || held == null || a["degraded"] != null || a["fail_mode_known"] != null) { return 0; } var t = (int)ttl; return t > 0 && (double)held == 0 ? t : 0; }`)} />`,
    `\t\t\t\t\t<choose>`,
    `\t\t\t\t\t\t<when condition=${attr(`@(${v("tcCacheTtl", "int")} > 0)`)}>`,
    `\t\t\t\t\t\t\t<cache-store-value key=${attr(`@(${v("tcCacheKey")})`)} value="allow" duration=${attr(`@(${v("tcCacheTtl", "int")})`)} />`,
    `\t\t\t\t\t\t</when>`,
    `\t\t\t\t\t</choose>`,
    `\t\t\t\t</when>`,
    `\t\t\t</choose>`,
    `\t\t</when>`,
    `\t</choose>`,
    `</fragment>`,
    ``,
  );
  return L.join("\n");
}

/** A spent budget (or another gate): 429 with TensorCost's message, and Retry-After when the answer gives one. */
function refusal(indent: string, retryAfter: boolean): string {
  const body = errorBody("budget_exceeded", `${answerField("message")} ?? "TensorCost refused this call."`, `
    if (a["reason"] != null) { e["reason"] = a["reason"]; }
    if (a["decision_id"] != null) { e["decision_id"] = a["decision_id"]; }
    if (a["retry_after_seconds"] != null) { e["retry_after_seconds"] = a["retry_after_seconds"]; }`);
  return [
    `${indent}<return-response>`,
    `${indent}\t<set-status code="429" reason="Too Many Requests" />`,
    ...(retryAfter
      ? [`${indent}\t<set-header name="Retry-After" exists-action="override">`, `${indent}\t\t<value>${text(`@(${answerField("retry_after_seconds")})`)}</value>`, `${indent}\t</set-header>`]
      : []),
    `${indent}\t<set-header name="Content-Type" exists-action="override">`,
    `${indent}\t\t<value>application/json</value>`,
    `${indent}\t</set-header>`,
    `${indent}\t<set-body>${text(body)}</set-body>`,
    `${indent}</return-response>`,
  ].join("\n");
}

function returnResponse(indent: string, status: 503, body: string, retryAfter = false): string {
  return [
    `${indent}<return-response>`,
    `${indent}\t<set-status code="${status}" reason="Service Unavailable" />`,
    ...(retryAfter
      ? [`${indent}\t<set-header name="Retry-After" exists-action="override">`, `${indent}\t\t<value>${text(`@(${answerField("retry_after_seconds")})`)}</value>`, `${indent}\t</set-header>`]
      : []),
    `${indent}\t<set-header name="Content-Type" exists-action="override">`,
    `${indent}\t\t<value>application/json</value>`,
    `${indent}\t</set-header>`,
    `${indent}\t<set-body>${text(body)}</set-body>`,
    `${indent}</return-response>`,
  ].join("\n");
}

/**
 * The on-error fragment (fragment id tensorcost-on-error). Two jobs:
 *
 *   - Cancel the hold of a call TensorCost allowed when the error came from
 *     the inbound section, which runs before anything is forwarded: a later
 *     inbound policy (a rate limit, a validation) refused the call, so the
 *     backend never saw it. An error from the backend or outbound section
 *     may follow a billed call and cancels nothing; the hold then expires on
 *     its own with its hold life (25 minutes for APIM), or TensorCost releases
 *     it once the call's log row is stored.
 *   - Answer a check that failed with an error with the same 503 as the
 *     admit fragment, rather than APIM's generic error. Only closed renders
 *     ignore-error "false", so only closed ever gets here; under open a
 *     failed check is no answer and the call goes on.
 */
export function renderApimOnErrorFragment(input: Pick<ApimFragmentInput, "baseUrl" | "connectionKey">): string {
  const base = apimGatewayBaseUrl(input.baseUrl);
  const key = keyName(input.connectionKey);
  const L = [
    `<!--`,
    `  TensorCost on-error, the partner of ${APIM_ADMIT_FRAGMENT_ID} (fragment id ${APIM_ON_ERROR_FRAGMENT_ID}).`,
    `  Include it first in the on-error section of each API that includes ${APIM_ADMIT_FRAGMENT_ID}:`,
    `    <include-fragment fragment-id="${APIM_ON_ERROR_FRAGMENT_ID}" />`,
    `  Apache-2.0. See README.md.`,
    `-->`,
    `<fragment>`,
    `\t<choose>`,
    `\t\t<!-- Refused by a later inbound policy after TensorCost allowed it: never forwarded, so its hold goes now. -->`,
    `\t\t<when condition=${attr(`@(context.LastError != null && context.LastError.Section == "inbound" && context.Variables.ContainsKey("tcDecisionId") && ${v("tcDecisionId")} != "")`)}>`,
    `\t\t\t<send-one-way-request mode="new" timeout="${APIM_ADMIT_TIMEOUT_SECONDS}">`,
    `\t\t\t\t<set-url>${text(`@("${base}/v1/gateway/admit/" + Uri.EscapeDataString(${v("tcDecisionId")}) + "/cancel")`)}</set-url>`,
    `\t\t\t\t<set-method>POST</set-method>`,
    `\t\t\t\t<set-header name="Authorization" exists-action="override">`,
    `\t\t\t\t\t<value>Bearer {{${key}}}</value>`,
    `\t\t\t\t</set-header>`,
    `\t\t\t\t<set-header name="User-Agent" exists-action="override">`,
    `\t\t\t\t\t<value>${text(APIM_USER_AGENT)}</value>`,
    `\t\t\t\t</set-header>`,
    `\t\t\t</send-one-way-request>`,
    `\t\t</when>`,
  ];
  L.push(
    `\t\t<!-- The check itself failed (under closed a timeout is an error). Refuse it as the admit fragment does. -->`,
    `\t\t<when condition=${attr(`@(context.LastError != null && context.LastError.Source == "send-request" && context.Variables.ContainsKey("tcCacheKey") && !context.Variables.ContainsKey("tcAnswer"))`)}>`,
    `\t\t\t<return-response>`,
    `\t\t\t\t<set-status code="503" reason="Service Unavailable" />`,
    `\t\t\t\t<set-header name="Content-Type" exists-action="override">`,
    `\t\t\t\t\t<value>application/json</value>`,
    `\t\t\t\t</set-header>`,
    `\t\t\t\t<set-body>${text(`@(new JObject(new JProperty("error", new JObject(new JProperty("type", "budget_check_unavailable"), new JProperty("message", ${UNAVAILABLE_MESSAGE})))).ToString(Newtonsoft.Json.Formatting.None))`)}</set-body>`,
    `\t\t\t</return-response>`,
    `\t\t</when>`,
  );
  L.push(`\t</choose>`, `</fragment>`, ``);
  return L.join("\n");
}
