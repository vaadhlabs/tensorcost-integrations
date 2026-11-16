/*
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
