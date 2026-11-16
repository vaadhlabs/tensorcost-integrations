/*
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
