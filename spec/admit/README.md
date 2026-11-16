# The TensorCost admit protocol

Licensed CC-BY-4.0 (see ../LICENSE.md). `openapi.yaml` next to this file and
the code in `admit-mock/` and `admit-conformance/` are Apache-2.0.

A gateway (LiteLLM, Azure API Management, Apigee, Kong, or any proxy that can
make an HTTP call before a model call) asks TensorCost whether a model call may
go ahead, and does what the answer says. This document says what the answers
mean and what a client has to do with them. It is written for people building
that client: a gateway plugin, a policy template, a proxy of your own.

`openapi.yaml` is the machine-readable contract. It is exported from
TensorCost's own source on every release and is never edited in this
repository; where this text and the file disagree, the file wins and this text
has a bug. `admit-mock/` is a local server that answers like TensorCost, and
`admit-conformance/` holds the cases a client is tested with against it.

## The exchange

The client sends `POST {base}/v1/gateway/admit` with a JSON body, before the
model call. The server URL in `openapi.yaml` ends in `/v1` and its paths are
written under it, so server plus path is the route. The same route is also
served at `/api/inference-proxy/v1/gateway/admit`. The request
carries the gateway connection's own key, `Authorization: Bearer tcgw_…`,
which TensorCost shows once when an admin creates the connection. It is not an
SDK token, and an SDK token is refused here.

Only `model` is required. The rest makes the answer better: `callers` (who is
calling, below), `provider`, `max_tokens` and `input_tokens` (the call's size,
which its reservation is priced from), `accepts_models` and `can_reroute`
(below), `correlation_id` (the gateway's own call id, which TensorCost uses to
match the call's spend row later), and `environment`, `application`,
`agent_id`, `workflow_id`, `tags` and `customer` (below). Unknown fields are
ignored. A field
TensorCost can't use, such as a caller with no id or a list past its cap of 32,
is dropped and named in the answer's `detail` after `ignored:`, and the call is
still checked.

TensorCost gives its own check 800 ms. The snippets TensorCost generates set a
1,000 ms timeout on the round trip, and a client should use about the same.

## What admit checks

Admit runs the workspace's compliance rules, an operator's stop on the run
(`workflow_id`), the workspace's cost budgets (hard caps, margin floors and
fixed customer limits, each holding the call's reservation; see "Reservations
and holds"), model governance and interventions.

It does not check agent run budgets or the agent, team and workspace period
caps that TensorCost's own proxy keeps. Those count the spend the proxy and
the SDK see as calls happen, and a gateway's calls never reach them, so
checking them at admit would read a figure the gateway's calls never move and
answer allow every time. A workspace that wants a ceiling on gateway traffic
sets a cost budget. `period_budget_exceeded` is still in the contract's reason
list for older clients; admit doesn't send it.

## The customer

`customer` is the end customer the call is for, the same id an SDK call sends
as `x-tc-customer`: trimmed, at most 128 characters. Admit judges the call
against that customer's margin floors and fixed customer limits, and refuses
with `customer_limit_reached` or `margin_floor_reached` when one is reached.
Its holds on those limits are that customer's alone. A call with no `customer`
is judged by no customer's limit, so a client that knows the customer should
always send it.

The call's spend row should name the customer too: `customer` on a
`format=tensorcost` row, or `metadata.tensorcost_customer` on a
`format=litellm` row. A row that names none stores the customer its admit
check carried, while TensorCost still has admit's record of the call (an
hour). The shipped templates read it from each request's `x-tc-customer`
header (Azure APIM, Apigee) or from the request's metadata key
`tensorcost_customer` (LiteLLM).

## The decision

Every answered decision is HTTP 200 with a JSON body. Its `decision` is one of
three:

- `allow`: send the call as asked.
- `refuse`: don't send it. `reason` says why, and `message` is what to show the
  person whose call it was. A budget refusal's message names the budget and
  who can raise it. `retry_after_seconds`, when present, is when trying again
  could give a different answer.
- `reroute`: send it, but to `model` instead. See "Reroute is advice".

Every answer also carries `decision_id` (a uuid, which the cancel route takes),
`reservation_cents` and how it was sized (`reservation_basis`,
`reservation_kind`), `attribution` (the team and developer the callers mapped
to), `fail_mode` and `cache_ttl_seconds`. `degraded`, `fail_mode_known` and
`detail` appear only when they have something to say.

## Refusals arrive as 200

A refusal is an HTTP 200 whose `decision` is `refuse`. TensorCost never
answers a refusal with a 403, a 429 or any other error status. A client branches
on `decision` in the body, never on the status code.

The reason is the gateways themselves. Apigee's ServiceCallout with
`continueOnError="true"` and an APIM policy with `ignore-error` are how a
gateway is set up to fail open, and they can't tell a 403 from an outage: both
are an error, and both let the call through. A refusal sent as a 200 body
reaches the policy as data and is followed.

So a non-2xx status always means TensorCost failed: a key it doesn't know
(401), a body that isn't a JSON object (400), a check of the key it couldn't
finish (503), or no answer at all. "Fail open and fail closed" says what the
client does then.

Throttling follows the same rule. A gateway connection has an admit rate
(60,000 checks a minute unless an admin sets another). Past it the answer is
still a 200, decided by the workspace's fail mode, with `detail` "throttled":
an open workspace allows with `degraded: true` and holds nothing, a closed
one refuses with reason `check_unavailable` and a `retry_after_seconds` to
the next minute. A client follows that decision as it would any other. The
only 429 the route sends is for a key TensorCost doesn't have cached (a made-up
key, or a live key's first call in a minute) past 100 a minute from one
address, and that is not a decision.

Two refusal reasons mean TensorCost couldn't check rather than that a budget
is spent: `check_unavailable` (the workspace is set to fail closed and the
check couldn't finish) and `invalid_request` (the model in the request
couldn't be read, in a workspace set to fail closed). A client should show
these as "the budget check is unavailable" (the LiteLLM plugin answers 503)
rather than as a spent quota a caller would back off from (429).

## Fail open and fail closed

There are two fail-mode settings, and they cover different failures.

The workspace's fail mode lives in TensorCost and decides when TensorCost
can't finish its own check: a budget it couldn't read in time, its holds
unreachable, a model it couldn't read. TensorCost still answers with a 200. Open
answers `allow` with `degraded: true`; closed answers `refuse` with reason
`check_unavailable` (or `invalid_request` for the model). Either way `detail`
says what couldn't be checked. The client follows the decision like any other.

The client's fail mode lives in the gateway and decides when no decision
arrives: the round trip timed out, the status wasn't 200, or the body wasn't
a JSON object with a `decision` of allow, refuse or reroute. Fail open means
the client sends the call as asked, with no decision behind it and nothing
held. Fail closed means the client blocks the call and tells the caller the
budget check is unavailable. Neither one asks admit again for that call.

The two settings should agree. Each answer carries the workspace's mode in
`fail_mode` and in the `x-tc-fail-mode` header, so a client can pick up a
change without a redeploy. The exception is `fail_mode_known: false`: when the
workspace's setting itself couldn't be read in time, the default (open)
decided, the answer says so with `fail_mode_known: false` and
`degraded: true`, and the header is left off. A client never adopts
`fail_mode` from such an answer. It keeps the mode it had.

## Caching an allow

`cache_ttl_seconds` says how long a client may reuse an allow for the same
callers, model and customer without asking. It is 5 while every budget the check matched
is under 80% burn and the allow placed no hold. It is 0 whenever a hold was
placed, that is, whenever the call reserved anything against a hard cap: a
call that reused that allow would hold nothing, and the hard cap would stop
counting it. Refusals, reroutes and degraded answers always carry 0.

A client never caches an allow whose `cache_ttl_seconds` is 0, and never
keeps one longer than the number of seconds it says. A client that never
caches is following the protocol too. A client that caches should key the
entry by everything that made the decision: the callers it sent, the model,
and the call's size (`max_tokens`, `input_tokens`), so an allow for a small
call never covers a large one. A call let through by a cached allow has no
decision of its own, so it is never cancelled.

## Never retry after a billed or unknown answer

Ask admit once per call. An admit that timed out or failed may still have been
answered on TensorCost's side and placed a hold, so asking again for the same
call would hold its reservation twice. The client's fail mode decides that
call instead.

The same goes for the model call. Once the provider may have done work for a
call, its decision is spent. That covers a timeout, a 5xx, a 400 the provider
may have processed (Azure OpenAI bills a content-filtered 400, and a 408), and a
stream that broke off. TensorCost never tells a client a call is safe to send
again. Sending it again, to the same model or another, is a new call, and a new
call asks admit again. A gateway that retries or falls back on its own, without
a fresh admit, is spending on the first decision; it must at least treat the
call as one that may have run.

## Cancel only calls that provably never ran

`POST {base}/v1/gateway/admit/{decision_id}/cancel` drops an allowed call's
hold at once instead of when its hold life runs out. It takes no body and answers 200
with `{"decision_id": …, "cancelled": true|false}`.

Cancel only a call the provider can't have billed:

- the gateway's own limit refused it before it was sent;
- the client went away before it was sent;
- the connection to the provider failed before the request left (refused,
  DNS, TLS);
- the provider refused it before any model work, with a 401, 403, 404 or 429.

Anything else keeps its hold: a timeout, a 5xx, a 400, a stream that broke
off, and a final error after the gateway retried or fell back, since an earlier
attempt may have run. The call's spend releases the hold when its row lands,
or the hold runs out with its hold life. Cancelling a call that ran would let
other calls spend money the hard cap still has to count.

Only the connection whose admit answered a decision can cancel it. Another
connection's cancel, a second cancel, a decision that held nothing and one
whose hold has expired all answer `cancelled: false`. The route is idempotent,
so one more try after a 5xx or a dropped connection is safe; a 503 means
TensorCost couldn't reach its holds, and the hold expires on its own.

## Reroute is advice

A `reroute` answer says the call may go to `model` instead of the model asked
for, because a routing policy the workspace runs live covers it. `route`
names the policy and the two models. It is advice: TensorCost answers it only
when the budget check is a clean allow, never in place of a refusal, and the
call's reservation is priced for the model it names.

Only a client that can rewrite the call's model follows a reroute, and only
the gateway kinds that can (LiteLLM, Azure APIM and Apigee connections) are
ever sent one. The model named is one the client listed in `accepts_models`,
or one in the connection's model list, spelled as the gateway spelled it. A
client that can't rewrite a particular call, such as an Azure OpenAI API
behind APIM whose model is the deployment in the URL path, sends
`can_reroute: false`. Admit then never answers reroute for that call, and a
matching policy is recorded as shadow advice only. Leaving `can_reroute` out,
or sending true, changes nothing.

A reroute covers one attempt. If the call to the new model fails, sending it
again, to either model, is a new call that asks admit again. A reroute is never
cached. TensorCost counts the policy's saving only once a spend row from the
gateway shows the new model ran under the call's `correlation_id`. A
TensorCost deployment may have reroute turned off, and then it answers allow
instead; a client works the same whether it ever sees a reroute or not.

## Reservations and holds

An allow holds `reservation_cents` against the workspace's hard caps until the
call's spend is counted, for at most the hold life of the connection's gateway
kind. A gateway that pushes its spend as calls finish (LiteLLM, Apigee, Kong,
Workato, Power Platform, generic) gets five minutes. Azure APIM gets 25: its
calls' spend is pulled from Log Analytics every 15 minutes, five minutes after
they settle, so a shorter hold would run out while the call is counted
nowhere and a hard cap would let that much traffic past it. When the pulled
row is stored, the hold is released early, as a pushed row's is. TensorCost
never holds a call longer than 30 minutes. A refusal because other calls'
holds fill a cap says to retry after the kind's hold life. The reservation is

    (input_tokens × input rate + output allowance × output rate) / 1000

where the output allowance is `max_tokens`. `reservation_basis` says what it
was sized from: `max_tokens` (the call's own), `model_default` (the model's
maximum output, because `max_tokens` was missing, unreadable or above that
limit) or `workspace_default` (the workspace's flat default, because the
model's limit or price isn't known). `reservation_kind` is `worst_case` when
`max_tokens` was usable and `input_tokens` was sent: the call is refused if
it wouldn't fit under a cap, and all of it is held. Anything else is
`estimated`: the call is refused only when a cap is already full, and it holds
at most the room left. A client that can count the prompt's tokens should send
both numbers. `reservation` is `unpriced` when no price list has the model and
`rate_unavailable` when the price couldn't be read in time.

## Callers

`callers` is a list of `{kind, id}`: the gateway's own names for who is
calling. TensorCost maps each to a team or a developer through the
workspace's caller aliases, and lists the ones with no alias yet in
`attribution.unmapped` as `{alias kind}:{value}`. The value is
`{instance}/{id}` when the connection has an instance, else the id.

The caller kinds TensorCost reads depend on the connection's gateway kind,
which comes from the key, not from the request's `gateway` field:

| Gateway | Caller kinds it sends | Alias kinds they map under |
| --- | --- | --- |
| LiteLLM | `team`, `user`, `key` | `litellm_team`, `litellm_user`, `litellm_key` |
| Azure APIM | `subscription`, `user`, `product` | `apim_subscription`, `apim_user`, `apim_product` |
| Apigee | `app`, `developer`, `product` | `apigee_app`, `apigee_developer`, `apigee_product` |
| Kong | `consumer` | `kong_consumer` |
| Workato | `key`, `team` | `workato_key`, `workato_team` |
| Power Platform | `environment` | `power_platform_env` |
| any other (generic) | none of its own | |

Every gateway may also send `tag` (a `key=value` string, mapped under
`gateway_tag`) and the person kinds `user` and `developer`. An email-shaped id
of a person kind names the developer directly, with no alias needed. A
`team=…` tag names the team when no alias does. A caller of any other kind is
dropped and named in `detail`, as `ignored: callers[0] (kind "x" isn't one kong
sends)`.

## What `detail` says

`detail` is absent on a plain decision. On a refusal it carries the refusing
gate's own reason when that is more specific than `reason`. On a
`check_unavailable` refusal or a degraded allow it lists what couldn't be
checked, separated by `; `: `check_timeout`, `throttled`, `fail_mode_unknown`,
`rate_unavailable`, `budget_check_unavailable`, `holds_unavailable`, and gate
names such as `run_stop: …` or `model_governance: …`. On `invalid_request` it says what is wrong with
the model. After any of these, or alone, `ignored: …` names what the route
dropped from the request. It is for logs and people, and its wording can
change; a client decides on `decision` and `reason`.

## Headroom and budget events

Two more routes take the same key, for a connector that isn't in a model
call's path (a Workato recipe, a Power Automate flow, an agent) and so asks
on its own. Neither is a decision route: a field TensorCost can't read is a
400 there, and a non-2xx means TensorCost couldn't answer.

`POST {base}/v1/gateway/headroom` asks whether the budgets have room for a
step that costs about `estimate_cents`, for a `team`, a `developer` or the
callers as admit takes them. It is the admit check run without holding
anything: `allowed` is what admit would answer with `estimate_cents` as the
call's worst case, `binding` is the budget that refuses (or, when allowed,
the hard cap with the least room), and each budget carries its cap, counted
spend, the holds other calls have live on it and what is left. A step that
goes ahead still asks admit, or records its spend, as usual.

`POST {base}/v1/gateway/subscriptions` with `url` and `event_types`
(`budget.threshold_crossed`) sends those events to the URL, signed with the
`signing_secret` that answer carries once. It answers 201 with a `Location`,
the subscription's path; `DELETE` there stops it. Only the key that
subscribed can delete, and any other id answers 404. Revoking the
connection deletes its subscriptions.

## Testing a client

Start the mock with `npx @tensorcost/admit-mock --port 8787` (or
`node admit-mock/bin/admit-mock.mjs` from this repository) and point the
client at `http://127.0.0.1:8787` with any `tcgw_` key. The caller ids the
client sends pick the answer: `refuse-*`, `reroute-*`, `slow-*` and `error-*`
give those answers, and `admit-mock/README.md` lists the rest. Then run the
cases in `admit-conformance/cases.json`; `admit-conformance/README.md` says how,
and `litellm/tests/test_conformance.py` is a worked example in Python.
