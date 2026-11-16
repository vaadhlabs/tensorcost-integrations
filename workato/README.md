# TensorCost for Workato

A Workato custom connector. A recipe, or an Agent Studio skill, uses it to
check a budget before an expensive step, record what a model call cost, read a
team's spend, and start when a budget crosses an alert threshold.

Apache-2.0. The contract it talks to is `spec/admit/openapi.yaml` in this
repository, and `spec/admit/README.md` explains what the answers mean.

| Piece | What it does | Route |
| --- | --- | --- |
| Action `check_budget` | Asks whether a step fits the budgets. Branch on **Allowed**. | `POST /v1/gateway/admit` |
| Action `record_ai_spend` | Sends one model call's tokens, for calls made with your own provider keys. | `POST /v1/gateway/logs?format=tensorcost` |
| Action `cancel_check` | Gives back the hold of a step that provably never ran. | `POST /v1/gateway/admit/{decision_id}/cancel` |
| Action `get_team_spend` | A team's budgets, what is left of each, and its counted spend this month. | `POST /v1/gateway/headroom` |
| Trigger `budget_threshold_crossed` | Starts a recipe when a budget crosses an alert threshold. | `POST` and `DELETE /v1/gateway/subscriptions` |

`record_ai_spend` is only for calls made with your own provider keys. Workato's
built-in AI is billed by Workato and isn't counted in TensorCost.

## Connect

1. In TensorCost, open Connect > Gateways, create a connection of kind
   Workato, and copy its key when it is shown. It starts with `tcgw_` and is
   shown once. An SDK token doesn't work here.
2. In Workato, create a connection of this connector:
   - **TensorCost API URL**: `https://api.tensorcost.com`, or the host
     TensorCost gave you.
   - **Gateway key**: the `tcgw_` key.
   - **Name for this key**: optional. It is sent as the caller of kind `key`
     so an admin can map it to a team under Connect > Gateways > Map to team
     (alias kind `workato_key`).
   - **If TensorCost can't answer**: Allow the step (fail open) or Stop the
     step (fail closed). Match the fail mode set in TensorCost.
3. Connect runs `POST /v1/gateway/headroom` with an empty body. A refused key
   fails with "Your TensorCost gateway key was refused".

## Callers

The two actions that name a caller take the same inputs and send the same
callers, so a call's spend lands on the team its check was made for.

| Input | Sent as caller | Maps under alias kind |
| --- | --- | --- |
| Team | `team`, and also the tag `team=<name>` | `workato_team`; the tag names the team when no alias does |
| User email | `user` (an email names the developer directly) | none needed |
| the connection's key name | `key` | `workato_key` |
| each tag, as `key=value` | `tag` | `gateway_tag` |

A team name that is a TensorCost team's name or slug reaches that team's
budgets with no alias, through the `team=` tag. A caller with no alias yet is
listed in Check budget's Unmapped output; map it in the console and later calls
are attributed.

## What the answers mean

- **A refusal is a 200.** `check_budget` reads `decision` in the body, never the
  status. Allowed is false for a refusal, and Message names the budget and who
  can raise it. Show it to the person.
- **TensorCost can't answer.** A timeout, a non-2xx status or a body with no
  decision isn't a refusal. The step follows the connection's fail mode and
  Degraded is true. Reason is `check_unavailable`. The connector asks once and
  never retries: a failed ask may still have placed a hold, and asking again
  would hold the reservation twice.
- **The hold.** An allow holds its Reservation cents against hard caps for five
  minutes, or until `record_ai_spend` reports the call with the Decision ID.
  If the step doesn't run, the hold lapses on its own after the five minutes,
  and until then other calls can be refused for room nobody spent. When the AI
  step provably never ran (the recipe stopped before calling the provider, or
  the provider refused it with a 401, 403, 404 or 429), run **Cancel check** with
  the Decision ID to give the hold back. Never cancel after the provider was
  called and anything else happened: a timeout, a 5xx, a 400 or a retry may have
  been billed, and the hold has to stay until the spend lands.
- **Timeout.** The connector can't set a 1,000 ms limit on the check; Workato's
  own action timeout applies before the fail mode does.
- **No reroute.** The connector can't change a step's model, so it never asks
  for a reroute.
- **Counted once.** If the same call also shows up in your provider's bill or
  invocation log, TensorCost counts it once. Send `provider_response_id` so it
  can tell.
- **The row ID.** `record_ai_spend` can't take a row ID from a recipe. It
  derives one so a retried job sends the same row and TensorCost counts the call
  once: from the Decision ID when you pass one, else from the Provider response
  ID. Pass the Decision ID from Check budget for this reason. With neither, the
  ID is new each run and a retried job can count the call twice.
- **Unreadable rows.** TensorCost answers a push with a 200 even when it
  couldn't read a row (an unknown provider, say). The action fails the step
  with the reason rather than reporting a spend that wasn't stored.

## Example recipe: stop a costly step over budget

1. Trigger: a new support ticket.
2. TensorCost: **Check budget**. Model `claude-sonnet-4-5`, provider
   `anthropic`, Max tokens `1024`, Team `support`, Recipe ID the recipe's
   own ID.
3. If **Allowed** is false, post **Message** to the support channel and stop.
4. Call the model with your own Anthropic connection.
5. TensorCost: **Record AI spend**. Provider `anthropic`, the model, the
   response's input and output tokens, its `id` as Provider response ID, the
   step 2 **Decision ID**, Started at the time the call began, Team `support`.

## Example Agent Studio skill: check before an expensive tool call

Give an agent a skill whose recipe starts with **Check budget** and returns its
result to the agent.

1. Skill inputs: `model`, `estimated_output_tokens`, `team`.
2. TensorCost: **Check budget** with Model, Max tokens set to
   `estimated_output_tokens`, Team, and Agent ID set to the agent's name.
3. Skill output: Allowed, Message and Decision ID.
4. In the agent's instructions: "Before a step that calls a model, run the
   budget skill. If Allowed is false, tell the user the Message and don't run
   the step. If it is true, run the step and pass the Decision ID to the
   spend-recording skill."
5. A second skill wraps **Record AI spend** the same way.

To react to budget alerts, start a recipe with **Budget threshold crossed**
and send a Slack message, or switch off a recipe, when it fires. The recipe
subscribes when it starts and unsubscribes when it stops. Alerts for the same
budget and crossing arrive once. The trigger doesn't check the delivery's
signature yet, so don't let it do anything a stranger who found the webhook URL
shouldn't be able to do.

## Develop and test

```sh
bundle install
bundle exec rspec          # specs against the recorded cassettes
workato exec check_budget  # run one action with a settings file
```

The specs use RSpec and VCR with the Workato Connector SDK and replay
`fixtures/vcr_cassettes/*.json`. They send no network call.

Without Ruby gems installed, `node --test` in this folder checks the
cassettes against the contract and runs `tests/connector_harness_test.rb`,
which runs `connector.rb` against the same cassettes with only Ruby's standard
library. That checks the connector's own logic; the RSpec suite is what checks
it against the SDK.

## Publish

Push it to a workspace as a private connector with `workato push`, then use it
in recipes. To list it in the Workato Community Library, follow
https://docs.workato.com/developing-connectors/community/community-listing.html:
a support contact, no credentials in the code, and the developer agreement.
