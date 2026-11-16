/*
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
