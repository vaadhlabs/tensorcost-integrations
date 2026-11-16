# TensorCost for Azure API Management

Two APIM policy fragments that ask TensorCost before each model call, so a
team's AI budget is enforced in the gateway it already runs:

- `tensorcost-admit.policy-fragment.xml` (fragment id `tensorcost-admit`) goes
  in the inbound section. It sends the call's callers, model and output
  allowance to TensorCost's admit route and follows the decision: allow,
  refuse, or reroute to another model.
- `tensorcost-on-error.policy-fragment.xml` (fragment id `tensorcost-on-error`)
  goes in on-error. It releases TensorCost's hold on a call that a later
  inbound policy refused, and answers a failed check with a clear 503 when the
  gateway is set to refuse calls it can't check.

The files here are rendered for a placeholder host
(`https://tensorcost.example.com`) and the open fail mode. TensorCost's console
(Connect › Gateways, on an Azure API Management connection) renders the same
files in your browser with your workspace's URL and fail mode, your token
quotas and your deployment map.

No prompt or response content is sent to TensorCost. The fragment reads the
request body only for `model`, `max_tokens` (or `max_completion_tokens`) and
`stream`.

## Setup

1. In TensorCost, create an Azure API Management gateway connection and copy
   its key (`tcgw_…`, shown once).
2. In APIM, create a named value `tensorcost-gateway-key`, type secret (or a
   Key Vault reference), holding that key. The fragments refer to it as
   `{{tensorcost-gateway-key}}`; the key never appears in a policy.
3. Create the two policy fragments from the files here (APIs › Policy
   fragments › Create), with the ids above.
4. In each LLM API's policy:

   ```xml
   <policies>
     <inbound>
       <base />
       <include-fragment fragment-id="tensorcost-admit" />
       <!-- your other inbound policies -->
     </inbound>
     <backend><base /></backend>
     <outbound><base /></outbound>
     <on-error>
       <include-fragment fragment-id="tensorcost-on-error" />
       <base />
     </on-error>
   </policies>
   ```

   Put `tensorcost-admit` right after `<base />`, so a call a product or global
   policy refuses never asks TensorCost and holds nothing, and before your own
   policies that can refuse a call, so a call they refuse after TensorCost
   allowed it is cancelled by `tensorcost-on-error`.

## What the admit fragment does

- **Correlation id.** It is APIM's own `context.RequestId`, minted in the
  gateway. A caller's `x-tensorcost-correlation-id` header is overwritten. The
  same id is `CorrelationId` in `ApiManagementGatewayLlmLog`, which TensorCost
  reads back to match the call's spend to its check.
- **Callers.** `subscription` (`context.Subscription.Id`), `user`
  (`context.User.Id`) and `product` (`context.Product.Id`). Map them to
  TensorCost teams and developers on Connect › Gateways. The user is its APIM
  user id, not its email, because the gateway log that TensorCost reads back
  carries only the id; an alias keyed on the id attributes both the check and
  the call's spend. Find a user's id in the Azure portal under API Management
  › Users: it is the last part of the user's resource id (`…/users/{id}`).
- **Model.** The `deployment-id` path parameter when the API has one (Azure
  OpenAI's `/openai/deployments/{deployment-id}/…`), whatever the body says:
  Azure runs the path's deployment, and the OpenAI SDK's Azure client sends a
  body `model` as well. Otherwise the body's `model`. A deployment is
  checked as the model it runs when the connection lists it (Connect ›
  Gateways, "Azure OpenAI deployments", rendered into the fragment); one not
  listed goes by its own name, and a name no price list has holds the
  workspace's default reservation.
- **Customer.** The request's `x-tc-customer` header, when it has one: the
  same header the TensorCost SDK sends for the end customer a call is for.
  TensorCost judges the call against that customer's margin floors and fixed
  limits, refusing with reason `customer_limit_reached` or
  `margin_floor_reached`, and keeps the customer with its record of the call.
  The log import can't see request headers, so it stores that customer on the
  call's spend row from admit's record, for calls it imports within the hour
  the record is kept. A call with no header is judged by no customer's limit.
  Trimmed, at most 128 characters; a longer one is ignored.
- **Timeout.** One second. Under the open fail mode the call has
  `ignore-error="true"`, so a timeout or connection failure is a null
  response; under closed, `ignore-error="false"`, so it is an error and
  `tensorcost-on-error` answers it.
- **No answer** (timeout, error, a status other than 200, a body that isn't
  JSON). The fail mode decides: the one TensorCost last sent in its
  `x-tc-fail-mode` header (kept in the APIM cache for a day), else the one the
  fragment was rendered with. Closed refuses with a 503; open lets the call
  through.
- **Refuse.** A 429 whose body is
  `{"error":{"type":"budget_exceeded","message":…,"reason":…,"decision_id":…}}`,
  with `Retry-After` when TensorCost gives one. The message names the budget
  and who can raise it. A refusal with reason `check_unavailable` or
  `invalid_request` is a 503 with type `budget_check_unavailable`: the budget
  isn't spent, the check couldn't run. It carries Retry-After too when
  TensorCost gives one (a throttled answer under the closed fail mode).
- **Reroute.** The body's `model` becomes the answer's `model`. A call with a
  deployment in the URL path can't be rewritten, with or without a body
  `model`, so the fragment sends `can_reroute: false` and TensorCost never
  answers it reroute; a routing policy that matches it is recorded as shadow
  advice only.
- **Allow.** Reused from the APIM cache for the same subscription, user,
  product, model, max_tokens and customer only when TensorCost says so:
  `cache_ttl_seconds` above 0 and `reservation_cents` exactly 0, for that many
  seconds. A refusal, a reroute and a degraded answer are never cached.
- **Never twice.** The fragment sends one check per call and never resends
  it. Don't wrap it in a `retry` policy: TensorCost treats a resend as a new
  call. The same goes for the common Azure OpenAI pattern of a `<retry>`
  around `forward-request` in the backend section: each retry is another
  model call, possibly billed, under one admit decision, which the admit
  contract doesn't allow. Let the client retry, so each attempt is checked.

## What the on-error fragment does

- **Cancel.** When the error came from the inbound section (which runs before
  anything is forwarded) and TensorCost had allowed the call, it posts
  `/v1/gateway/admit/{decision_id}/cancel` so the call's hold on hard caps goes
  at once. An error from the backend or outbound section may follow a billed
  call, so it cancels nothing; the import releases the hold once the call's
  row is stored, or it expires on its own after 25 minutes.
- **A check that failed** under closed gets the same 503 as the admit
  fragment's, rather than APIM's generic error.

## Fail mode

The workspace's fail mode is set in TensorCost (Connect › Gateways). To switch
a deployed fragment by hand, change `ignore-error` on the `send-request` and
the `default-value` of the `tensorcost:fail-mode` cache lookup together. The
console says when a connection's fragment needs redeploying after a change.

## Token quotas (optional)

TensorCost can push each hard-cap team budget down into APIM, so APIM refuses
a team's calls on its own when TensorCost can't be reached. For each APIM
product mapped to a TensorCost team, it writes a named value
`tensorcost-quota-{product id}` holding the budget's room in tokens, priced at
a 3:1 input-to-output blend of the cheapest priced model on the connection,
then `|` and an id for the push (for example `3809523|20261115T120000000Z`).
The rendered fragment then holds:

```xml
<choose>
  <when condition='@(context.Product?.Id == "search")'>
    <llm-token-limit counter-key='@("tensorcost:" + context.Product.Id + ":{{tensorcost-quota-search}}")'
                     token-quota='@(int.Parse("{{tensorcost-quota-search}}".Split(&apos;|&apos;)[0]))'
                     token-quota-period="Yearly" estimate-prompt-tokens="false" />
  </when>
</choose>
```

`token-quota` reads the count before the `|`. The counter key holds the whole
value, so each push starts a new count, even when a new budget period starts
from the same room as the last: the quota is the room left when TensorCost
pushed it, not a total for the year. A count is at most 2,147,483,647. It
runs before the check, so a call the quota refuses never asks TensorCost.
APIM keeps a counter per gateway region, so a multi-region instance allows
the quota in each region.

The push needs the APIM service's resource id and the role below
("TensorCost APIM quotas") on that service. A push never raises a value the
named value already held. When a budget stops covering a product, or the
gateway connection is revoked, the quota is put back in two steps:

1. The named value is restored at once: to the value it held before
   TensorCost's first push, or, if TensorCost created it, to 2,147,483,647
   tokens, which doesn't limit. Either way the deployed fragment keeps
   working and stops refusing on TensorCost's account.
2. Where TensorCost created it, the named value is then deleted. APIM won't
   delete a named value a deployed policy still reads, so until the fragment
   is redeployed without the product, Connect › Gateways says "restored,
   redeploy the fragment", and the delete is tried again every 15 minutes.

Add a product to the fragment only after its named value exists: APIM
refuses a policy that names a missing one.

## Spend logs

TensorCost reads each call's tokens from the `ApiManagementGatewayLlmLog`
table in Log Analytics (a diagnostic setting on the APIM service sending
"Logs related to generative AI gateway" to a workspace), joined to
`ApiManagementGatewayLogs` for the backend's status and the callers, every 15
minutes, with the role below ("TensorCost APIM logs") on that workspace. Its
query names token counts, the model, the statuses and the caller ids, and
never the request or response message columns. Table-level read still lets
the identity read those columns if message logging is on, so turn message
logging off in the diagnostic setting unless you need it.

Because spend arrives this way, up to about 20 minutes after a call ends, an
APIM call's hold on hard caps lives 25 minutes instead of a pushed gateway's
five: long enough that the call is always counted somewhere, in the holds or
in the spend, while its row is on its way. When the import stores the row it
releases the hold, which then drains over the 30 seconds counted spend takes
to include the row. Under heavy APIM traffic close to a cap, calls can be
refused a little early while those holds and the stored rows overlap.

## Azure permissions

TensorCost acts as its own multi-tenant Microsoft Entra app, the one your
Azure connection on Connect › Sources consented to. Give it two custom roles,
each holding only what one job needs, rather than a built-in role: API
Management Service Contributor, for one, can rewrite every API and policy
and read subscription keys.

Quota push, assigned on the APIM service:

```json
{
  "Name": "TensorCost APIM quotas",
  "IsCustom": true,
  "Description": "Read, write and delete the tensorcost-quota-* named values on one API Management service.",
  "Actions": [
    "Microsoft.ApiManagement/service/namedValues/read",
    "Microsoft.ApiManagement/service/namedValues/write",
    "Microsoft.ApiManagement/service/namedValues/delete"
  ],
  "NotActions": [],
  "AssignableScopes": ["/subscriptions/{subscription id}/resourceGroups/{resource group}"]
}
```

Create it with the resource group as its assignable scope (custom roles take a
management group, subscription or resource group there), then assign it on
the APIM service alone.

`delete` is for the put-back: a named value TensorCost created is deleted
once no budget covers its product and the fragment no longer reads it.
Azure roles can't be limited to names starting `tensorcost-quota-`, so the
role covers the service's named values; TensorCost only ever writes those.

Log import, assigned on the Log Analytics workspace:

```json
{
  "Name": "TensorCost APIM logs",
  "IsCustom": true,
  "Description": "Query the two API Management gateway log tables in one Log Analytics workspace.",
  "Actions": [
    "Microsoft.OperationalInsights/workspaces/read",
    "Microsoft.OperationalInsights/workspaces/query/read",
    "Microsoft.OperationalInsights/workspaces/query/ApiManagementGatewayLlmLog/read",
    "Microsoft.OperationalInsights/workspaces/query/ApiManagementGatewayLogs/read"
  ],
  "NotActions": [],
  "AssignableScopes": ["/subscriptions/{subscription id}/resourceGroups/{resource group}"]
}
```

Assign it on the Log Analytics workspace alone. This follows Microsoft's
"Manage access to Log Analytics workspaces"
(https://learn.microsoft.com/azure/azure-monitor/logs/manage-access, the
"Workspace permissions" table and "Custom role examples", Example 5):

- `workspaces/read` lets the identity enumerate the workspace.
- `workspaces/query/read` is "required for every user that can execute
  queries". It runs queries; it doesn't grant tables.
- `workspaces/query/<table>/read` grants one table. Every table at once
  would be `workspaces/query/*/read`, which this role doesn't have.

Microsoft marks the per-table actions as the legacy method. The same page
recommends granular RBAC: the built-in Log Analytics Data Reader
(`workspaces/read`, `workspaces/query/read` and the DataAction
`workspaces/tables/data/read`) with a role-assignment condition naming the
two tables. Either gives TensorCost the two tables and nothing else.

**Protected tables.** If `ApiManagementGatewayLlmLog` is set to Protected (the
page names AI prompts and responses as a use for them), a query without
explicit access "succeeds but returns no data": the import finds no calls and
reports no error. Leave the two tables General, or grant the identity access
to them with the DataAction `workspaces/tables/data/read` and a condition on
the tables' `protectionLevel`, as the page's "Protected tables" section
describes.

## Tests

```
python3 -m unittest discover -s tests
```

The tests read the XML with the standard library and check it against the
admit contract. They don't run APIM; nothing here has been deployed to a real
APIM instance yet.
