# TensorCost for Apigee

Apigee shared flows that put TensorCost's budget check in front of your LLM
proxies and report each call's tokens back:

- `tensorcost-admit` runs in the request flow. It asks TensorCost
  (`POST /v1/gateway/admit`) whether the call may go ahead and follows the
  answer: it refuses with a 429, sends the call on, or sends it to the model
  TensorCost named.
- `tensorcost-usage` runs in the target's response flow and in the fault
  flow. It counts the call's tokens against the product quota TensorCost
  pushes, and posts one row per call to
  `POST /v1/gateway/logs?format=tensorcost`.
- `tensorcost-usage-final` runs in the PostClientFlow and sends a streamed
  call's row once the stream has ended.
- `tensorcost-proxy-example/` is an example API proxy with all of it
  attached, and the two EventFlow policies (and their scripts) that count a
  streamed call. An EventFlow can't call a shared flow, so a proxy carries
  those two itself.

None of them sends a prompt, a response or an API key to TensorCost.

The parts of TensorCost's gateway admit API the flows use are described
below; the whole contract is `spec/admit/openapi.yaml` in this repository. The bundles here
are rendered for the placeholder host `tensorcost.example.com` with fail mode
`open`. Connect › Gateways in the TensorCost console renders the same bundles
with your workspace's URL, fail mode and VerifyAPIKey policy, and gives them
to you as zips. Without the console, render them yourself with
`@tensorcost/gateway-templates`, the renderer these bundles come from:

```sh
npx @tensorcost/gateway-templates apigee --base-url https://tensorcost.example.com/api/inference-proxy \
  --fail-mode closed --verify-api-key-policy Verify-API-Key-1 --zip --out ./bundles
```

Don't edit the bundles here by hand: CI fails when they aren't the renderer's
output.

Apache-2.0.

## Install

1. **The key.** Create an environment KVM named `tensorcost` with an entry
   `tensorcost-gateway-key` that holds the gateway connection's key (the
   `tcgw_…` key TensorCost showed once when you created the connection).
   With the Apigee API (Apigee X encrypts every KVM):

   ```sh
   API=https://apigee.googleapis.com/v1/organizations/$ORG/environments/$ENV
   curl -X POST "$API/keyvaluemaps" -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d '{"name":"tensorcost","encrypted":true}'
   curl -X POST "$API/keyvaluemaps/tensorcost/entries" -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d "{\"name\":\"tensorcost-gateway-key\",\"value\":\"$TCGW_KEY\"}"
   ```

   The flows read it into `private.tensorcost.key`, which trace masks. The key
   is never written into a bundle.

2. **The bundles.** Zip each directory's `sharedflowbundle/` (or take the
   zips from the console), then import each one and deploy its revision to
   the environment, in the Apigee UI (Develop › Shared Flows › Upload bundle)
   or with the API:

   ```sh
   for f in tensorcost-admit tensorcost-usage tensorcost-usage-final; do
     (cd $f && zip -r ../$f.zip sharedflowbundle)
   done
   ORG_API=https://apigee.googleapis.com/v1/organizations/$ORG
   for f in tensorcost-admit tensorcost-usage tensorcost-usage-final; do
     curl -X POST "$ORG_API/sharedflows?action=import&name=$f" -H "Authorization: Bearer $TOKEN" -F "file=@$f.zip"
     curl -X POST "$ORG_API/environments/$ENV/sharedflows/$f/revisions/1/deployments" -H "Authorization: Bearer $TOKEN"
   done
   ```

   Use the revision the import answered with, if it isn't 1.

3. **The proxies.** Each LLM proxy gets three FlowCallout policies and two
   EventFlow policies, attached as `tensorcost-proxy-example/apiproxy/` has
   them. Copy what your proxy lacks from there: the policies under
   `policies/`, the two scripts under `resources/jsc/`, and these
   attachments.

   ```xml
   <!-- ProxyEndpoint -->
   <PreFlow name="PreFlow">
       <Request>
           <Step><Name>VerifyAPIKey</Name></Step>
           <Step><Name>FC-TensorCostAdmit</Name></Step>
           <!-- your own policies that can refuse a call go after it -->
       </Request>
   </PreFlow>
   <PostClientFlow name="PostClientFlow">
       <Response>
           <Step><Name>FC-TensorCostUsageFinal</Name><Condition>tensorcost.stream_row = "true"</Condition></Step>
       </Response>
   </PostClientFlow>
   <DefaultFaultRule name="tensorcost">
       <Step><Name>FC-TensorCostUsage</Name></Step>
       <AlwaysEnforce>true</AlwaysEnforce>
   </DefaultFaultRule>

   <!-- TargetEndpoint -->
   <PreFlow name="PreFlow">
       <Response>
           <Step><Name>FC-TensorCostUsage</Name></Step>
           <!-- your own target response policies go after it -->
       </Response>
   </PreFlow>
   <EventFlow name="EventFlow" content-type="text/event-stream">
       <Response>
           <Step><Name>TC-StreamUsage</Name></Step>
           <Step><Name>TC-StreamTokenCount</Name><Condition>(tensorcost.quota_on = "true") and (tensorcost.stream_delta_tokens != "0")</Condition></Step>
       </Response>
   </EventFlow>
   ```

   - `tensorcost-admit` goes after VerifyAPIKey, which supplies the callers
     and the product. The bundles here read a policy named `VerifyAPIKey`.
     If yours has another name, set it on the connection in the console and
     use the bundles it renders.
   - `tensorcost-usage` goes **first** in the TargetEndpoint's response
     PreFlow. That is the first code to run on the target's answer, before
     any response policy of the target's or the proxy's, so it reads the
     status and usage as the target sent them. A policy after it that
     faults no longer costs the call its row.
   - It also goes in the ProxyEndpoint's DefaultFaultRule. By default Apigee
     turns a target's 4xx or 5xx into a fault, and the target's response flow
     then never runs. Without the fault rule those calls would send no row,
     and an allowed call that a later policy refused would keep its hold. A
     proxy has one DefaultFaultRule: if yours has one, add the step to it.
     The flow runs once a call, however many times it is included.
   - The flows need a TargetEndpoint. A proxy that calls the model from a
     ServiceCallout or JavaScript never sets `target.sent.start.timestamp`,
     so every call would look as if it never reached the model: no row, and
     its hold cancelled.

## What tensorcost-admit does

| Step | Policy | What it does |
| --- | --- | --- |
| `TC-Key` | KeyValueMapOperations | Reads the key from the KVM. |
| `TC-Correlation` | AssignMessage | Sets `x-tensorcost-correlation-id` to Apigee's own `messageid`, overwriting any value the caller sent. |
| `TC-Prepare` | Javascript | Reads the model, `max_tokens` and `stream` from the request, works out the callers, the provider and the quota counter, and builds the admit body. |
| `TC-TokenQuota` | LLMTokenQuota, EnforceOnly | Enforces the product's pushed quota, before the check. A call it refuses never asks TensorCost and holds nothing. It continues on error so that `TC-QuotaRefuse` can answer. |
| `TC-QuotaRefuse` | RaiseFault 429 | When the quota is spent (`ratelimit.TC-TokenQuota.failed`): TensorCost's refusal, naming the product and who can raise the budget, rather than Apigee's generic quota fault. |
| `TC-LookupFailMode`, `TC-LookupAllow` | LookupCache | The fail mode TensorCost last sent, and a cached allow for this caller and model. |
| `TC-Admit` | ServiceCallout | `POST /v1/gateway/admit`, `<Timeout>1000</Timeout>`, `<Response>tcAdmit</Response>`, `continueOnError="true"` under open and `"false"` under closed. Skipped on a cached allow. |
| `TC-ReadAnswer` | ExtractVariables | `decision`, `model` and `message` from `tcAdmit.content`, as `tcAnswer.*`. |
| `TC-Decide` | Javascript | Decides what the answer means (below). |
| `TC-RememberFailMode` | PopulateCache | Keeps the `x-tc-fail-mode` TensorCost sent, for a day. |
| `TC-Unavailable`, `TC-Unavailable-RetryAfter` | RaiseFault 503 | A check that couldn't be done, when the fail mode is closed. |
| `TC-Refuse`, `TC-Refuse-RetryAfter` | RaiseFault 429 | When `tcAnswer.decision = "refuse"`. |
| `TC-Reroute` | AssignMessage | When `tcAnswer.decision = "reroute"`: the body with its `model` rewritten. |
| `TC-RememberAllow` | PopulateCache | Caches an allow that may be reused. |

### What admit is sent

```json
{ "gateway": { "kind": "apigee" },
  "callers": [ { "kind": "app", "id": "<owner>/<developer.app.name>" }, { "kind": "developer", "id": "<email or developer.id>" },
               { "kind": "product", "id": "<apiproduct.name>" } ],
  "provider": "gcp.vertex_ai", "model": "gemini-2.5-flash", "max_tokens": 512, "stream": true,
  "can_reroute": false, "correlation_id": "<messageid>", "customer": "acme" }
```

- **Callers.** `app` is the app's owner and name,
  `{owner}/{verifyapikey.VerifyAPIKey.developer.app.name}`, where the owner is
  the developer caller below. App names are unique only within a developer or
  AppGroup, so without the owner two developers' `chatbot` apps would be one
  caller; an app whose owner isn't known sends no app caller. It is never
  `client_id`: that is the consumer key, the app's API key, and
  on a proxy that checks keys with VerifyAPIKey alone it is the whole
  credential. Nothing the flows send to TensorCost holds an API key, and the
  tests check every request they make for one. `developer` is
  `verifyapikey.VerifyAPIKey.developer.email` when VerifyAPIKey has it, else
  `developer.id`. `tensorcost-usage` sends the same list on the call's row,
  so a call and its spend are mapped through the same caller aliases. In
  TensorCost, map an `apigee_app` alias to `owner/name`, with the name as
  Apigee shows it (Distribution › Apps), and an `apigee_developer` alias to the email or
  developer id the gateway sends. `product` is the API product VerifyAPIKey
  matched (`verifyapikey.VerifyAPIKey.apiproduct.name`). An `apigee_product`
  alias maps it to a team: that team's budget is checked for the product's
  calls, the calls are the team's spend, and the team's room is the quota
  pushed into the product (below).
- **Model.** The body's `model`. A Vertex AI path names the model
  (`…/publishers/google/models/{model}:generateContent`). The body can't
  change that model, so such a call sends `can_reroute: false` and is never
  rerouted. A proxy whose target serves one model can set
  `tensorcost.fixed_model` before the flow, with the same effect.
- **Provider.** It comes from the path: a Vertex AI path is `gcp.vertex_ai`.
  A proxy in front of anything else should set `tensorcost.provider` before
  the flow, for example with AssignMessage `<AssignVariable>` to `openai`,
  `anthropic`, `azure.ai.openai`, `aws.bedrock` or `gcp.gemini`. When the
  provider can't be told, admit gets none and checks every budget but the
  provider ones. The log row then guesses it from `target.url`, and a row
  with no provider at all is refused as `unknown_provider`.
- **Customer.** The request's `x-tc-customer` header, when it has one: the
  same header the TensorCost SDK sends for the end customer a call is for.
  TensorCost judges the call against that customer's margin floors and fixed
  limits (refusing with reason `customer_limit_reached` or
  `margin_floor_reached`), and the call's row carries it, so the call counts
  toward that customer. Trimmed, at most 128 characters and with no control
  characters; anything else is left off. A cached allow is kept per customer.
  A call with no header is judged by no customer's limit.
- **Never** the prompt, the messages or any other part of the body.

### What the answer means

TensorCost answers every decision with an HTTP 200 and a JSON body. The flow
branches on `decision`, never on a status code. Only a 200 whose body has
`decision` allow, refuse or reroute counts as an answer.

**Does a non-2xx raise a fault?** Yes. Apigee's ServiceCallout reference
lists `steps.servicecallout.ExecutionFailed` (HTTP 500) for "The backend
target service returns an error status (by default, `4xx` or `5xx`)", and a
timeout fails the policy too. The endpoint properties reference says Apigee
treats `4XX` and `5XX` as errors unless `success.codes` says otherwise; it
documents that property for TargetEndpoint and ProxyEndpoint, not for
ServiceCallout. These bundles set no `success.codes`. What follows from that:

- **Fail open** (`continueOnError="true"`). A timeout, an error or a non-2xx
  doesn't stop the flow. `TC-Decide` sees no 200 answer and lets the call
  through, unless the fail mode TensorCost last sent is closed. A refusal
  still refuses: it is a 200, so `continueOnError` never swallows it.
- **Fail closed** (`continueOnError="false"`). A timeout, an error or a
  non-2xx faults the proxy at `TC-Admit` with Apigee's own 500, and the target
  is never called. A 200 that isn't an answer is refused with a 503
  `budget_check_unavailable`. A bundle rendered closed can't fall back to
  open, even when TensorCost's fail mode later changes to open. Render the
  bundles again after such a change.
- **refuse**: a 429 with TensorCost's message, which names the budget and who
  can raise it, and `Retry-After` when the answer gives one:

  ```json
  {"error":{"type":"budget_exceeded","message":"TensorCost: Search team has reached its monthly AI budget ($20,000). Ask ana@acme.com to raise it.","reason":"budget_hard_cap","decision_id":"…"}}
  ```

  A refusal for `check_unavailable` (a closed workspace's check that
  couldn't run, a throttled check included) or `invalid_request` gets a 503.
- **reroute**: the body's `model` becomes the answer's `model`. TensorCost
  answers reroute only for a routing policy that is live, and only when the
  operator has turned it on; a refusal never becomes a reroute.
- **allow**: the call goes on. It is cached for `cache_ttl_seconds` only
  when that is above 0, `reservation_cents` is 0, and the answer carries
  neither `degraded` nor `fail_mode_known`. TensorCost sends 0 whenever the
  allow placed a hold, so an allow with a hold is never reused. Refusals and
  reroutes are never cached.

Don't put a retry around the flow or the target call. An allow covers one
attempt. A resend is a new call and has to ask admit again, since a failed
attempt may already have been billed. That includes a TargetServer load
balancer's retries (`<MaxFailures>` with `<RetryEnabled>`, which is on by
default): they resend the model call under the one decision, so turn
`RetryEnabled` off on LLM targets.

A path that names the model decides it, and such a call sends
`can_reroute: false`: Vertex AI's `…/models/{model}:…`, Azure OpenAI's
`/openai/deployments/{deployment}/…` (the deployment is checked by its name)
and Bedrock's `/model/{id}/invoke` and `/model/{id}/converse`.

## What tensorcost-usage does

| Step | Policy | What it does |
| --- | --- | --- |
| `TC-UsageKey` | KeyValueMapOperations | The key, as above. |
| `TC-UsageRead` | Javascript | Works out whether the target saw the call, reads the response's token counts, and decides between a row and a cancel. |
| `TC-TokenCount` | LLMTokenQuota, CountOnly | Counts the call's input plus output tokens on the counter `TC-TokenQuota` enforces. |
| `TC-UsageRow` | Javascript | Builds the row. |
| `TC-UsageLog` | ServiceCallout, no `<Response>` | Posts the row, fire and forget. |
| `TC-Cancel` | ServiceCallout, no `<Response>` | `POST /v1/gateway/admit/{decision_id}/cancel` for an allowed call that never reached the target. |

### The row

```json
[{ "log_id": "<messageid>", "correlation_id": "<messageid>",
   "provider": "openai", "model": "gpt-4o",
   "input_tokens": 1200, "output_tokens": 300, "cached_input_tokens": 200, "cache_write_tokens": 0,
   "provider_response_id": "chatcmpl-…",
   "started_at": "…", "ended_at": "…",
   "callers": [ { "kind": "app", "id": "…" }, { "kind": "developer", "id": "…" }, { "kind": "product", "id": "…" } ],
   "status": 200, "upstream_status": 200, "quota_used_count": 1500, "customer": "acme" }]
```

- `log_id` and `correlation_id` are Apigee's `messageid`, the id admit was
  sent. A caller can't set it. TensorCost dedupes the row by
  `gw:<connection>:<log_id>`.
- `model` is the model the call was checked as, or rerouted to. The quota
  counters all name the model the call asked for (`tensorcost.request_model`),
  so a reroute never splits a product's count.
- **Tokens** are read from the response's usage block: OpenAI
  (`usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`),
  Anthropic (`usage.input_tokens` plus `cache_read_input_tokens` and
  `cache_creation_input_tokens`, since the row's `input_tokens` counts all
  input) and Gemini and Vertex (`usageMetadata.promptTokenCount`,
  `candidatesTokenCount` plus `thoughtsTokenCount`, `cachedContentTokenCount`).
  Bedrock Converse (`usage.inputTokens`, `outputTokens`,
  `cacheReadInputTokens`, `cacheWriteInputTokens`) is read the same way.
  Only the counts and the response id are read. Streamed responses are read
  too (below).
- `upstream_status` is the target's own status, `message.status.code`, read
  before any response policy runs. It is only there when the target
  answered. In the fault flow it is sent only for the target's own error
  answer (fault `ErrorResponseCode`). A timeout or one of Apigee's own faults
  sends none, so TensorCost treats the call as possibly billed, never as
  never-billed.
- `status` is what Apigee answered the caller.
- `customer` is the request's `x-tc-customer`, as admit was sent it. It is
  left off when the request had none.
- `quota_used_count` is `ratelimit.TC-TokenCount.used.count`. Apigee's
  reference describes it as the quota used within the interval, so it is the
  product's running total, not this call's tokens. TensorCost doesn't read it.
- A call that never reached the target (`target.sent.start.timestamp` unset)
  sends no row. If TensorCost allowed it, its hold is cancelled. That happens
  when a policy after `tensorcost-admit` refused it, or when it faulted before
  it was sent. A call that reached the target is never cancelled, whatever
  came back.

### Streamed calls

A streamed response (`text/event-stream`) is read whichever way the proxy
handles it.

- **Buffered** (streaming not enabled, the default): `response.content` holds
  the whole event stream, and `tensorcost-usage` folds its `data:` events in
  order, as it does a JSON body. A Vertex `streamGenerateContent` answer
  without `alt=sse`, a JSON array of chunks, is read the same way.
- **Streamed** (an EventFlow on the target): the response flow runs before
  any event arrives, so `tensorcost-usage` only builds the row's ids,
  callers and statuses. Apigee's server-sent events reference
  (docs.cloud.google.com/apigee/docs/api-platform/develop/server-sent-events)
  allows up to four policies in an EventFlow, of the types DataCapture,
  JavaScript, LLMTokenQuota, MessageLogging, PublishMessage, RaiseFault and
  SanitizeModelResponse, and no others. So:
  - `TC-StreamUsage` (JavaScript) reads each event's usage from
    `response.event.current.data`, never changing the event, and rebuilds
    the row with the totals so far;
  - `TC-StreamTokenCount` (LLMTokenQuota, CountOnly) counts the tokens that
    event added on the product's counter;
  - the row goes once the stream has reached the client, from the
    PostClientFlow. That flow runs "after a response is sent to the client"
    and takes only FlowCallout, MessageLogging and ServiceCallout (the flows
    reference, docs.cloud.google.com/apigee/docs/api-platform/fundamentals/what-are-flows),
    so `tensorcost-usage-final` is the row's ServiceCallout alone.

Where the usage is in a stream:

- OpenAI chat completions put it in the last chunk only when the request asks
  for it with `stream_options: { "include_usage": true }`. Ask for it.
- Anthropic puts the input in `message_start` and the output total in
  `message_delta`.
- Gemini and Vertex put the total so far in every chunk's `usageMetadata`.
- The OpenAI Responses API puts it in `response.completed`.

A stream that carries no usage still sends its row, with no tokens, so
TensorCost books the admit estimate for it rather than nothing.

### Lost rows

The log callout has no `<Response>`, so the proxy doesn't wait and can't
tell whether the row arrived. A row is lost when TensorCost is unreachable or
slow at that moment, or when it refuses the push. It is never retried.
Nothing here covers a lost row. The call's admit hold runs out on its own
after five minutes. The call's spend still reaches TensorCost from the
provider's bill, since the bill is the truth and a gateway row is a witness,
but without the row it isn't tied to the call's team and developer.

How often: about as often as TensorCost fails a push, which is the same rate
at which admit gets no answer. TensorCost takes Apigee's one-row pushes at
the connection's admit rate (60,000 a minute unless an admin sets another),
answers at once, and sends them on in batches. A row TensorCost refuses (no
provider, no model, over the push rate, and the rest) can't be seen from
Apigee, so TensorCost counts them per connection and reason, and Connect ›
Gateways shows the rows refused in the last 24 hours. A connection whose rows
are all refused, say for `unknown_provider` on a self-hosted model, shows
there at once.

TensorCost holds the rows it has answered for in memory until their batch
is stored. It keeps only the fields above, refuses a row over 4 KB as
`row_too_large`, refuses a push of more than 10 rows on an Apigee key as
`push_too_large` (the flows send one), holds at most 16 MB per workspace
(`tenant_buffer_full`), 5,000 rows per connection and 64 MB in all
(`buffer_full` past either), and sends a batch it couldn't store once more
before counting it as `ingest_failed`. What it can lose without counting:

- if TensorCost's task crashes, everything it held: up to 5,000 rows per
  connection, plus the batches in flight;
- if it is stopped, it drains for up to 45 seconds and counts what is still
  waiting as `shutdown`. A batch still in flight when the task is killed,
  60 seconds after the stop, is lost uncounted;
- while TensorCost's Redis is down, the counts themselves, so the losses
  above are silent for that time.

The push's 202 says how many rows weren't taken and why
(`refused`, `refused_reasons`). The callout doesn't read it, but a client
that does can tell.

## Product quotas

TensorCost can push a team budget's room down into an API product, so the
gateway holds the budget's line on its own when TensorCost can't be reached.
A product gets a quota once an `apigee_product` alias maps it to a team with
a hard-cap budget (Connect › Gateways, Map to team on the product's
unmapped-caller row).
Every 15 minutes it writes the product attribute `tensorcost_llm_quota`: the
room in tokens at the cheapest priced chat model on the connection, mixing
input and output 3 to 1. Calls on dearer models therefore reach the budget
before they reach the quota. `TC-TokenQuota` reads it as
`<Allow countRef="verifyapikey.VerifyAPIKey.apiproduct.tensorcost_llm_quota">`.

- A product without the attribute isn't limited, and its calls aren't
  counted on any quota counter.
- Apigee's attributes reference says its POST "updates the value of an API
  product attribute" and says nothing about creating one. When you map a
  product, add `tensorcost_llm_quota` to it once, with the value
  `2147483647`, which doesn't limit. TensorCost then lowers it, and puts it
  back when the budget stops covering the product.
- The counter is the product and the pushed value, so each new value starts
  a new count. The count runs for a year at most.
- TensorCost never raises a value that was there before its first push. It
  pushes the smaller of that value and its own, saves the old value first,
  and puts it back, or deletes the attribute, when the budget stops covering
  the product.
- Apigee caches API products and their attributes for 180 seconds, so a
  pushed value takes up to three minutes to apply.
- The counters are per environment, with `<Distributed>true</Distributed>`.

### Credentials and a least-privilege role

TensorCost signs in with a GCP connection you add on Connect › Sources,
with a service account key or Workload Identity Federation, as for the
billing export. Use a dedicated service account and connection for Apigee
rather than the billing export's. A leaked billing-export key would
otherwise also carry attribute writes on every API product in the
organization, because the role is bound on the project. Give the dedicated
service account one custom role on the Apigee organization's project, with
only these permissions:

```yaml
# tensorcost-apigee-quotas.yaml
title: TensorCost Apigee quotas
description: Read, write and delete API product attributes, for TensorCost's tensorcost_llm_quota.
stage: GA
includedPermissions:
  - apigee.apiproductattributes.get
  - apigee.apiproductattributes.update
  - apigee.apiproductattributes.delete
```

```sh
gcloud iam roles create tensorcostApigeeQuotas --project=$APIGEE_PROJECT --file=tensorcost-apigee-quotas.yaml
gcloud projects add-iam-policy-binding $APIGEE_PROJECT \
  --member="serviceAccount:$TENSORCOST_SA" --role="projects/$APIGEE_PROJECT/roles/tensorcostApigeeQuotas"
```

IAM can't narrow these permissions to one attribute, and the token's scope
is necessarily `cloud-platform`, so the role is the only narrowing.
TensorCost only ever reads or writes `tensorcost_llm_quota`.

With Workload Identity Federation, TensorCost's subject token's `sub` is
`{tensorcost tenant}:{gcp connection id}`. Pin it in the provider's attribute
condition (`assertion.sub == "…"`), so that no other TensorCost workspace can
impersonate the service account. A 403 on the push shows on the
connection as "The service account needs apigee.apiproductattributes.update".

## Tests

```sh
node --test
```

Standard-library Node only, 22 or later. `tests/bundles.test.mjs` reads the
XML. `tests/flow.test.mjs` runs both flows step by step in a stand-in proxy
(`tests/lib/flow.mjs`): each `<Condition>` is evaluated, each policy runs as
its XML says, the JavaScript runs in `node:vm`, and TensorCost and the target
are stubs. The stand-in isn't Apigee. It models only what the flows rely on,
and the comments in it say what it assumes.

## Not yet checked against a real Apigee

- That the Javascript policies run on Apigee's Rhino engine as they run in
  Node. They are written as ES5 for that reason.
- The variable names the flows read: `tcAdmit.status.code` and
  `tcAdmit.header.x-tc-fail-mode` on the callout's response,
  `verifyapikey.{policy}.apiproduct.tensorcost_llm_quota`, `fault.name` and
  `error.status.code` in the fault flow, `message.status.code` in the
  target's response PreFlow, and `verifyapikey.{policy}.developer.app.name`.
- That a ServiceCallout under `continueOnError="true"` still fills
  `tcAdmit` on a non-2xx. The flow refuses to use such a body either way.
- That LLMTokenQuota takes a message template in `LLMTokenUsageSource` and
  `LLMModelSource` that names a flow variable, falls back to `count` when
  `countRef` doesn't resolve, and that the EnforceOnly and CountOnly
  policies, in two shared flows with one `SharedName`, share one counter.
- Streams:
  - that the PostClientFlow runs after an SSE stream has ended, which the
    server-sent events reference doesn't say;
  - that EventFlow steps take a `<Condition>`;
  - that `response.content` is empty in the response flow when an EventFlow
    streams the response, and holds the event-stream text when it doesn't;
  - that `response.header.content-type` reads the header whatever its case.
- That `messageid` can't be set by a caller.
- That the attributes API's POST creates `tensorcost_llm_quota` on a product
  that doesn't have it yet. Its reference only says it updates the value.
