/*
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
