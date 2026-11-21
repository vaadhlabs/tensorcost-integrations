# tensorcost-litellm

TensorCost for the [LiteLLM](https://github.com/BerriAI/litellm) proxy. Two
pieces, both loaded by the proxy from its config:

- `TensorCostAdmit`, a pre-call guardrail. Before each call it asks
  TensorCost (`POST /v1/gateway/admit`) whether the call fits the budgets
  that cover its team, user and key, and does what the answer says: lets it
  through, refuses it with a 429 that names the budget and who can raise it,
  or switches it to the model a routing policy picked.
- `spend_logger`, a callback. After each call it sends the call's spend row
  to TensorCost (`POST /v1/gateway/logs?format=litellm`), so the budget
  counts what the call cost.

## Install

Install it into the same Python environment as the proxy:

    pip install "tensorcost-litellm @ git+https://github.com/vaadhlabs/tensorcost-integrations#subdirectory=litellm"

It isn't on PyPI yet. Once the first release is published,
`pip install tensorcost-litellm` will do the same. Pin a commit
(`...tensorcost-integrations@<sha>#subdirectory=litellm`) if you want the
install to repeat exactly.

## Configure

Create a LiteLLM gateway connection in TensorCost (Connect › Gateways). It
gives you a key once. Then add this to the proxy's `config.yaml`:

```yaml
guardrails:
  - guardrail_name: tensorcost
    litellm_params:
      guardrail: tensorcost_litellm.TensorCostAdmit
      mode: pre_call
      default_on: true
      api_base: os.environ/TENSORCOST_URL
      api_key: os.environ/TENSORCOST_GATEWAY_KEY
      fail_mode: open

litellm_settings:
  callbacks: ["tensorcost_litellm.spend_logger"]

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

and set the environment:

    TENSORCOST_URL=https://<your TensorCost API host>/api/inference-proxy
    TENSORCOST_GATEWAY_KEY=tcgw_...
    LITELLM_MASTER_KEY=<a long random secret>

`LITELLM_MASTER_KEY` is LiteLLM's own admin key, not ours. We've seen
LiteLLM 1.110 refuse to start without one (`UnsafeMasterKeyError`), so a
config with only the TensorCost settings can fail at startup. If your proxy
already has a master key, keep it.

`default_on: true` runs the check on every call; without it LiteLLM runs a
guardrail only for requests that name it. `callbacks` takes the module-level
instance `spend_logger`, not the class: LiteLLM's callback setting names an
instance.

Guardrail settings, all optional:

| Setting | Default | What it does |
| --- | --- | --- |
| `fail_mode` | `open` | What to do when TensorCost doesn't answer in time or answers with an error: `open` lets the call through, `closed` refuses it with a 503. Once TensorCost has answered, the workspace's own setting (sent with every answer) replaces this one until the proxy restarts. |
| `timeout_seconds` | `1.0` | How long the check may take. |
| `instance` | none | The connection's instance, when you gave it one in TensorCost. |
| `count_input_tokens` | `true` | Count the prompt's tokens with LiteLLM's token counter and send them, so the check is the call's worst case. |

## What the check sends

The call's callers (the key's team id, user id and key alias, and any
request tags), the model and its provider as the proxy's `model_list` names
them, `max_tokens` (or `max_completion_tokens`), the prompt's token count,
whether it streams, and the model names in `model_list` as the models a
reroute may pick. It never sends the prompt.

It also mints a correlation id for the call, puts it in the request's
metadata under `tensorcost_correlation_id` (over any value the caller sent),
and sends it with the check, so the call's spend row finds its decision.

### The end customer

To have a call judged against one of your customers' margin floors and fixed
limits, name the customer in the request's metadata under
`tensorcost_customer`, the LiteLLM side of the SDK's `x-tc-customer` header:

```python
client.chat.completions.create(
    model="claude-sonnet",
    messages=[...],
    extra_body={"metadata": {"tensorcost_customer": "acme"}},
)
```

The check sends it as `customer`, and the logger puts it on the call's spend
row (`metadata.tensorcost_customer`), so the call counts toward that customer.
It is trimmed and at most 128 characters; a longer one, or one with control
characters, is left off. A cached allow is kept per customer, so one
customer's allow never covers another's call. A call with no customer is
judged by no customer's limit.

If your app also goes through the TensorCost SDK with LiteLLM as its base
URL, send the customer here too: TensorCost counts that call once, from
LiteLLM's row, and a LiteLLM row with no customer leaves the call off the
customer's figures.

## Decisions

- **allow**: the call goes on unchanged.
- **refuse**: the guardrail raises HTTP 429 with
  `{"error": {"type": "budget_exceeded", "message": ...}}` and a
  `Retry-After` header when TensorCost gives one. The message names the
  budget and who can raise it. A refusal because TensorCost couldn't check
  the call (`check_unavailable`, `invalid_request`) is a 503
  `budget_check_unavailable` instead, so a client doesn't take an outage for
  a spent budget.
- **reroute**: `model` is set to the model TensorCost names. The decision
  covers that one attempt.

Every answered decision is an HTTP 200. Anything else means TensorCost
failed, and the fail mode decides.

Each gateway connection has an admit rate, 60,000 checks a minute unless a
TensorCost admin sets another on Connect › Gateways. Past it TensorCost
still answers 200, with the fail mode's decision and `detail: "throttled"`:
under open the call goes through unchecked, under closed it gets the 503.
The guardrail logs that once a minute. A 429 from the check means
TensorCost didn't know the key yet (a wrong `TENSORCOST_GATEWAY_KEY`, most
likely). The check is never sent twice for one
call: a second check would hold the call's reservation twice.

An allow can be reused for the same callers, model, `max_tokens` and prompt
size for as long as TensorCost's `cache_ttl_seconds` says. TensorCost sends 0
for any allow that placed a hold, and the guardrail never reuses an allow
that reserved anything, so in practice only calls no hard cap covers are
reused. Refusals, reroutes and degraded answers are never reused.

The prompt's token count runs off the event loop, and the check goes without
it if counting takes longer than 0.25 s.

## Budgets and large `max_tokens`

An allowed call holds its worst-case cost against the hard caps it falls
under until its spend lands, or for five minutes. When the check knows both
the prompt's size and `max_tokens`, that worst case is exact, and a call
whose worst case doesn't fit in what's left is refused even if it would have
used far less. Clients that send a large default `max_tokens` on every call
(64k, say) while the prompt is counted are judged strictly on that worst
case, so near a cap they are refused earlier than their real spend would
need. Send a `max_tokens` close to what the call needs, or set
`count_input_tokens: false`, which makes the hold an estimate that refuses
only once a cap is already full.

## Holds after a failed call

When a call fails in a way that proves the provider can't have billed it (a
401, 403, 404 or 429 from the provider, or LiteLLM's own budget refusal),
the guardrail cancels the call's hold at once
(`POST /v1/gateway/admit/{decision_id}/cancel`). After any other failure (a
timeout, a 5xx, a 400, a stream that broke off, a call LiteLLM's router
retried or fell back) the provider may have billed, so the hold stays until
the call's spend row releases it or it expires. A call that got through on a
reused allow has no hold of its own and is never cancelled.

The call is found by the correlation id the guardrail minted, and only for
the request it admitted. LiteLLM's own call id is never used: a client can
set it with the `x-litellm-call-id` header.

LiteLLM's router retries and fallbacks run inside one checked call. Each
attempt is logged as its own row and its spend counted.

## Spend rows

The logger sends LiteLLM's spend-log row shape: `request_id`, the provider's
response `id`, model, tokens, cache read and write tokens, LiteLLM's cost,
start and end time, team, user, key alias, end user, tags, and for a failed
call the error's class and code, and the end customer the request named under
`tensorcost_customer`. It never sends the prompt, the response, the request's
parameters, the rest of the caller's own metadata or an error's message (only
whether it says a budget was exceeded).

`request_id`, which TensorCost dedupes on, is a UUID the logger mints for
each logged event. It isn't LiteLLM's call id, which a client can set; one
call id on every request would otherwise have all but the first row deduped
away. Each router attempt is its own row.

The guardrail's correlation id goes on one row per call: the success, or,
when no success comes, one of its failure rows. A failed attempt's row waits
up to two minutes for the call to finish. That way TensorCost books its
estimate for an attempt whose cost it can't tell at most once per call, and
never on top of the attempt that succeeded. A correlation id the guardrail
didn't mint in this process is never sent.

Rows go in batches of at most 500, every 5 seconds or sooner when a batch
fills. A push that fails with a 5xx, a 429 or a dropped connection is sent
once more with the same ids, so a resend never counts twice. A batch that
fails twice is dropped and logged. Rows still queued when the proxy exits
are sent once from an exit hook, with a three-second timeout; a proxy that
is killed outright loses them.

## Team budgets in LiteLLM

`tensorcost_litellm.budget_sync` sets a LiteLLM team's `max_budget` from what
is left on a TensorCost budget, so LiteLLM refuses on its own if TensorCost
can't be reached. TensorCost can do this for you every 15 minutes when you
give the connection your LiteLLM admin URL and key; the module is the same
push for anyone who would rather run it themselves:

    LITELLM_URL=https://litellm.example.com LITELLM_ADMIN_KEY=sk-... \
      python -m tensorcost_litellm.budget_sync --team-id search --room-usd 412.50

It reads the team with `GET /team/info`, sets `max_budget` to the team's
LiteLLM spend plus the room with `POST /team/update`, and reports `pushed`
only when LiteLLM's answer, or a second read of the team, carries the new
value back. If this LiteLLM names the fields differently it changes nothing
and reports `unsupported`.

The push never loosens the team's own limit: it sets the lower of the two.
The team's own limit is its `max_budget` before the first push. The CLI saves
it to a state file (`--state-file`, default `tensorcost-budget-sync.json`)
before it changes anything, since an update whose answer is lost may still
have landed. If the limit can't be saved, nothing is sent. A saved limit is
never replaced. Later pushes cap at it, and `--restore` puts it back and
forgets it once the TensorCost budget no longer covers the team:

    python -m tensorcost_litellm.budget_sync --team-id search --restore

Keep the state file; without it a restore doesn't know what to put back.
`--original-max-budget` gives the team's own limit for a team the file
doesn't have yet.

Use one or the other for a team, never both. TensorCost's own push and this
module each remember the team's limit from before their first push. If this
module pushed first, TensorCost takes its value as the team's own limit, and
a later revoke in TensorCost puts that figure back instead of yours. To move
from this module to TensorCost's push, run `--restore` first.

## Tests

    pip install -e ".[test]"
    pytest

The tests run against a stub TensorCost server. With LiteLLM installed they
use its real `CustomGuardrail` and `CustomLogger`; without it, stand-ins with
the same names (in `tests/conftest.py`).

## Licence

Apache-2.0.
