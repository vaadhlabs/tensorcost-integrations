# Counting AI spend once

Licensed CC-BY-4.0 (see ../LICENSE.md). The code next to this file is Apache-2.0.

One model call can reach a cost system several times. The proxy that sent it
writes a row, the SDK that made it writes another, a gateway (LiteLLM, Kong,
Portkey) logs it, and the provider's own report and bill include it. Sum all of
them and the call costs several times what it cost. This document says how
TensorCost counts it once, so that gateway and SDK authors can make their
output easy to match and other cost tools can do the same.

The reference code is `packages/contracts/src/same-call.ts` at the root of this
repository. The cases it is tested with are in `packages/contracts/src/same-call.cases.ts`. Both are exported from TensorCost's source;
this repository does not hold a different copy.

## Four kinds of row

A row is one record of spend, with a provider, a model, token counts, a start
time and a cost. Rows come in four kinds, and the kind decides how a row is
treated.

A bill line is money the provider charged: a cloud cost and usage report, an
Azure or GCP export. It is the most authoritative row there is.

A reported row is usage the provider reports about itself without being a bill
line: a usage API, the Bedrock invocation log. It has token counts and often a
cost, but it is a total over many calls, or a log of calls, not a witness
placed in the request path.

A metered row is one TensorCost's own proxy or SDK wrote while the call went
through it. It has exact token counts and a start time, taken from the
response.

A gateway witness is a row a customer's gateway logged for a call. It saw the
call but did not price it against a bill, so it can confirm that a call
happened and never outranks a bill.

In `same-call.ts` these are ranks: 0 proxy, 1 SDK, 2 gateway, 3 reported.
A bill line is rank 3 (reported) with cost priority 1 (below).

## The call keys

Two rows are the same call when one of two keys matches.

The response id is the key to prefer. It is the provider's own identifier for
the response (`msg_...` from Anthropic, `chatcmpl-...` or `resp_...` from
OpenAI, the request id on Bedrock), the value OpenTelemetry's GenAI
conventions call `gen_ai.response.id`. Two rows match when tenant, provider and
response id are equal and both started on the same UTC day. Two different ids
are two calls, even if everything else about them is equal.

The fingerprint is the fallback for rows where at least one side has no id.
Two rows pair when provider, input tokens, output tokens, cached input tokens
and the UTC minute of the start time are all equal, and they come from two
different metering sources, at least one of them a gateway. A metering source
is the proxy, the SDK, or one particular gateway. Reported rows never take part
in the fingerprint: they are weighed against the calls by the bill step, not
paired with them.

The fingerprint compares three counts, and only means something if every
writer counts them the same way. `input_tokens` includes cache reads and cache
writes, `output_tokens` is the completion, and `cached_input_tokens` is the
cache reads. (A fourth count, cache write tokens, is stored but is not part of
the fingerprint.) Providers differ here. An OpenAI-style response reports
prompt tokens that already include the cached part. An Anthropic-style
response reports input tokens that exclude cache reads and writes. Take a call
with 300 input tokens, 800 cache reads and 100 cache writes in the Anthropic
style: the stored `input_tokens` is 1,200 (300 + 800 + 100), and
`cached_input_tokens` is 800. A gateway that logs 300 will never pair with a
writer that logs 1,200, so add the cache counts to the input before you emit
it.

The fingerprint is deliberately weak, because many calls have the same token
counts in the same minute. Pairing is therefore one to one. Within a
fingerprint, number each source's rows by start time and then id. The nth row
of one source pairs with the nth row of another. If the SDK saw five calls
with a given fingerprint and Kong saw three, three pairs collapse and the SDK
keeps two it alone saw. The survivor of a pair is picked by the order below, so
a gateway row TensorCost pulled from the gateway stays against an SDK row. A
Kong row posted over OpenTelemetry is client data, like the SDK's, so at the
same cost priority the SDK row stays. A gateway call the SDK never saw is
kept. A source never pairs with itself, so two rows from one gateway with the same
fingerprint both stand.

Pairing is per source, so a gateway row pairs with one row from each other
source. One call seen by the proxy, the SDK and a gateway collapses to one
row. The same rule means two different calls with an identical fingerprint in
the same minute can collapse: a proxy call and a separate SDK call with the
same tokens, both seen by a gateway, lose the gateway's row to the proxy
and the SDK's to the gateway. That undercounts, which is the one unsafe
direction here; sending the response id on every record avoids it.

The fingerprint arm does not apply when both rows carry a response id. If the
ids are equal the first key has already matched them, and if they differ they
are two calls.

## The safe miss

Every place the rule can fail to match, it fails by counting twice, not by
dropping a real call. For a spend cap that is the safe direction: you may stop a
developer a little early, you never let spend run past a cap unseen.

- A pair split by a minute boundary is not matched by the fingerprint.
- Two rows with one response id either side of UTC midnight are not matched.
  Keeping each day to its own rows also means a day's result depends only on
  that day's rows, so a rolled-up day stays valid until one of its rows changes.
- Where the SQL reference reads an index that does not exist yet, it turns that
  arm off and counts twice until the index is built.

## Which row survives

When rows are the same call, one survives and the rest are left out of the
count. Nothing is deleted or rewritten; the step runs when the rows are read.
The survivor is picked by one order, whichever way the rows were matched:

1. rows that carry money (a real cost above 0, not an estimate) first, then
   rows that don't, then
2. rows the platform or our own pull saw first: proxy rows, and gateway rows
   TensorCost pulled from the gateway itself (LiteLLM, Portkey logs). Every
   other row after them: SDK rows, reported rows, and gateway rows that
   arrived over the SDK's pipe (Kong's OpenTelemetry spans), then
3. the lowest cost priority, then
4. the proxy row, then the SDK row, then a gateway row, then a reported one,
5. then the lowest id.

The first key is there because a witness that has no price for a call
stores its tokens at 0: a proxy row for a model with no rate, a gateway log
that named no cost. If it beat a witness of the same call that carries the
cost, the call would read as free. A proxy row whose cost is only a guess
from the request, or a cost an SDK reported that was moved onto the proxy's
row, is treated the same way, or it would stand in for the real cost.
TensorCost marks both with `metadata.cost_estimated` (`request_estimate`,
`sdk_reported`), and a call the provider may or may not have billed (a
timeout, a 5xx, a stream that ended without its usage) with
`metadata.cost_unknown` as well. Such a row still counts when no other witness has money. The key
reads the cost and those two markers, which only the server writes, so it
holds for any writer and nothing a client sends can move it. A row at 0, a free model's included, gets no
boost, so between two rows without money the rest of the order decides, and
the call reads $0 whichever stays.

So a pulled gateway row with money loses only to a proxy row with money or
another pulled gateway's row with money. A client supplies an SDK row's
response id, token counts and cost, and the span attributes that label a
Kong row, so none of those rows displaces a proxy or pulled gateway row, on
either key, unless the client row carries money and the server row doesn't.
That can only raise the count. A bill line
(priority 1) with the same response id loses to them as well; the bill is
weighed against the metered calls in the next step. A Kong row still counts
as a gateway row for whether the token fingerprint applies. Kong rows move up
to the first group once Kong reports with a credential of its own.

Cost priority comes from where the number came from: 1 for a bill line (cloud
cost and usage report, Azure or GCP export), 2 for a provider API, 3 for a
raw log, 4 for a metrics API, 99 for a backfill. Lower is more authoritative.
A gateway row's priority is clamped to no better than 2, since a gateway is a
witness and never a bill. In practice the proxy and SDK rows it sees carry 2,
so a gateway row ties with a proxy row on priority and loses to it on source
order.

The losing row's attribution, such as the gateway's caller name, is not merged
into the survivor.

## The bill is the truth

If a provider's bill says the month cost 1,000 and the metered rows add up to
1,200 after this step, the bill wins. Metered rows that the bill covers stop
counting; only metered spend the bill has not yet reached counts on top of it.
That comparison (matching metered calls to billed money) is a separate step
that runs after the one described here, and it is not part of this
specification or this repository. Its input is the survivors this step
returns: it expects each call once.

## What a gateway can do for you

Emit the provider's response id on every record (`gen_ai.response.id` as an
OpenTelemetry span attribute, or the `id` field of the provider response) and
the first key matches, with no fingerprint guesswork. Without it the
fingerprint needs exact input (including cache reads and writes), output and
cache read token counts, as described above, and a start time accurate to the
minute.

## The reference code

`packages/contracts/src/same-call.ts` has two forms of the rule.

`sameCallSurvivors(rows)` is plain TypeScript. It models the rule with both
arms on; it has no state for a missing index, which only the SQL has. Give it one tenant's rows as
`SameCallRow` (id, provider, provider_response_id, source_rank, cost_priority,
gateway_source, the three token counts, started_at, total_cost_cents) and it
returns the
survivors in input order. `sameCallRowOf` builds a `SameCallRow` from a stored
row.

`aiRowSameCallSql(alias)` and the two function definitions
`SAME_CALL_RESPONSE_ID_FN_SQL` and `SAME_CALL_FINGERPRINT_FN_SQL` are the same
rule in PostgreSQL, the reference implementation against TensorCost's own
table, `ai.ai_spend_events`. They are not a drop-in for another schema. To
adapt them you need, per row:

- `tenant_id`, `provider`, `provider_response_id` (nullable), `started_at`;
- `input_tokens`, `output_tokens`, `cached_input_tokens`;
- `cost_priority` (see above) and `superseded_at` (null for a live row);
- `total_cost_cents`, `metadata->>'cost_estimated'` and
  `metadata->>'cost_unknown'` (above 0, not an estimate and not of unknown
  billing is a row with money);
- `metadata` as jsonb, where `metadata->>'source'` is `applied-mode-proxy` or
  `tier2-sdk` for proxy and SDK rows and `metadata->>'gateway_source'` names
  the gateway for a gateway witness;
- one index on (tenant, provider, response id) and one on the fingerprint
  columns, which are what keep each lookup cheap.

Proposed FOCUS columns for token counts and call identity are being drafted.

Rename the table and columns, keep the shape of the two functions.

## Tests

`packages/contracts/src/same-call.cases.ts` is a table of cases, each a set of rows and the keys of
the rows that must survive: the same id from two sources, ids that differ,
midnight and minute boundaries, three SDK rows against two Kong rows, a
gateway call nobody else saw. TensorCost runs the same table against both the
TypeScript and the SQL. Here, `same-call.spec.ts` runs it against the
TypeScript.

    cd spec/counted-once
    npm install
    npx vitest run

If you write your own implementation, running these cases against it is the
quickest check that you agree with this one.
