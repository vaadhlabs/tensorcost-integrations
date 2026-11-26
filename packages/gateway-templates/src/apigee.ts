/**
 * The two Apigee shared flows for a gateway connection, rendered with a
 * TensorCost URL, fail mode, the name of the KVM entry that holds
 * the connection's key and the VerifyAPIKey policy the proxies run:
 *
 *   tensorcost-admit  (request flow, after VerifyAPIKey) asks admit before the
 *                     call and follows the decision;
 *   tensorcost-usage  (response flow, and the DefaultFaultRule) counts the
 *                     call's tokens against the pushed product quota and
 *                     reports the call to /v1/gateway/logs?format=tensorcost.
 *
 * The copies in apigee/ in this repository are this renderer's output for
 * APIGEE_REFERENCE_INPUT, and the repository's CI fails if they differ. It is
 * pure and holds nothing secret, so it runs in a browser as well as in Node,
 * and hands the bundles over as zips (zipFiles, base64).
 *
 * What tensorcost-admit does, step by step:
 *
 *   1. Reads the key from the encrypted KVM `tensorcost` into private.*.
 *   2. Overwrites any x-tensorcost-correlation-id the caller sent with
 *      Apigee's own messageid. The same id goes to admit as correlation_id
 *      and to the log row as log_id and correlation_id.
 *   3. Reads what the check needs from the request: the model (the body's,
 *      or the one a Vertex path names, which can't be rewritten and so sends
 *      can_reroute false), max_tokens and stream. The callers are the app
 *      ({owner}/{developer.app.name}, the owner by the developer caller's
 *      rule: never client_id, which is the app's API key) and the developer (VerifyAPIKey's developer email when it
 *      has one, else developer.id) and the API product (apiproduct.name);
 *      tensorcost-usage reuses the same list. The end customer comes from
 *      the request's x-tc-customer header when it has one (the header the
 *      SDK sends): admit judges the call against that customer's margin
 *      floors and fixed limits, and the call's log row carries it.
 *      Nothing the flows send to TensorCost holds an API key.
 *   4. A pushed product quota (attribute tensorcost_llm_quota) is enforced by
 *      LLMTokenQuota before the check, so a call it refuses never asks.
 *   5. A cached allow for the same callers, model, max_tokens and customer skips the
 *      check. Otherwise ServiceCallout POSTs /v1/gateway/admit with a 1,000 ms
 *      timeout, continueOnError true under open and false under closed.
 *   6. ExtractVariables reads decision, model and message. Only a 200 with a
 *      JSON decision counts as an answer: anything else is no answer, and the
 *      fail mode TensorCost last sent (x-tc-fail-mode, remembered a day) or
 *      else the rendered one decides. Closed answers 503.
 *   7. RaiseFault 429 when decision = "refuse" (never a status code: a refusal
 *      is a 200), with TensorCost's message and Retry-After when given; 503 for
 *      check_unavailable and invalid_request. On reroute, AssignMessage sets
 *      the body with its model rewritten. An allow is cached only when
 *      cache_ttl_seconds is above 0, nothing was reserved, and the answer is
 *      neither degraded nor of an unknown fail mode.
 *
 * What tensorcost-usage does:
 *
 *   - A call that never reached the target (target.sent.start.timestamp
 *     unset) sends no row. If TensorCost allowed it, its hold is cancelled.
 *   - Otherwise it reads the response's token counts (never its content),
 *     counts them with LLMTokenQuota in CountOnly, and posts one row, fire
 *     and forget. upstream_status is the target's own status, only when the
 *     target answered.
 *
 * Every value the renderer puts in the XML is escaped, and the JavaScript is
 * the same for every install: the rendered values reach it as policy
 * properties.
 */

import { apimGatewayBaseUrl } from "./apim.js";
import { GATEWAY_TEMPLATE_VERSION } from "./version.js";

/**
 * The API product attribute TensorCost pushes a team budget's room into, in
 * tokens. The tensorcost-admit shared flow's LLMTokenQuota reads it as
 * <Allow countRef="verifyapikey.{policy}.apiproduct.tensorcost_llm_quota">.
 */
export const APIGEE_QUOTA_ATTRIBUTE = "tensorcost_llm_quota";

/** The VerifyAPIKey policy name the shared flows read when none is given. */
export const APIGEE_DEFAULT_VERIFY_API_KEY_POLICY = "VerifyAPIKey";

/** An Apigee policy name: letters, digits, '-', '_' and '.', starting with a letter or digit (at most 255). */
export const APIGEE_POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export type ApigeeFailMode = "open" | "closed";

export interface ApigeeFlowInput {
  /** TensorCost's gateway base, e.g. https://tensorcost.example.com/api/inference-proxy. */
  baseUrl: string;
  failMode: ApigeeFailMode;
  /**
   * The entry in the encrypted environment KVM `tensorcost` that holds the
   * connection's tcgw_ key. The key itself never goes in a bundle: anyone who
   * can read the shared flow could read it.
   */
  connectionKey: string;
  /** The VerifyAPIKey policy the proxies run before tensorcost-admit. */
  verifyApiKeyPolicy?: string;
}

export const APIGEE_ADMIT_FLOW = "tensorcost-admit";
export const APIGEE_USAGE_FLOW = "tensorcost-usage";
/** The PostClientFlow's shared flow: only the streamed call's row callout, as a PostClientFlow allows. */
export const APIGEE_USAGE_FINAL_FLOW = "tensorcost-usage-final";
/** An example API proxy with every TensorCost attachment, and the EventFlow policies a proxy carries itself. */
export const APIGEE_PROXY_EXAMPLE = "tensorcost-proxy-example";
export const APIGEE_KVM = "tensorcost";
export const APIGEE_KEY_ENTRY = "tensorcost-gateway-key";
/**
 * Every ServiceCallout names itself (admit, the log row, the cancel): a web
 * application firewall in front of TensorCost may block a request with no
 * User-Agent, and under continueOnError the flow would swallow that 403.
 */
export const APIGEE_USER_AGENT = `TensorCost-Apigee/${GATEWAY_TEMPLATE_VERSION}`;
/** ServiceCallout's <Timeout>, milliseconds (it can't be set at runtime). */
export const APIGEE_ADMIT_TIMEOUT_MS = 1000;
export const APIGEE_FAIL_MODE_MEMORY_SECONDS = 86_400;
/** The LLMTokenQuota policies' shared counter. */
export const APIGEE_QUOTA_SHARED_NAME = "tensorcost-llm-tokens";
/** Allow's count when the product has no pushed attribute: no limit. */
export const APIGEE_NO_LIMIT = 2_147_483_647;

/** The inputs the copies in apigee/ are rendered with. */
export const APIGEE_REFERENCE_INPUT: ApigeeFlowInput = {
  baseUrl: "https://tensorcost.example.com/api/inference-proxy",
  failMode: "open",
  connectionKey: APIGEE_KEY_ENTRY,
  verifyApiKeyPolicy: APIGEE_DEFAULT_VERIFY_API_KEY_POLICY,
};

export class ApigeeSnippetError extends Error {}

/** One shared flow bundle: its name and its files, keyed by their path in the zip (sharedflowbundle/...). */
export interface ApigeeBundle {
  name: string;
  files: Record<string, string>;
}

const KVM_ENTRY = /^[A-Za-z0-9._-]{1,80}$/;

function checked(input: ApigeeFlowInput): { base: string; key: string; failMode: ApigeeFailMode; verify: string } {
  let base: string;
  try {
    base = apimGatewayBaseUrl(input.baseUrl);
  } catch (err) {
    throw new ApigeeSnippetError((err as Error).message);
  }
  const key = input.connectionKey.trim();
  if (/^tcgw_/i.test(key)) throw new ApigeeSnippetError("connectionKey is the name of the KVM entry that holds the key, not the key itself");
  if (!KVM_ENTRY.test(key)) throw new ApigeeSnippetError("connectionKey must be a KVM entry name (letters, digits, '.', '-', '_')");
  if (input.failMode !== "open" && input.failMode !== "closed") throw new ApigeeSnippetError("failMode must be open or closed");
  const verify = (input.verifyApiKeyPolicy ?? APIGEE_DEFAULT_VERIFY_API_KEY_POLICY).trim();
  if (!APIGEE_POLICY_NAME.test(verify)) throw new ApigeeSnippetError("verifyApiKeyPolicy must be an Apigee policy name");
  return { base, key, failMode: input.failMode, verify };
}

// ------------------------------------------------------------------ XML

/** Element text: `&`, `<` and `>` escaped. */
function text(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A double-quoted attribute value. */
function attr(s: string): string {
  return `"${text(s).replace(/"/g, "&quot;")}"`;
}

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const LICENSE = `<!-- TensorCost for Apigee. Apache-2.0. See README.md. -->`;

function doc(lines: string[]): string {
  return [XML_HEAD, LICENSE, ...lines, ""].join("\n");
}

function step(name: string, condition?: string): string[] {
  return [`    <Step>`, `        <Name>${name}</Name>`, ...(condition ? [`        <Condition>${text(condition)}</Condition>`] : []), `    </Step>`];
}

function descriptor(name: string, description: string, policies: string[], resources: string[]): string {
  return doc([
    `<SharedFlowBundle revision="1" name=${attr(name)}>`,
    `    <DisplayName>${text(name)}</DisplayName>`,
    `    <Description>${text(description)}</Description>`,
    `    <Policies>`,
    ...policies.map((p) => `        <Policy>${p}</Policy>`),
    `    </Policies>`,
    `    <Resources>`,
    ...resources.map((r) => `        <Resource>jsc://${r}</Resource>`),
    `    </Resources>`,
    `    <SharedFlows>`,
    `        <SharedFlow>default</SharedFlow>`,
    `    </SharedFlows>`,
    `</SharedFlowBundle>`,
  ]);
}

function keyPolicy(name: string, key: string): string {
  return doc([
    `<KeyValueMapOperations name=${attr(name)} mapIdentifier=${attr(APIGEE_KVM)}>`,
    `    <DisplayName>${name}</DisplayName>`,
    `    <!-- The connection's key, from the encrypted environment KVM "${APIGEE_KVM}". private.* is masked in trace. -->`,
    `    <Scope>environment</Scope>`,
    `    <ExpiryTimeInSecs>300</ExpiryTimeInSecs>`,
    `    <Get assignTo="private.tensorcost.key">`,
    `        <Key>`,
    `            <Parameter>${text(key)}</Parameter>`,
    `        </Key>`,
    `    </Get>`,
    `</KeyValueMapOperations>`,
  ]);
}

function jsPolicy(name: string, resource: string, props: Record<string, string>): string {
  return doc([
    `<Javascript name=${attr(name)} timeLimit="200">`,
    `    <DisplayName>${name}</DisplayName>`,
    `    <Properties>`,
    ...Object.entries(props).map(([k, val]) => `        <Property name=${attr(k)}>${text(val)}</Property>`),
    `    </Properties>`,
    `    <IncludeURL>jsc://tensorcost-common.js</IncludeURL>`,
    `    <ResourceURL>jsc://${resource}</ResourceURL>`,
    `</Javascript>`,
  ]);
}

function tokenQuota(name: string, verify: string, mode: "EnforceOnly" | "CountOnly", usageSource = "{tensorcost.call_total_tokens}"): string {
  return doc([
    `<LLMTokenQuota name=${attr(name)} continueOnError="true" enabled="true">`,
    `    <DisplayName>${name}</DisplayName>`,
    mode === "EnforceOnly"
      ? `    <!-- The product's pushed quota, before the check: a call it refuses never asks TensorCost. continueOnError lets TC-QuotaRefuse answer it with TensorCost's 429. -->`
      : `    <!-- This call's tokens, counted against the same counter tensorcost-admit enforces. -->`,
    `    <Allow count="${APIGEE_NO_LIMIT}" countRef=${attr(`verifyapikey.${verify}.apiproduct.${APIGEE_QUOTA_ATTRIBUTE}`)}/>`,
    `    <Interval>1</Interval>`,
    `    <TimeUnit>year</TimeUnit>`,
    `    <!-- The product and the pushed value: each new value starts a new count. -->`,
    `    <Identifier ref="tensorcost.quota_identifier"/>`,
    `    <Distributed>true</Distributed>`,
    `    <SharedName>${APIGEE_QUOTA_SHARED_NAME}</SharedName>`,
    `    <${mode}>true</${mode}>`,
    ...(mode === "CountOnly" ? [`    <LLMTokenUsageSource>${usageSource}</LLMTokenUsageSource>`] : []),
    `    <!-- The model the call asked for, on every counter, so a reroute never splits the count. -->`,
    `    <LLMModelSource>{tensorcost.request_model}</LLMModelSource>`,
    `</LLMTokenQuota>`,
  ]);
}

function lookup(name: string, fragment: string, assignTo: string): string {
  return doc([
    `<LookupCache name=${attr(name)}>`,
    `    <DisplayName>${name}</DisplayName>`,
    `    <CacheKey>`,
    `        <Prefix>tensorcost</Prefix>`,
    `        <KeyFragment${fragment.startsWith("ref:") ? ` ref=${attr(fragment.slice(4))}/>` : `>${text(fragment)}</KeyFragment>`}`,
    `    </CacheKey>`,
    `    <AssignTo>${assignTo}</AssignTo>`,
    `</LookupCache>`,
  ]);
}

function populate(name: string, fragment: string, source: string, ttl: { seconds: number } | { ref: string }): string {
  return doc([
    `<PopulateCache name=${attr(name)}>`,
    `    <DisplayName>${name}</DisplayName>`,
    `    <CacheKey>`,
    `        <Prefix>tensorcost</Prefix>`,
    `        <KeyFragment${fragment.startsWith("ref:") ? ` ref=${attr(fragment.slice(4))}/>` : `>${text(fragment)}</KeyFragment>`}`,
    `    </CacheKey>`,
    `    <ExpirySettings>`,
    "ref" in ttl ? `        <TimeoutInSeconds ref=${attr(ttl.ref)}>0</TimeoutInSeconds>` : `        <TimeoutInSeconds>${ttl.seconds}</TimeoutInSeconds>`,
    `    </ExpirySettings>`,
    `    <Source>${source}</Source>`,
    `</PopulateCache>`,
  ]);
}

function raiseFault(name: string, status: 429 | 503, retryAfter: boolean): string {
  return doc([
    `<RaiseFault name=${attr(name)}>`,
    `    <DisplayName>${name}</DisplayName>`,
    `    <FaultResponse>`,
    `        <Set>`,
    ...(retryAfter ? [`            <Headers>`, `                <Header name="Retry-After">{tensorcost.retry_after}</Header>`, `            </Headers>`] : []),
    `            <Payload contentType="application/json">{tensorcost.error_body}</Payload>`,
    `            <StatusCode>${status}</StatusCode>`,
    `            <ReasonPhrase>${status === 429 ? "Too Many Requests" : "Service Unavailable"}</ReasonPhrase>`,
    `        </Set>`,
    `    </FaultResponse>`,
    `    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>`,
    `</RaiseFault>`,
  ]);
}

// ------------------------------------------------------------------ JavaScript

/**
 * Shared by both bundles, word for word: the callers, the quota counter and
 * the request reading. ES5, for Apigee's Rhino engine.
 */
export const APIGEE_COMMON_JS = String.raw`/*
 * TensorCost for Apigee: helpers shared by tensorcost-admit and tensorcost-usage.
 * Apache-2.0. Both bundles carry this file unchanged, so a call and its log row
 * name their callers by the same rule.
 */
var TC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var TC_MAX_ID = 200;

function tcGet(name) {
  var x = context.getVariable(name);
  if (x === null || x === undefined) return null;
  return String(x);
}

function tcText(x) {
  if (x === null || x === undefined) return null;
  var t = String(x).replace(/^\s+|\s+$/g, "");
  return t === "" ? null : t;
}

function tcProp(name, dflt) {
  try {
    var x = properties[name];
    var t = tcText(x);
    return t === null ? dflt : t;
  } catch (e) {
    return dflt;
  }
}

function tcInt(x) {
  if (x === null || x === undefined) return null;
  var s = String(x).replace(/^\s+|\s+$/g, "");
  if (!/^\d{1,15}$/.test(s)) return null;
  return parseInt(s, 10);
}

function tcCount(x) {
  return typeof x === "number" && isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/*
 * The callers, the same list for admit and the log row: the app, the
 * developer and the API product. The app is its name (developer.app.name), never client_id:
 * client_id is the consumer key, the app's API key, and nothing sent to
 * TensorCost may hold a credential. The name is stable, unlike the app's
 * internal id, which Apigee may change. The developer is the email VerifyAPIKey read for the
 * app's developer when it has one, else developer.id. tensorcost-admit keeps
 * the list in tensorcost.callers and tensorcost-usage reuses it, so both
 * sides send the same developer id even if a variable changes in between.
 */
function tcCallers() {
  var kept = tcGet("tensorcost.callers");
  if (kept !== null) {
    try {
      var list = JSON.parse(kept);
      if (list instanceof Array) return list;
    } catch (e) {}
  }
  var out = [];
  var policy = tcProp("verifyApiKeyPolicy", "VerifyAPIKey");
  var dev = tcText(tcGet("verifyapikey." + policy + ".developer.email")) || tcText(tcGet("developer.email")) || tcText(tcGet("developer.id"));
  // An app's name is unique only within its developer or AppGroup, so the app
  // is named with its owner, by the developer caller's own rule: two
  // developers' "chatbot" apps are two callers. With no owner, no app caller.
  var app = tcText(tcGet("verifyapikey." + policy + ".developer.app.name")) || tcText(tcGet("developer.app.name"));
  if (app !== null && dev !== null) {
    var owned = dev + "/" + app;
    if (owned.length <= TC_MAX_ID) out.push({ kind: "app", id: owned });
  }
  if (dev !== null && dev.length <= TC_MAX_ID) out.push({ kind: "developer", id: dev });
  // The API product the key was verified for: an apigee_product alias maps
  // it to the team whose budget it spends and whose quota it carries.
  var product = tcText(tcGet("verifyapikey." + policy + ".apiproduct.name")) || tcText(tcGet("apiproduct.name"));
  if (product !== null && product.length <= TC_MAX_ID) out.push({ kind: "product", id: product });
  context.setVariable("tensorcost.callers", JSON.stringify(out));
  return out;
}

/*
 * The pushed quota's counter: the product and the value TensorCost pushed.
 * A new value starts a new count, since the value is the budget's room as of
 * that push. Only a whole number turns the quota on.
 */
function tcQuota() {
  var policy = tcProp("verifyApiKeyPolicy", "VerifyAPIKey");
  var raw = tcText(tcGet("verifyapikey." + policy + ".apiproduct.tensorcost_llm_quota"));
  var product = tcText(tcGet("verifyapikey." + policy + ".apiproduct.name")) || tcText(tcGet("apiproduct.name")) || "";
  var on = raw !== null && tcInt(raw) !== null;
  context.setVariable("tensorcost.quota_on", on ? "true" : "false");
  context.setVariable("tensorcost.quota_identifier", "tensorcost:" + product + ":" + (on ? raw : "none"));
}

/*
 * The provider, in the admit contract's words. A proxy that knows its target
 * sets tensorcost.provider itself; otherwise the request path or the target
 * URL decides, and an unknown target sends none.
 */
function tcProvider(where) {
  var set = tcText(tcGet("tensorcost.provider"));
  if (set !== null) return set;
  var s = where || "";
  if (/aiplatform\.googleapis\.com|\/publishers\/[^\/]+\/models\//.test(s)) return "gcp.vertex_ai";
  if (/generativelanguage\.googleapis\.com/.test(s)) return "gcp.gemini";
  if (/api\.openai\.com/.test(s)) return "openai";
  if (/api\.anthropic\.com/.test(s)) return "anthropic";
  if (/openai\.azure\.com|services\.ai\.azure\.com/.test(s)) return "azure.ai.openai";
  if (/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com|\/model\/[^\/]+\/(invoke|converse)/.test(s)) return "aws.bedrock";
  if (/\/openai\/deployments\//.test(s)) return "azure.ai.openai";
  return null;
}

/*
 * What the check needs from the request, and nothing else: the model,
 * max_tokens and stream. A Vertex path (.../publishers/google/models/{model}:generateContent)
 * names the model, and a proxy may set tensorcost.fixed_model for a target
 * that serves one model: neither can be rewritten, so the call is never
 * rerouted.
 */
function tcReadRequest() {
  var body = null;
  var raw = tcGet("request.content");
  if (raw !== null && raw !== "") {
    try {
      var b = JSON.parse(raw);
      if (b !== null && typeof b === "object" && !(b instanceof Array)) body = b;
    } catch (e) {}
  }
  var path = tcGet("request.path") || tcGet("proxy.pathsuffix") || "";
  var fixed = tcText(tcGet("tensorcost.fixed_model"));
  // Vertex .../models/{model}:..., Azure OpenAI .../deployments/{deployment}/...,
  // Bedrock .../model/{id}/invoke|converse...: the path decides the model.
  var inPath = /\/models\/([A-Za-z0-9._@-]+)(:|\/|$)/.exec(path) || /\/openai\/deployments\/([A-Za-z0-9._-]+)(\/|$)/.exec(path) || /\/model\/([^\/]+)\/(invoke|converse)/.exec(path);
  var model = null;
  var fixedModel = false;
  if (fixed !== null) {
    model = fixed;
    fixedModel = true;
  } else if (inPath) {
    try {
      model = decodeURIComponent(inPath[1]);
    } catch (e) {
      model = inPath[1];
    }
    fixedModel = true;
  } else if (body !== null && typeof body.model === "string") {
    model = tcText(body.model);
  }
  var max = null;
  if (body !== null) {
    var cands = [body.max_completion_tokens, body.max_tokens, body.max_output_tokens, body.generationConfig ? body.generationConfig.maxOutputTokens : undefined];
    for (var i = 0; i < cands.length && max === null; i++) {
      if (typeof cands[i] === "number" && isFinite(cands[i]) && cands[i] >= 0) max = Math.floor(cands[i]);
    }
  }
  var stream = (body !== null && body.stream === true) || /:streamGenerateContent/.test(path);
  return { body: body, path: path, model: model, fixedModel: fixedModel, maxTokens: max, stream: stream };
}

/*
 * Token usage, from a response body or from the events of a streamed one.
 * Only counts and the response id are read. Tokens are in the row
 * convention: input counts all input, cache reads and writes included.
 */
function tcUsageNew() {
  return { input: 0, output: 0, cached: 0, write: 0, id: null, seen: false };
}

function tcId(x) {
  return typeof x === "string" && x.length <= 200 ? x : null;
}

/* Folds one JSON body or stream event into the usage so far. */
function tcUsageAdd(acc, b) {
  if (b === null || typeof b !== "object") return acc;
  var g = b.usageMetadata;
  if (g !== null && typeof g === "object") {
    // Gemini and Vertex, whole or streamed: each chunk's usageMetadata is the
    // total so far, so the last one wins. promptTokenCount includes cached
    // content; thinking is output.
    acc.input = tcCount(g.promptTokenCount);
    acc.cached = Math.min(tcCount(g.cachedContentTokenCount), acc.input);
    acc.output = tcCount(g.candidatesTokenCount) + tcCount(g.thoughtsTokenCount);
    acc.id = tcId(b.responseId) || acc.id;
    acc.seen = true;
    return acc;
  }
  if (b.type === "message_start" && b.message && typeof b.message === "object") {
    // Anthropic stream: the input and its cache at the start.
    acc.id = tcId(b.message.id) || acc.id;
    if (b.message.usage) tcAnthropic(acc, b.message.usage);
    return acc;
  }
  if (b.type === "message_delta" && b.usage && typeof b.usage === "object") {
    // Anthropic stream: output_tokens is the total so far; newer events repeat the input.
    if (b.usage.input_tokens !== undefined) tcAnthropic(acc, b.usage);
    acc.output = tcCount(b.usage.output_tokens);
    acc.seen = true;
    return acc;
  }
  if (b.type === "response.completed" && b.response && typeof b.response === "object") {
    // OpenAI Responses stream: the final event carries the whole response.
    return tcUsageAdd(acc, b.response);
  }
  var meta = b.metadata && typeof b.metadata === "object" ? b.metadata.usage : undefined;
  var u = b.usage !== undefined ? b.usage : meta;
  if (u === null || typeof u !== "object") return acc;
  if (u.inputTokens !== undefined || u.outputTokens !== undefined) {
    // Bedrock Converse (and its stream's metadata event): inputTokens leaves out cache reads and writes.
    acc.cached = tcCount(u.cacheReadInputTokens);
    acc.write = tcCount(u.cacheWriteInputTokens);
    acc.input = tcCount(u.inputTokens) + acc.cached + acc.write;
    acc.output = tcCount(u.outputTokens);
  } else if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
    // OpenAI chat completions (a stream's last chunk with include_usage): prompt_tokens includes cached tokens.
    acc.input = tcCount(u.prompt_tokens);
    acc.output = tcCount(u.completion_tokens);
    acc.cached = Math.min(tcCount(u.prompt_tokens_details ? u.prompt_tokens_details.cached_tokens : 0), acc.input);
    acc.write = 0;
  } else if (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
    tcAnthropic(acc, u);
    acc.output = tcCount(u.output_tokens);
  } else {
    // OpenAI responses, or Anthropic without cache fields: input_tokens is all input.
    acc.input = tcCount(u.input_tokens);
    acc.cached = Math.min(tcCount(u.input_tokens_details ? u.input_tokens_details.cached_tokens : 0), acc.input);
    acc.write = 0;
    acc.output = tcCount(u.output_tokens);
  }
  acc.id = tcId(b.id) || acc.id;
  acc.seen = true;
  return acc;
}

/* Anthropic's input_tokens leaves out cache reads and writes; the row counts all input. */
function tcAnthropic(acc, u) {
  acc.cached = tcCount(u.cache_read_input_tokens);
  acc.write = tcCount(u.cache_creation_input_tokens);
  acc.input = tcCount(u.input_tokens) + acc.cached + acc.write;
  if (u.output_tokens !== undefined) acc.output = tcCount(u.output_tokens);
  acc.seen = true;
}

/* One stream event's data, parsed; null for anything that isn't a JSON object ("[DONE]"). */
function tcEventJson(data) {
  if (data === null || data === undefined) return null;
  var t = String(data).replace(/^\s+|\s+$/g, "");
  if (t === "" || t.charAt(0) !== "{") return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

/*
 * A whole response body: JSON, or the text of an event stream the proxy
 * buffered (text/event-stream without streaming enabled), whose data lines
 * are folded in order.
 */
function tcUsageOf(raw) {
  var acc = tcUsageNew();
  if (raw === null || raw === "") return acc;
  var whole = tcEventJson(raw);
  if (whole !== null) return tcUsageAdd(acc, whole);
  var t = String(raw).replace(/^\s+/, "");
  if (t.charAt(0) === "[") {
    // Vertex streamGenerateContent without alt=sse: a JSON array of chunks.
    try {
      var chunks = JSON.parse(t);
      for (var c = 0; c < chunks.length; c++) tcUsageAdd(acc, chunks[c]);
    } catch (e) {}
    return acc;
  }
  var lines = String(raw).split(/\r?\n/);
  var data = [];
  for (var i = 0; i <= lines.length; i++) {
    var line = i < lines.length ? lines[i] : "";
    if (line.indexOf("data:") === 0) {
      data.push(line.slice(5).replace(/^ /, ""));
    } else if (line === "" && data.length > 0) {
      tcUsageAdd(acc, tcEventJson(data.join("\n")));
      data = [];
    }
  }
  return acc;
}

function tcStatus(x) {
  var n = tcInt(x);
  return n !== null && n >= 100 && n <= 599 ? n : null;
}

function tcIso(ms) {
  var n = tcInt(ms);
  return n === null ? null : new Date(n).toISOString();
}

/* The call's log row in the tensorcost format: ids, callers, counts, statuses, never content. */
function tcRow(u, kept) {
  var id = tcGet("messageid");
  var provider = tcText(tcGet("tensorcost.admit_provider")) || tcProvider((tcGet("request.path") || "") + " " + (tcGet("target.url") || ""));
  var row = {
    log_id: id,
    correlation_id: id,
    // The model the call was checked as, or rerouted to.
    model: tcText(tcGet("tensorcost.model")),
    input_tokens: u.input,
    output_tokens: u.output,
    cached_input_tokens: u.cached,
    cache_write_tokens: u.write,
    started_at: tcIso(tcGet("client.received.start.timestamp")),
    ended_at: tcIso(tcGet("target.received.end.timestamp")) || tcIso(tcGet("system.timestamp")),
    callers: tcCallers()
  };
  if (provider !== null) row.provider = provider;
  if (u.id !== null) row.provider_response_id = u.id;
  if (kept.status !== null) row.status = kept.status;
  if (kept.upstream !== null) row.upstream_status = kept.upstream;
  var customer = tcText(tcGet("tensorcost.customer"));
  if (customer !== null) row.customer = customer;
  return row;
}
`;

/** tensorcost-admit's steps: "prepare" before the check, "decide" after it. */
export const APIGEE_ADMIT_JS = String.raw`/*
 * TensorCost for Apigee: the tensorcost-admit steps. Apache-2.0.
 * properties.step is "prepare" (before the check) or "decide" (after it).
 */
function tcPrepare() {
  var req = tcReadRequest();
  var callers = tcCallers();
  tcQuota();
  var provider = tcProvider(req.path);
  var model = req.model === null ? "" : req.model;
  context.setVariable("tensorcost.model", model);
  context.setVariable("tensorcost.request_model", model);
  context.setVariable("tensorcost.fixed_model_seen", req.fixedModel ? "true" : "false");
  if (provider !== null) context.setVariable("tensorcost.admit_provider", provider);
  context.setVariable("tensorcost.body_has_model", req.body !== null && typeof req.body.model === "string" ? "true" : "false");
  var id = tcGet("messageid");
  var admit = { gateway: { kind: "apigee" }, callers: callers, model: model, correlation_id: id };
  if (provider !== null) admit.provider = provider;
  if (req.maxTokens !== null) admit.max_tokens = req.maxTokens;
  if (req.stream) admit.stream = true;
  if (req.fixedModel) admit.can_reroute = false;
  // The end customer, as the SDK's x-tc-customer names it: at most 128
  // characters and no control characters, as TensorCost keeps it.
  var customer = tcText(tcGet("request.header.x-tc-customer"));
  if (customer !== null && (customer.length > 128 || /[\u0000-\u001f\u007f]/.test(customer))) customer = null;
  if (customer !== null) {
    admit.customer = customer;
    context.setVariable("tensorcost.customer", customer);
  }
  context.setVariable("tensorcost.admit_body", JSON.stringify(admit));
  var ids = [];
  for (var i = 0; i < callers.length; i++) ids.push(callers[i].kind + "=" + callers[i].id);
  context.setVariable("tensorcost.cache_key", "allow|" + ids.join("|") + "|" + model + "|" + (req.maxTokens === null ? "" : req.maxTokens) + "|" + (customer === null ? "" : customer));
  context.setVariable("tensorcost.cached_allow", "none");
  // TC-QuotaRefuse's answer when the product's pushed quota is spent.
  var product = null;
  for (var p = 0; p < callers.length; p++) if (callers[p].kind === "product") product = callers[p].id;
  context.setVariable(
    "tensorcost.quota_error_body",
    tcErrorBody("budget_exceeded", "TensorCost: " + (product === null ? "this API product" : "API product " + product) + " has used the token quota its team's hard-cap budget allows. A TensorCost admin, or the budget's owner, can raise the budget.", { reason: "gateway_quota" })
  );
  context.setVariable("tensorcost.decision_applied", "none");
}

function tcErrorBody(type, message, extra) {
  var e = { type: type, message: message };
  for (var k in extra) {
    if (extra.hasOwnProperty(k) && extra[k] !== null && extra[k] !== undefined) e[k] = extra[k];
  }
  return JSON.stringify({ error: e });
}

var TC_UNAVAILABLE = "TensorCost couldn't check this call's budget, and this gateway refuses calls it can't check.";

function tcDecide() {
  context.setVariable("tensorcost.unavailable", "false");
  context.setVariable("tensorcost.has_retry_after", "false");
  context.setVariable("tensorcost.reroute", "false");
  context.setVariable("tensorcost.cache_allow", "false");
  context.setVariable("tensorcost.remember_fail_mode", "false");

  // An answer is a 200 whose body is JSON with a decision. A timeout, an
  // error, another status or another body is no answer.
  var answer = null;
  var failed = tcGet("servicecallout.TC-Admit.failed") === "true";
  if (!failed && tcGet("tcAdmit.status.code") === "200") {
    try {
      var a = JSON.parse(tcGet("tcAdmit.content"));
      if (a !== null && typeof a === "object" && (a.decision === "allow" || a.decision === "refuse" || a.decision === "reroute")) answer = a;
    } catch (e) {}
  }

  var last = tcText(tcGet("tensorcost.last_fail_mode"));
  var mode = last === "open" || last === "closed" ? last : tcProp("failMode", "open");

  if (answer === null) {
    // Nothing ExtractVariables read from a non-answer may decide anything.
    context.setVariable("tcAnswer.decision", "");
    context.setVariable("tensorcost.decision_applied", "no_answer");
    if (mode === "closed") {
      context.setVariable("tensorcost.unavailable", "true");
      context.setVariable("tensorcost.error_body", tcErrorBody("budget_check_unavailable", TC_UNAVAILABLE, {}));
    }
    return;
  }

  var seen = tcText(tcGet("tcAdmit.header.x-tc-fail-mode"));
  if ((seen === "open" || seen === "closed") && seen !== last) {
    context.setVariable("tensorcost.seen_fail_mode", seen);
    context.setVariable("tensorcost.remember_fail_mode", "true");
  }

  var retry = typeof answer.retry_after_seconds === "number" && isFinite(answer.retry_after_seconds) && answer.retry_after_seconds >= 0 ? Math.ceil(answer.retry_after_seconds) : null;
  if (retry !== null) {
    context.setVariable("tensorcost.retry_after", String(retry));
    context.setVariable("tensorcost.has_retry_after", "true");
  }
  var decisionId = typeof answer.decision_id === "string" && TC_UUID.test(answer.decision_id) ? answer.decision_id : null;
  if (decisionId !== null) context.setVariable("tensorcost.decision_id", decisionId);
  context.setVariable("tensorcost.decision_applied", answer.decision);

  if (answer.decision === "refuse") {
    var extra = { reason: answer.reason, decision_id: decisionId, retry_after_seconds: retry };
    if (answer.reason === "check_unavailable" || answer.reason === "invalid_request") {
      context.setVariable("tensorcost.unavailable", "true");
      context.setVariable("tensorcost.error_body", tcErrorBody("budget_check_unavailable", typeof answer.message === "string" ? answer.message : TC_UNAVAILABLE, extra));
    } else {
      context.setVariable("tensorcost.error_body", tcErrorBody("budget_exceeded", typeof answer.message === "string" ? answer.message : "TensorCost refused this call.", extra));
    }
    return;
  }

  if (answer.decision === "reroute") {
    var to = typeof answer.model === "string" ? tcText(answer.model) : null;
    var raw = tcGet("request.content");
    if (to !== null && to.length <= 256 && tcGet("tensorcost.fixed_model_seen") !== "true" && tcGet("tensorcost.body_has_model") === "true" && raw !== null) {
      try {
        var b = JSON.parse(raw);
        b.model = to;
        context.setVariable("tensorcost.rerouted_body", JSON.stringify(b));
        context.setVariable("tensorcost.reroute", "true");
        context.setVariable("tensorcost.model", to);
      } catch (e) {}
    }
    return;
  }

  // allow: reused only when TensorCost says so, and only when nothing was held.
  var ttl = typeof answer.cache_ttl_seconds === "number" && isFinite(answer.cache_ttl_seconds) ? Math.floor(answer.cache_ttl_seconds) : 0;
  var held = answer.reservation_cents;
  if (ttl > 0 && held === 0 && answer.degraded === undefined && answer.fail_mode_known === undefined) {
    context.setVariable("tensorcost.cache_ttl", String(ttl));
    context.setVariable("tensorcost.cache_value", "allow");
    context.setVariable("tensorcost.cache_allow", "true");
  }
}

if (tcProp("step", "") === "prepare") tcPrepare();
else if (tcProp("step", "") === "decide") tcDecide();
`;

/** tensorcost-usage's steps: "read" before the token count, "row" after it. */
export const APIGEE_USAGE_JS = String.raw`/*
 * TensorCost for Apigee: the tensorcost-usage steps. Apache-2.0.
 * properties.step is "read" (before the token count) or "row" (after it).
 * Only counts, ids and statuses are read from the response; its content is
 * never sent anywhere.
 */
function tcUsageRead() {
  context.setVariable("tensorcost.count_tokens", "false");
  context.setVariable("tensorcost.send_row", "false");
  context.setVariable("tensorcost.send_cancel", "false");
  context.setVariable("tensorcost.stream_pending", "false");
  // Once a call: the target response flow and the DefaultFaultRule both include this flow.
  if (tcGet("tensorcost.logged") === "true") return;
  context.setVariable("tensorcost.logged", "true");

  var inFault = tcText(tcGet("fault.name")) !== null;
  var sent = tcText(tcGet("target.sent.start.timestamp")) !== null;
  var answered = tcText(tcGet("target.received.start.timestamp")) !== null;

  if (!sent) {
    // The target never saw the call: no row, nothing was billed. An allowed
    // call's hold goes now (a later policy refused it, or it failed before
    // anything was sent).
    var decided = tcGet("tensorcost.decision_applied");
    var id = tcGet("tensorcost.decision_id");
    if (id !== null && TC_UUID.test(id) && (decided === "allow" || decided === "reroute")) context.setVariable("tensorcost.send_cancel", "true");
    return;
  }

  if (tcGet("tensorcost.quota_identifier") === null) tcQuota();
  tcCallers();
  if (tcGet("tensorcost.model") === null) {
    var req = tcReadRequest();
    context.setVariable("tensorcost.model", req.model === null ? "" : req.model);
  }

  var usage = tcUsageNew();
  var upstream = null;
  var status = null;
  if (!inFault) {
    if (answered) {
      // The target's own status: this flow runs first in the target's response.
      upstream = tcStatus(tcGet("message.status.code"));
      var body = tcGet("response.content");
      var sse = /text\/event-stream/i.test(tcGet("response.header.content-type") || "");
      if (sse && (body === null || body === "")) {
        // Streaming is on: the events haven't arrived yet. The EventFlow's
        // TC-StreamUsage counts them and builds the row, and the
        // PostClientFlow's tensorcost-usage-final sends it.
        context.setVariable("tensorcost.stream_pending", "true");
      } else {
        // A whole body, JSON or a buffered event stream.
        usage = tcUsageOf(body);
        context.setVariable("tensorcost.count_tokens", "true");
      }
    }
    status = tcStatus(tcGet("response.status.code"));
  } else {
    // In the fault flow only the target's own error answer (ErrorResponseCode)
    // is the target's status. Apigee's faults, timeouts included, send none.
    if (answered && tcGet("fault.name") === "ErrorResponseCode") upstream = tcStatus(tcGet("error.status.code"));
    status = tcStatus(tcGet("error.status.code"));
  }
  context.setVariable("tensorcost.call_total_tokens", String(usage.input + usage.output));
  context.setVariable("tensorcost.usage_json", JSON.stringify({ u: usage, upstream: upstream, status: status }));
  if (tcGet("tensorcost.stream_pending") !== "true") context.setVariable("tensorcost.send_row", "true");
}

function tcUsageRow() {
  var pending = tcGet("tensorcost.stream_pending") === "true";
  if (tcGet("tensorcost.send_row") !== "true" && !pending) return;
  var kept = JSON.parse(tcGet("tensorcost.usage_json"));
  var row = tcRow(kept.u, kept);
  if (pending) {
    // The stream's events fill in the counts; until then the row says no usage.
    context.setVariable("tensorcost.row_base", JSON.stringify(row));
    context.setVariable("tensorcost.log_rows", JSON.stringify([row]));
    context.setVariable("tensorcost.stream_row", "true");
    return;
  }
  // The counter's running total for this product this year, not the call's
  // tokens; kept for whoever reads the push.
  var used = tcInt(tcGet("ratelimit.TC-TokenCount.used.count"));
  if (used !== null) row.quota_used_count = used;
  context.setVariable("tensorcost.log_rows", JSON.stringify([row]));
}

if (tcProp("step", "") === "read") tcUsageRead();
else if (tcProp("step", "") === "row") tcUsageRow();
`;

/**
 * The streamed call's EventFlow step (TC-StreamUsage, in the proxy's
 * TargetEndpoint EventFlow): each event's usage is folded in, the tokens
 * this event added are left for TC-StreamTokenCount, and the row the
 * PostClientFlow sends is rebuilt with the counts so far.
 */
export const APIGEE_STREAM_JS = String.raw`/*
 * TensorCost for Apigee: the EventFlow step for streamed responses. Apache-2.0.
 * It reads only each event's usage counts and response id, and never changes
 * the event the client receives.
 */
function tcStreamEvent() {
  context.setVariable("tensorcost.stream_delta_tokens", "0");
  var b = tcEventJson(tcGet("response.event.current.data"));
  if (b === null) return;
  var acc = tcUsageNew();
  var kept = tcGet("tensorcost.stream_usage");
  if (kept !== null) {
    try {
      acc = JSON.parse(kept);
    } catch (e) {}
  }
  var before = acc.input + acc.output;
  tcUsageAdd(acc, b);
  context.setVariable("tensorcost.stream_usage", JSON.stringify(acc));
  var after = acc.input + acc.output;
  // Totals so far, so only what this event added is counted.
  context.setVariable("tensorcost.stream_delta_tokens", String(after > before ? after - before : 0));
  if (!acc.seen) return;
  var base = tcGet("tensorcost.row_base");
  if (base === null) return;
  var row = JSON.parse(base);
  row.input_tokens = acc.input;
  row.output_tokens = acc.output;
  row.cached_input_tokens = acc.cached;
  row.cache_write_tokens = acc.write;
  if (acc.id !== null) row.provider_response_id = acc.id;
  row.ended_at = new Date().toISOString();
  context.setVariable("tensorcost.log_rows", JSON.stringify([row]));
}

tcStreamEvent();
`;

// ------------------------------------------------------------------ bundles

const ADMIT_POLICIES = [
  "TC-Key",
  "TC-Correlation",
  "TC-Prepare",
  "TC-TokenQuota",
  "TC-QuotaRefuse",
  "TC-LookupFailMode",
  "TC-LookupAllow",
  "TC-Admit",
  "TC-ReadAnswer",
  "TC-Decide",
  "TC-RememberFailMode",
  "TC-Unavailable-RetryAfter",
  "TC-Unavailable",
  "TC-Refuse-RetryAfter",
  "TC-Refuse",
  "TC-Reroute",
  "TC-RememberAllow",
];

const USAGE_POLICIES = ["TC-UsageKey", "TC-UsageRead", "TC-TokenCount", "TC-UsageRow", "TC-UsageLog", "TC-Cancel"];

/** The admit flow's steps and their conditions, in order. */
export const APIGEE_ADMIT_STEPS: ReadonlyArray<{ name: string; condition?: string }> = [
  { name: "TC-Key" },
  { name: "TC-Correlation" },
  { name: "TC-Prepare" },
  { name: "TC-TokenQuota", condition: `tensorcost.quota_on = "true"` },
  { name: "TC-QuotaRefuse", condition: `(tensorcost.quota_on = "true") and (ratelimit.TC-TokenQuota.failed = "true")` },
  { name: "TC-LookupFailMode" },
  { name: "TC-LookupAllow" },
  { name: "TC-Admit", condition: `tensorcost.cached_allow != "allow"` },
  { name: "TC-ReadAnswer", condition: `tensorcost.cached_allow != "allow"` },
  { name: "TC-Decide", condition: `tensorcost.cached_allow != "allow"` },
  { name: "TC-RememberFailMode", condition: `tensorcost.remember_fail_mode = "true"` },
  { name: "TC-Unavailable-RetryAfter", condition: `(tensorcost.unavailable = "true") and (tensorcost.has_retry_after = "true")` },
  { name: "TC-Unavailable", condition: `(tensorcost.unavailable = "true") and (tensorcost.has_retry_after != "true")` },
  { name: "TC-Refuse-RetryAfter", condition: `(tcAnswer.decision = "refuse") and (tensorcost.unavailable != "true") and (tensorcost.has_retry_after = "true")` },
  { name: "TC-Refuse", condition: `(tcAnswer.decision = "refuse") and (tensorcost.unavailable != "true") and (tensorcost.has_retry_after != "true")` },
  { name: "TC-Reroute", condition: `(tcAnswer.decision = "reroute") and (tensorcost.reroute = "true")` },
  { name: "TC-RememberAllow", condition: `(tcAnswer.decision = "allow") and (tensorcost.cache_allow = "true")` },
];

export const APIGEE_USAGE_STEPS: ReadonlyArray<{ name: string; condition?: string }> = [
  { name: "TC-UsageKey" },
  { name: "TC-UsageRead" },
  { name: "TC-TokenCount", condition: `(tensorcost.count_tokens = "true") and (tensorcost.quota_on = "true")` },
  { name: "TC-UsageRow", condition: `(tensorcost.send_row = "true") or (tensorcost.stream_pending = "true")` },
  { name: "TC-UsageLog", condition: `tensorcost.send_row = "true"` },
  { name: "TC-Cancel", condition: `tensorcost.send_cancel = "true"` },
];

function flow(steps: ReadonlyArray<{ name: string; condition?: string }>, comment: string[]): string {
  return doc([`<!--`, ...comment.map((c) => `  ${c}`), `-->`, `<SharedFlow name="default">`, ...steps.flatMap((s) => step(s.name, s.condition)), `</SharedFlow>`]);
}

/** The tensorcost-admit bundle's files. */
export function renderApigeeAdmitBundle(input: ApigeeFlowInput): ApigeeBundle {
  const { base, key, failMode, verify } = checked(input);
  const open = failMode === "open";
  const p = (name: string) => `sharedflowbundle/policies/${name}.xml`;
  const files: Record<string, string> = {
    [`sharedflowbundle/${APIGEE_ADMIT_FLOW}.xml`]: descriptor(
      APIGEE_ADMIT_FLOW,
      `Asks TensorCost before each model call and follows its decision. Fail mode when TensorCost can't answer: ${failMode}.`,
      ADMIT_POLICIES,
      ["tensorcost-common.js", "tensorcost-admit.js"],
    ),
    "sharedflowbundle/sharedflows/default.xml": flow(APIGEE_ADMIT_STEPS, [
      `${APIGEE_ADMIT_FLOW}: include it with a FlowCallout in each LLM proxy's request PreFlow,`,
      `after the VerifyAPIKey policy ${verify} and before policies of your own that can refuse a call.`,
      `Fail mode when TensorCost can't answer: ${failMode}.`,
    ]),
    [p("TC-Key")]: keyPolicy("TC-Key", key),
    [p("TC-Correlation")]: doc([
      `<AssignMessage name="TC-Correlation">`,
      `    <DisplayName>TC-Correlation</DisplayName>`,
      `    <!-- The call's correlation id is Apigee's own messageid; a caller's header is overwritten. -->`,
      `    <AssignTo createNew="false" transport="http" type="request"/>`,
      `    <Set>`,
      `        <Headers>`,
      `            <Header name="x-tensorcost-correlation-id">{messageid}</Header>`,
      `        </Headers>`,
      `    </Set>`,
      `    <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>`,
      `</AssignMessage>`,
    ]),
    [p("TC-Prepare")]: jsPolicy("TC-Prepare", "tensorcost-admit.js", { step: "prepare", failMode, verifyApiKeyPolicy: verify }),
    [p("TC-TokenQuota")]: tokenQuota("TC-TokenQuota", verify, "EnforceOnly"),
    [p("TC-QuotaRefuse")]: doc([
      `<RaiseFault name="TC-QuotaRefuse">`,
      `    <DisplayName>TC-QuotaRefuse</DisplayName>`,
      `    <!-- The product's pushed quota is spent: TensorCost's refusal, not Apigee's generic quota fault. -->`,
      `    <FaultResponse>`,
      `        <Set>`,
      `            <Payload contentType="application/json">{tensorcost.quota_error_body}</Payload>`,
      `            <StatusCode>429</StatusCode>`,
      `            <ReasonPhrase>Too Many Requests</ReasonPhrase>`,
      `        </Set>`,
      `    </FaultResponse>`,
      `    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>`,
      `</RaiseFault>`,
    ]),
    [p("TC-LookupFailMode")]: lookup("TC-LookupFailMode", "fail-mode", "tensorcost.last_fail_mode"),
    [p("TC-LookupAllow")]: lookup("TC-LookupAllow", "ref:tensorcost.cache_key", "tensorcost.cached_allow"),
    [p("TC-Admit")]: doc([
      `<ServiceCallout name="TC-Admit" continueOnError="${open ? "true" : "false"}" enabled="true">`,
      `    <DisplayName>TC-Admit</DisplayName>`,
      open
        ? `    <!-- Fail open: a timeout or error leaves tcAdmit without a 200 answer, and TC-Decide lets the call through. -->`
        : `    <!-- Fail closed: a timeout or error faults the proxy here, and the target is never called. -->`,
      `    <Request variable="tcAdmitRequest" clearPayload="true">`,
      `        <Set>`,
      `            <Headers>`,
      `                <Header name="Authorization">Bearer {private.tensorcost.key}</Header>`,
      `                <Header name="User-Agent">${text(APIGEE_USER_AGENT)}</Header>`,
      `            </Headers>`,
      `            <Verb>POST</Verb>`,
      `            <Payload contentType="application/json">{tensorcost.admit_body}</Payload>`,
      `        </Set>`,
      `        <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>`,
      `    </Request>`,
      `    <Response>tcAdmit</Response>`,
      `    <Timeout>${APIGEE_ADMIT_TIMEOUT_MS}</Timeout>`,
      `    <HTTPTargetConnection>`,
      `        <URL>${text(`${base}/v1/gateway/admit`)}</URL>`,
      `    </HTTPTargetConnection>`,
      `</ServiceCallout>`,
    ]),
    [p("TC-ReadAnswer")]: doc([
      `<ExtractVariables name="TC-ReadAnswer" continueOnError="true">`,
      `    <DisplayName>TC-ReadAnswer</DisplayName>`,
      `    <!-- tcAdmit.content: decision, model and message. TC-Decide clears decision unless the answer was a 200. -->`,
      `    <Source clearPayload="false">tcAdmit</Source>`,
      `    <VariablePrefix>tcAnswer</VariablePrefix>`,
      `    <JSONPayload>`,
      `        <Variable name="decision">`,
      `            <JSONPath>$.decision</JSONPath>`,
      `        </Variable>`,
      `        <Variable name="model">`,
      `            <JSONPath>$.model</JSONPath>`,
      `        </Variable>`,
      `        <Variable name="message">`,
      `            <JSONPath>$.message</JSONPath>`,
      `        </Variable>`,
      `    </JSONPayload>`,
      `    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>`,
      `</ExtractVariables>`,
    ]),
    [p("TC-Decide")]: jsPolicy("TC-Decide", "tensorcost-admit.js", { step: "decide", failMode, verifyApiKeyPolicy: verify }),
    [p("TC-RememberFailMode")]: populate("TC-RememberFailMode", "fail-mode", "tensorcost.seen_fail_mode", { seconds: APIGEE_FAIL_MODE_MEMORY_SECONDS }),
    [p("TC-Unavailable-RetryAfter")]: raiseFault("TC-Unavailable-RetryAfter", 503, true),
    [p("TC-Unavailable")]: raiseFault("TC-Unavailable", 503, false),
    [p("TC-Refuse-RetryAfter")]: raiseFault("TC-Refuse-RetryAfter", 429, true),
    [p("TC-Refuse")]: raiseFault("TC-Refuse", 429, false),
    [p("TC-Reroute")]: doc([
      `<AssignMessage name="TC-Reroute">`,
      `    <DisplayName>TC-Reroute</DisplayName>`,
      `    <!-- The request body with its model set to the model TensorCost answered. -->`,
      `    <AssignTo createNew="false" transport="http" type="request"/>`,
      `    <Set>`,
      `        <Payload contentType="application/json">{tensorcost.rerouted_body}</Payload>`,
      `    </Set>`,
      `    <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>`,
      `</AssignMessage>`,
    ]),
    [p("TC-RememberAllow")]: populate("TC-RememberAllow", "ref:tensorcost.cache_key", "tensorcost.cache_value", { ref: "tensorcost.cache_ttl" }),
    "sharedflowbundle/resources/jsc/tensorcost-common.js": APIGEE_COMMON_JS,
    "sharedflowbundle/resources/jsc/tensorcost-admit.js": APIGEE_ADMIT_JS,
  };
  return { name: APIGEE_ADMIT_FLOW, files: sorted(files) };
}

/** A ServiceCallout with no <Response>: the proxy doesn't wait for it. */
function fireAndForget(name: string, requestVar: string, url: string, payload: boolean, comment: string): string {
  return doc([
      `<ServiceCallout name=${attr(name)} continueOnError="true" enabled="true">`,
      `    <DisplayName>${name}</DisplayName>`,
      `    <!-- ${comment} No <Response>: the proxy doesn't wait, and a lost push isn't seen here. -->`,
      `    <Request variable=${attr(requestVar)} clearPayload="true">`,
      `        <Set>`,
      `            <Headers>`,
      `                <Header name="Authorization">Bearer {private.tensorcost.key}</Header>`,
      `                <Header name="User-Agent">${text(APIGEE_USER_AGENT)}</Header>`,
      `            </Headers>`,
      `            <Verb>POST</Verb>`,
      ...(payload ? [`            <Payload contentType="application/json">{tensorcost.log_rows}</Payload>`] : []),
      `        </Set>`,
      `        <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>`,
      `    </Request>`,
      `    <Timeout>${APIGEE_ADMIT_TIMEOUT_MS}</Timeout>`,
      `    <HTTPTargetConnection>`,
      `        <URL>${text(url)}</URL>`,
      `    </HTTPTargetConnection>`,
      `</ServiceCallout>`,
    ]);
}

/** The tensorcost-usage bundle's files. */
export function renderApigeeUsageBundle(input: ApigeeFlowInput): ApigeeBundle {
  const { base, key, failMode, verify } = checked(input);
  const p = (name: string) => `sharedflowbundle/policies/${name}.xml`;
  const callout = (name: string, url: string, payload: boolean, comment: string) => fireAndForget(name, name === "TC-UsageLog" ? "tcUsageRequest" : "tcCancelRequest", url, payload, comment);
  const files: Record<string, string> = {
    [`sharedflowbundle/${APIGEE_USAGE_FLOW}.xml`]: descriptor(
      APIGEE_USAGE_FLOW,
      "Counts each model call's tokens against the pushed product quota and reports the call to TensorCost, without its content.",
      USAGE_POLICIES,
      ["tensorcost-common.js", "tensorcost-usage.js"],
    ),
    "sharedflowbundle/sharedflows/default.xml": flow(APIGEE_USAGE_STEPS, [
      `${APIGEE_USAGE_FLOW}: include it with a FlowCallout first in each LLM proxy's TargetEndpoint response PreFlow,`,
      `and again in the ProxyEndpoint's DefaultFaultRule with <AlwaysEnforce>true</AlwaysEnforce>. It runs once a call.`,
      `A streamed response's row is sent later, by ${APIGEE_USAGE_FINAL_FLOW} in the PostClientFlow.`,
    ]),
    [p("TC-UsageKey")]: keyPolicy("TC-UsageKey", key),
    [p("TC-UsageRead")]: jsPolicy("TC-UsageRead", "tensorcost-usage.js", { step: "read", failMode, verifyApiKeyPolicy: verify }),
    [p("TC-TokenCount")]: tokenQuota("TC-TokenCount", verify, "CountOnly"),
    [p("TC-UsageRow")]: jsPolicy("TC-UsageRow", "tensorcost-usage.js", { step: "row", failMode, verifyApiKeyPolicy: verify }),
    [p("TC-UsageLog")]: callout("TC-UsageLog", `${base}/v1/gateway/logs?format=tensorcost`, true, "One row a call, fire and forget."),
    [p("TC-Cancel")]: callout(
      "TC-Cancel",
      `${base}/v1/gateway/admit/{tensorcost.decision_id}/cancel`,
      false,
      "An allowed call that never reached the target: its hold goes now.",
    ),
    "sharedflowbundle/resources/jsc/tensorcost-common.js": APIGEE_COMMON_JS,
    "sharedflowbundle/resources/jsc/tensorcost-usage.js": APIGEE_USAGE_JS,
  };
  return { name: APIGEE_USAGE_FLOW, files: sorted(files) };
}

/**
 * The tensorcost-usage-final bundle: the streamed call's row, sent from the
 * PostClientFlow once the stream has gone to the client. A PostClientFlow
 * takes only FlowCallout, MessageLogging and ServiceCallout, and a shared
 * flow it calls must hold only those, so this one is the callout alone: the
 * key is already in private.tensorcost.key from tensorcost-admit, and the
 * EventFlow's TC-StreamUsage built the row.
 */
export function renderApigeeUsageFinalBundle(input: ApigeeFlowInput): ApigeeBundle {
  const { base } = checked(input);
  const files: Record<string, string> = {
    [`sharedflowbundle/${APIGEE_USAGE_FINAL_FLOW}.xml`]: descriptor(
      APIGEE_USAGE_FINAL_FLOW,
      "Reports a streamed model call to TensorCost once the stream has ended, without its content.",
      ["TC-StreamLog"],
      [],
    ),
    "sharedflowbundle/sharedflows/default.xml": flow([{ name: "TC-StreamLog", condition: `tensorcost.stream_row = "true"` }], [
      `${APIGEE_USAGE_FINAL_FLOW}: include it with a FlowCallout in each LLM proxy's PostClientFlow.`,
      `It sends the row TC-StreamUsage built from a streamed response's events.`,
    ]),
    "sharedflowbundle/policies/TC-StreamLog.xml": fireAndForget("TC-StreamLog", "tcStreamRequest", `${base}/v1/gateway/logs?format=tensorcost`, true, "A streamed call's row, after the stream, fire and forget."),
  };
  return { name: APIGEE_USAGE_FINAL_FLOW, files: sorted(files) };
}

/**
 * An example API proxy (apiproxy/) with every TensorCost attachment in
 * place, and the two policies an EventFlow needs, which a proxy has to carry
 * itself: an EventFlow takes only a few policy types, FlowCallout not among
 * them. Copy what your proxy lacks; the target here is a Vertex AI host.
 */
export function renderApigeeProxyExample(input: ApigeeFlowInput): ApigeeBundle {
  const { verify } = checked(input);
  const p = (name: string) => `apiproxy/policies/${name}.xml`;
  const fc = (name: string, flowName: string) =>
    doc([`<FlowCallout name=${attr(name)}>`, `    <DisplayName>${name}</DisplayName>`, `    <SharedFlowBundle>${flowName}</SharedFlowBundle>`, `</FlowCallout>`]);
  const policies = [verify, "FC-TensorCostAdmit", "FC-TensorCostUsage", "FC-TensorCostUsageFinal", "TC-StreamUsage", "TC-StreamTokenCount"];
  const files: Record<string, string> = {
    [`apiproxy/${APIGEE_PROXY_EXAMPLE}.xml`]: doc([
      `<APIProxy revision="1" name=${attr(APIGEE_PROXY_EXAMPLE)}>`,
      `    <DisplayName>${APIGEE_PROXY_EXAMPLE}</DisplayName>`,
      `    <Description>An LLM proxy with TensorCost's budget check, usage report and streamed usage attached.</Description>`,
      `    <Policies>`,
      ...policies.map((x) => `        <Policy>${text(x)}</Policy>`),
      `    </Policies>`,
      `    <Resources>`,
      `        <Resource>jsc://tensorcost-common.js</Resource>`,
      `        <Resource>jsc://tensorcost-stream.js</Resource>`,
      `    </Resources>`,
      `    <ProxyEndpoints>`,
      `        <ProxyEndpoint>default</ProxyEndpoint>`,
      `    </ProxyEndpoints>`,
      `    <TargetEndpoints>`,
      `        <TargetEndpoint>default</TargetEndpoint>`,
      `    </TargetEndpoints>`,
      `</APIProxy>`,
    ]),
    "apiproxy/proxies/default.xml": doc([
      `<ProxyEndpoint name="default">`,
      `    <PreFlow name="PreFlow">`,
      `        <Request>`,
      ...step(verify).map((l) => `        ${l}`),
      `            <!-- After VerifyAPIKey, before your own policies that can refuse a call. -->`,
      ...step("FC-TensorCostAdmit").map((l) => `        ${l}`),
      `        </Request>`,
      `        <Response/>`,
      `    </PreFlow>`,
      `    <!-- A streamed call's row goes once the stream has reached the client. -->`,
      `    <PostClientFlow name="PostClientFlow">`,
      `        <Response>`,
      ...step("FC-TensorCostUsageFinal", `tensorcost.stream_row = "true"`).map((l) => `        ${l}`),
      `        </Response>`,
      `    </PostClientFlow>`,
      `    <!-- A proxy has one DefaultFaultRule: merge this step into yours if it has one. -->`,
      `    <DefaultFaultRule name="tensorcost">`,
      ...step("FC-TensorCostUsage").map((l) => `    ${l}`),
      `        <AlwaysEnforce>true</AlwaysEnforce>`,
      `    </DefaultFaultRule>`,
      `    <HTTPProxyConnection>`,
      `        <BasePath>/llm</BasePath>`,
      `    </HTTPProxyConnection>`,
      `    <RouteRule name="default">`,
      `        <TargetEndpoint>default</TargetEndpoint>`,
      `    </RouteRule>`,
      `</ProxyEndpoint>`,
    ]),
    "apiproxy/targets/default.xml": doc([
      `<TargetEndpoint name="default">`,
      `    <PreFlow name="PreFlow">`,
      `        <Request/>`,
      `        <Response>`,
      `            <!-- First in the target's response, before any of its own policies: it reads the status as the target sent it. -->`,
      ...step("FC-TensorCostUsage").map((l) => `        ${l}`),
      `        </Response>`,
      `    </PreFlow>`,
      `    <!-- Each event of a text/event-stream response: its usage, and the tokens it adds to the product quota. -->`,
      `    <EventFlow name="EventFlow" content-type="text/event-stream">`,
      `        <Response>`,
      ...step("TC-StreamUsage").map((l) => `        ${l}`),
      ...step("TC-StreamTokenCount", `(tensorcost.quota_on = "true") and (tensorcost.stream_delta_tokens != "0")`).map((l) => `        ${l}`),
      `        </Response>`,
      `    </EventFlow>`,
      `    <HTTPTargetConnection>`,
      `        <URL>https://us-central1-aiplatform.googleapis.com</URL>`,
      `    </HTTPTargetConnection>`,
      `</TargetEndpoint>`,
    ]),
    [p(verify)]: doc([
      `<VerifyAPIKey name=${attr(verify)}>`,
      `    <DisplayName>${text(verify)}</DisplayName>`,
      `    <APIKey ref="request.header.x-apikey"/>`,
      `</VerifyAPIKey>`,
    ]),
    [p("FC-TensorCostAdmit")]: fc("FC-TensorCostAdmit", APIGEE_ADMIT_FLOW),
    [p("FC-TensorCostUsage")]: fc("FC-TensorCostUsage", APIGEE_USAGE_FLOW),
    [p("FC-TensorCostUsageFinal")]: fc("FC-TensorCostUsageFinal", APIGEE_USAGE_FINAL_FLOW),
    [p("TC-StreamUsage")]: doc([
      `<Javascript name="TC-StreamUsage" timeLimit="200" continueOnError="true">`,
      `    <DisplayName>TC-StreamUsage</DisplayName>`,
      `    <Properties>`,
      `        <Property name="verifyApiKeyPolicy">${text(verify)}</Property>`,
      `    </Properties>`,
      `    <IncludeURL>jsc://tensorcost-common.js</IncludeURL>`,
      `    <ResourceURL>jsc://tensorcost-stream.js</ResourceURL>`,
      `</Javascript>`,
    ]),
    [p("TC-StreamTokenCount")]: tokenQuota("TC-StreamTokenCount", verify, "CountOnly", "{tensorcost.stream_delta_tokens}"),
    "apiproxy/resources/jsc/tensorcost-common.js": APIGEE_COMMON_JS,
    "apiproxy/resources/jsc/tensorcost-stream.js": APIGEE_STREAM_JS,
  };
  return { name: APIGEE_PROXY_EXAMPLE, files: sorted(files) };
}

/** Every bundle's files: the three shared flows and the example proxy. */
export function renderApigeeSharedFlowFiles(input: ApigeeFlowInput): { admit: ApigeeBundle; usage: ApigeeBundle; final: ApigeeBundle; proxy: ApigeeBundle } {
  return { admit: renderApigeeAdmitBundle(input), usage: renderApigeeUsageBundle(input), final: renderApigeeUsageFinalBundle(input), proxy: renderApigeeProxyExample(input) };
}

/**
 * The bundles as zips, base64: what the Apigee API's sharedflows import or
 * the Apigee UI's "Upload bundle" takes (sharedflowbundle/ at the zip's
 * root; apiproxy/ for the example proxy).
 */
export function renderApigeeSharedFlows(input: ApigeeFlowInput): { admit: string; usage: string; final: string; proxy: string } {
  const b = renderApigeeSharedFlowFiles(input);
  return { admit: base64(zipFiles(b.admit.files)), usage: base64(zipFiles(b.usage.files)), final: base64(zipFiles(b.final.files)), proxy: base64(zipFiles(b.proxy.files)) };
}

function sorted(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ------------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip of the files, stored without compression, every entry dated
 * 1980-01-01 so the same files always give the same bytes.
 */
export function zipFiles(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const [path, content] of Object.entries(files)) {
    const name = enc.encode(path);
    const data = enc.encode(content);
    const crc = crc32(data);
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // names are UTF-8
    h.setUint16(8, 0, true); // stored
    h.setUint16(10, 0, true);
    h.setUint16(12, DOS_DATE, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, 0, true);
    head.set(name, 30);
    const dir = new Uint8Array(46 + name.length);
    const d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x0800, true);
    d.setUint16(10, 0, true);
    d.setUint16(12, 0, true);
    d.setUint16(14, DOS_DATE, true);
    d.setUint32(16, crc, true);
    d.setUint32(20, data.length, true);
    d.setUint32(24, data.length, true);
    d.setUint16(28, name.length, true);
    d.setUint32(42, offset, true);
    dir.set(name, 46);
    local.push(head, data);
    central.push(dir);
    offset += head.length + data.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, central.length, true);
  e.setUint16(10, central.length, true);
  e.setUint32(12, dirSize, true);
  e.setUint32(16, offset, true);
  const parts = [...local, ...central, end];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64[c & 63]! : "=";
  }
  return out;
}
