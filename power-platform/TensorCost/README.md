# TensorCost

Check a budget before an expensive step, record what an AI call cost, read a
team's budget room, and start a flow when a budget crosses an alert threshold.
For Power Automate flows and Copilot Studio agents that call models with their
own provider keys.

Apache-2.0. The contract this connector talks to is `spec/admit/openapi.yaml`
in this repository, and `spec/admit/README.md` explains what the answers mean.

## Publisher: TensorCost

## Prerequisites

A TensorCost workspace, and an admin who can open Connect > Gateways.

## Supported operations

| Operation | What it does | Route |
| --- | --- | --- |
| Check budget (`CheckBudget`) | Asks whether a step fits the budgets. Branch on **Decision**. | `POST /v1/gateway/admit` |
| Record AI spend (`RecordAiSpend`) | Sends one model call's tokens. | `POST /v1/gateway/logs?format=tensorcost` |
| Cancel check (`CancelCheck`) | Gives back the hold of a step that provably never ran. | `POST /v1/gateway/admit/{decision_id}/cancel` |
| Get headroom (`GetHeadroom`) | A team's, a person's or the workspace's budget room. Holds nothing. | `POST /v1/gateway/headroom` |
| When a budget crosses an alert threshold (`OnBudgetThresholdCrossed`) | Starts a flow. | `POST` at `/v1/gateway/subscriptions`; the platform deletes at the `Location` of the 201 |

Record AI spend is for calls made with your own provider keys. A model that
Microsoft bills (AI Builder credits, Copilot Studio's own model) isn't counted
here.

## Obtaining credentials

1. In TensorCost, open Connect > Gateways, create a connection of kind Power
   Platform, and copy its key when it is shown. It starts with `tcgw_` and is
   shown once. An SDK token doesn't work here.
2. Create a connection of this connector. **Gateway key** is `Bearer `, a
   space, then the key: `Bearer tcgw_...`. **TensorCost API host** is
   `api.tensorcost.com` unless TensorCost gave you another.

## Callers

Every operation that names a caller takes the same **Callers** list. Use the
same list in Check budget and Record AI spend, so a call's spend lands on the
team its check was made for.

| Kind | Value | Maps to |
| --- | --- | --- |
| `environment` | the Power Platform environment's ID: in a flow, `workflow()['tags']['environmentName']` | alias kind `power_platform_env`, mapped under Connect > Gateways > Map to team |
| `user` | the person's email | the developer directly; no alias needed |
| `tag` | `team=<team name or slug>`, or any `key=value` | the team named by a `team=` tag when no alias names one |

A Power Platform connection has no `team` caller kind, so a team goes as the
`team=` tag only. A TensorCost team's name or slug reaches that team's budgets
that way with no alias. A caller with no alias yet is listed in Check budget's
`attribution.unmapped`; map it in the console and later calls are attributed.

## What a flow has to do

These come from the admit protocol, and a custom connector can't do them for
the flow.

- **A refusal is a 200.** Check budget answers a refusal as a normal result
  with Decision `refuse`. Branch on Decision, not on whether the action
  failed. Show **Message**: it names the budget and who can raise it.
- **Turn off the retry policy on Check budget and Cancel check.** Power
  Automate retries a timed-out action by default, and asking admit twice for one
  step holds its cost twice. Action settings > Retry policy > None.
- **Set a timeout of about one second on Check budget** (Action settings >
  Timeout, `PT1S`).
- **Pick the fail mode in the flow.** If Check budget fails or times out there is
  no decision. Open: carry on with the step. Closed: stop the flow and tell the
  person the budget check is unavailable. Do it with Configure run after on the
  action that follows (is successful, has failed, has timed out). Match the fail
  mode set in TensorCost.
- **Build Log ID from something unique to the call.** Record AI spend dedupes
  on it, so a retried run counts the call once only if it sends the same ID.
  Use `concat('pp:', <Decision ID>)` when the step was checked, else
  `concat('pp:', <Provider response ID>)`, else `guid()`. With `guid()` a re-run
  of the flow can count the call twice. Also put the Decision ID in Decision ID,
  so the spend releases the check's hold.
- **Cancel check only for a step that provably never ran.** The flow stopped
  before calling the provider, or the provider refused before any work (401, 403,
  404, 429). Not after a timeout, a 5xx, a 400 or a retry: the call may have
  billed, and cancelling lets other calls spend money the hard cap still has to
  count. Without a cancel the hold lapses after five minutes.
- **Look at Unreadable rows** in Record AI spend's result. A row listed there
  wasn't recorded.

## Copilot Studio

Add the connector to an agent as a tool (Tools > Add a tool > Connector). Check
budget, Get headroom and Record AI spend are the useful ones. The tool
descriptions in this connector are written for the agent to read: Check budget's
says to branch on Decision, and Cancel check's says when it is safe.

## Known issues and limitations

- A flow can't change the model of a step, so Check budget always sends
  `can_reroute: false` and never gets a reroute.
- The platform's notification carries no signature check; the callback URL is
  unguessable and private to the flow.
- The connector reads nothing about the environment by itself. The flow passes
  the environment ID as a caller.

## Validate and deploy

```
make validate test       # from integrations/power-platform
make validate-strict     # fails when paconn is missing
paconn login
make deploy              # needs a settings.json with the environment ID
```

`make test` needs only Node. `make validate` runs `paconn validate` when paconn
is installed (`pip install paconn`).

## Common errors

- **401, "gateway key refused"**: the key must be a Power Platform connection's
  `tcgw_` key with `Bearer ` in front, and not revoked.
- **A refusal that the flow treats as an error**: Check budget doesn't fail on a
  refusal. Check Decision.
- **Spend lands on no team**: the callers aren't mapped. Read
  `attribution.unmapped` in Check budget's result.
