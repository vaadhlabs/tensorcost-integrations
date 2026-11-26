# TensorCost for Workato: check a budget before an expensive step, record the
# spend of a model call, read a team's spend, and get a recipe trigger when a
# budget crosses a threshold. Apache-2.0.
#
# The connector talks to TensorCost's gateway routes with a gateway
# connection's key (tcgw_...), never an SDK token. The contract is
# spec/admit/openapi.yaml in this repository. Two rules from it shape the code:
#
# - A refusal is an HTTP 200 whose `decision` is `refuse`. The connector reads
#   `decision`, never the status. A non-2xx answer, a timeout or a body with no
#   decision means TensorCost failed to decide, and the connection's fail mode
#   says what the step does then.
# - Admit is asked once per step. No retry follows an answer that is unknown or
#   was already billed: an admit that failed may still have placed a hold.
{
  title: "TensorCost",

  connection: {
    fields: [
      {
        name: "base_url",
        label: "TensorCost API URL",
        optional: false,
        hint: "Your TensorCost API URL, e.g. https://tensorcost.example.com. It is the address your TensorCost console shows under Connect > Gateways."
      },
      {
        name: "gateway_key",
        label: "Gateway key",
        control_type: "password",
        optional: false,
        hint: "The key TensorCost showed once when an admin created this Workato gateway connection (it starts with tcgw_). It is not an SDK token."
      },
      {
        name: "key_name",
        label: "Name for this key",
        optional: true,
        hint: "Sent as the caller of kind key, so spend can be mapped to a team. Use the name you gave the alias in TensorCost, e.g. recipes-prod."
      },
      {
        name: "fail_mode",
        label: "If TensorCost can't answer",
        control_type: "select",
        pick_list: [%w[Allow\ the\ step open], %w[Stop\ the\ step closed]],
        optional: false,
        default: "open",
        hint: "Applies when TensorCost times out, answers with an error, or answers with something that isn't a decision. Match the fail mode set in TensorCost."
      }
    ],

    authorization: {
      type: "custom_auth",
      apply: lambda do |connection|
        # The connector names itself, so TensorCost's edge never sees a
        # request without a User-Agent (its WAF blocks those).
        headers("Authorization": "Bearer #{connection['gateway_key']}", "User-Agent": "TensorCost-Workato/1.0.0")
      end
    },

    base_uri: lambda do |connection|
      connection["base_url"].to_s.strip.sub(%r{/+\z}, "")
    end
  },

  test: lambda do |_connection|
    post("/v1/gateway/headroom", {}).
      after_error_response(401) do |_code, _body, _headers, _message|
        error("Your TensorCost gateway key was refused. Check that it is the tcgw_ key of a Workato gateway connection and that it has not been revoked.")
      end
  end,

  methods: {
    # The caller list sent by check_budget and record_ai_spend. Both use the
    # same kinds and values, so a row's spend lands on the team its check
    # was made for. Workato's kinds are key and team; user takes an email
    # (a person kind) and tag takes key=value. A team is sent twice: as the
    # team caller, which resolves through a workato_team alias, and as a
    # team=<name> tag, which names the team when no alias does.
    callers: lambda do |connection, input|
      list = []
      team = input["team"].to_s.strip
      email = input["user_email"].to_s.strip
      key = connection["key_name"].to_s.strip
      unless team.empty?
        list << { "kind" => "team", "id" => team }
        list << { "kind" => "tag", "id" => "team=#{team}" }
      end
      list << { "kind" => "user", "id" => email } unless email.empty?
      list << { "kind" => "key", "id" => key } unless key.empty?
      Array(input["tags"]).each do |tag|
        name = tag["key"].to_s.strip
        next if name.empty?
        list << { "kind" => "tag", "id" => "#{name}=#{tag['value']}" }
      end
      list
    end,

    # What a step does when TensorCost gave no decision.
    no_decision: lambda do |connection, why|
      if connection["fail_mode"] == "closed"
        {
          "decision" => "refuse",
          "allowed" => false,
          "reason" => "check_unavailable",
          "message" => "The TensorCost budget check is unavailable, so this step was stopped (#{why}).",
          "degraded" => true
        }
      else
        {
          "decision" => "allow",
          "allowed" => true,
          "reason" => "check_unavailable",
          "message" => "The TensorCost budget check is unavailable, so this step was allowed without a check (#{why}).",
          "degraded" => true
        }
      end
    end,

    budget_fields: lambda do |_input|
      [
        { name: "id" }, { name: "name" }, { name: "period" }, { name: "mode" },
        { name: "cap_cents", type: "number" },
        { name: "spent_cents", type: "number" },
        { name: "held_cents", type: "number" },
        { name: "remaining_cents", type: "number" },
        { name: "burn_pct", type: "number" }
      ]
    end,

    caller_fields: lambda do |_input|
      [
        { name: "team", hint: "The team the step is for. A TensorCost team name or slug reaches that team's budgets directly; a name an admin mapped under Map to team (workato_team) reaches the mapped team." },
        { name: "user_email", label: "User email", hint: "The person the step runs for. An email names the developer directly." },
        {
          name: "tags", type: "array", of: "object", list_mode_toggle: true,
          properties: [{ name: "key" }, { name: "value" }],
          hint: "Tags to attribute the step by, such as cost-center = search."
        }
      ]
    end
  },

  actions: {
    check_budget: {
      title: "Check budget",
      subtitle: "Ask TensorCost whether a step may go ahead",
      description: "Ask <span class='provider'>TensorCost</span> whether a model call or other costly step fits the budgets",
      help: "Run this before the step. Branch on Allowed. If the decision is allow, the step holds its estimated cost against hard caps for five minutes, or until Record AI spend reports the call with this decision's ID.",

      input_fields: lambda do |object_definitions|
        [
          { name: "model", optional: false, hint: "The model the step will call, as its provider names it." },
          { name: "provider", hint: "anthropic, openai, aws.bedrock, azure.ai.openai, gcp.vertex_ai... An unknown provider skips provider budgets." },
          { name: "max_tokens", type: "integer", hint: "The output allowance. The hold is sized from it." },
          { name: "input_tokens", type: "integer", hint: "The prompt's size, if you can count it. With max_tokens it makes the hold the call's worst case." }
        ] + call(:caller_fields, nil) + [
          { name: "recipe_id", label: "Recipe ID", hint: "Sent as the workflow ID. Map the recipe's ID here." },
          { name: "agent_id", label: "Agent ID", hint: "The Agent Studio agent or skill running the step, if any." }
        ]
      end,

      execute: lambda do |connection, input|
        body = {
          "model" => input["model"],
          "provider" => input["provider"],
          "max_tokens" => input["max_tokens"],
          "input_tokens" => input["input_tokens"],
          "callers" => call(:callers, connection, input),
          "workflow_id" => input["recipe_id"],
          "agent_id" => input["agent_id"],
          "can_reroute" => false
        }.reject { |_k, v| v.nil? || v == "" || v == [] }

        # Workato runs a request when its result is first used, so the result
        # is read inside the begin: an error status or a timeout is rescued
        # here and handed to the fail mode, not raised at the recipe.
        failure = nil
        decision = nil
        answer = begin
          reply = post("/v1/gateway/admit", body)
          decision = reply["decision"]
          reply
        rescue StandardError => e
          failure = e.message.to_s[0, 120]
          nil
        end

        unless %w[allow refuse reroute].include?(decision)
          return call(:no_decision, connection, failure || "no decision in the answer")
        end

        {
          # This connector never asks for a reroute and can't rewrite a step's
          # model, so an unexpected one is an allow of the step as asked.
          "decision" => decision == "refuse" ? "refuse" : "allow",
          "allowed" => decision != "refuse",
          "message" => answer["message"],
          "reason" => answer["reason"],
          "budget" => answer["budget"],
          "reservation_cents" => answer["reservation_cents"],
          "decision_id" => answer["decision_id"],
          "degraded" => answer["degraded"] == true,
          "unmapped" => Array((answer["attribution"] || {})["unmapped"])
        }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "decision", hint: "allow or refuse." },
          { name: "allowed", type: "boolean", control_type: "checkbox" },
          { name: "message", hint: "What to show the person. A refusal names the budget and who can raise it." },
          { name: "reason" },
          { name: "budget", type: "object", properties: [
            { name: "id" }, { name: "name" }, { name: "period" },
            { name: "cap_cents", type: "number" },
            { name: "spent_cents", type: "number" },
            { name: "held_cents", type: "number" }
          ] },
          { name: "reservation_cents", type: "number" },
          { name: "decision_id", hint: "Pass to Record AI spend so the spend releases this hold." },
          { name: "degraded", type: "boolean", control_type: "checkbox", hint: "True when the step was decided without a full check." },
          { name: "unmapped", type: "array", of: "string", hint: "Callers TensorCost has no alias for yet, as alias kind:value. A team name that isn't a TensorCost team shows here." }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          "decision" => "allow", "allowed" => true, "message" => nil, "reason" => nil,
          "reservation_cents" => 6.684, "decision_id" => "3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10",
          "degraded" => false
        }
      end
    },

    record_ai_spend: {
      title: "Record AI spend",
      subtitle: "Send one model call's tokens to TensorCost",
      description: "Record the spend of a model call in <span class='provider'>TensorCost</span>",
      help: "Only for calls made with your own provider keys. Workato's built-in AI is billed by Workato and isn't counted here. Pass the Decision ID from Check budget: the row's ID is then derived from it, so a retried job counts the call once. Without a Decision ID the ID comes from the provider response ID, and with neither it is new each run, so a retried job can count the call twice.",

      input_fields: lambda do |_object_definitions|
        [
          { name: "provider", optional: false, hint: "anthropic, openai, aws.bedrock, azure.ai.openai, gcp.vertex_ai..." },
          { name: "model", optional: false },
          { name: "input_tokens", type: "integer", optional: false, hint: "All input tokens, cache reads and writes included." },
          { name: "output_tokens", type: "integer", optional: false },
          { name: "cached_input_tokens", type: "integer", hint: "Of the input tokens, those read from the provider's cache." },
          { name: "cache_write_tokens", type: "integer", hint: "Of the input tokens, those written to the cache." },
          { name: "started_at", type: "date_time", optional: false, hint: "When the call began." },
          { name: "ended_at", type: "date_time" },
          { name: "provider_response_id", hint: "The provider's own ID for the response (OpenAI's id, Anthropic's msg_...). It lets TensorCost count the call once if its bill or invocation log also shows it." },
          { name: "decision_id", label: "Decision ID", hint: "The Decision ID from Check budget, if the step was checked. It ties this spend to the check and releases its hold." },
          { name: "status", hint: "success or failure, or the HTTP status." },
          { name: "upstream_status", type: "integer", hint: "The provider's own HTTP status, if you have it." }
        ] + call(:caller_fields, nil)
      end,

      execute: lambda do |connection, input|
        # The row's ID is never taken from the recipe's input: a resent row
        # dedupes on it, so a recipe-supplied ID that repeated would drop real
        # spend. It is derived from what is unique to the call, so a retried
        # job sends the same ID and TensorCost counts it once: the check's
        # decision ID, else the provider's response ID. With neither it is
        # new each run, and a retry can count the call twice.
        decision_id = input["decision_id"].to_s.strip
        response_id = input["provider_response_id"].to_s.strip
        log_id = if !decision_id.empty?
                   "wk:#{decision_id}"
                 elsif !response_id.empty?
                   "wk:#{response_id}"
                 else
                   workato.uuid
                 end
        row = {
          "log_id" => log_id,
          "provider" => input["provider"],
          "model" => input["model"],
          "input_tokens" => input["input_tokens"],
          "output_tokens" => input["output_tokens"],
          "cached_input_tokens" => input["cached_input_tokens"],
          "cache_write_tokens" => input["cache_write_tokens"],
          "provider_response_id" => input["provider_response_id"],
          "correlation_id" => input["decision_id"],
          "started_at" => input["started_at"].respond_to?(:iso8601) ? input["started_at"].iso8601 : input["started_at"],
          "ended_at" => input["ended_at"].respond_to?(:iso8601) ? input["ended_at"].iso8601 : input["ended_at"],
          "callers" => call(:callers, connection, input),
          "status" => input["status"],
          "upstream_status" => input["upstream_status"]
        }.reject { |_k, v| v.nil? || v == "" || v == [] }

        # The route takes an array of rows or { "logs": [...] }, never a bare row.
        answer = post("/v1/gateway/logs?format=tensorcost", { "logs" => [row] })
        problems = Array(answer["parse_errors"])
        unless problems.empty?
          error("TensorCost couldn't read this spend row (#{problems.map { |p| p['reason'] }.join(', ')}). Nothing was recorded.")
        end
        {
          "log_id" => row["log_id"],
          "inserted" => answer["inserted"].to_i,
          "deduped" => answer["deduped"].to_i,
          "skipped" => answer["skipped"].to_i
        }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "log_id", hint: "The ID this connector gave the row." },
          { name: "inserted", type: "integer", hint: "1 when the row was stored." },
          { name: "deduped", type: "integer" },
          { name: "skipped", type: "integer", hint: "1 when TensorCost read the row but didn't keep it, such as a call that was never billed." }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { "log_id" => "0d6c2b1e-3a4f-4c5d-9e8f-7a6b5c4d3e2f", "inserted" => 1, "deduped" => 0, "skipped" => 0 }
      end
    },

    cancel_check: {
      title: "Cancel check",
      subtitle: "Give back the hold of a step that never ran",
      description: "Release the budget hold of a <span class='provider'>TensorCost</span> check",
      help: "Use this only when the AI step provably never ran: the recipe stopped before calling the provider, or the provider refused the call before doing any work (a 401, 403, 404 or 429). Never use it after the provider was called and anything else happened, such as a timeout, a 5xx, a 400 or a retry: the call may have been billed, and cancelling would let other calls spend money the hard cap still has to count. Without a cancel the hold lapses after five minutes.",

      input_fields: lambda do |_object_definitions|
        [{ name: "decision_id", label: "Decision ID", optional: false, hint: "The Decision ID from Check budget." }]
      end,

      execute: lambda do |_connection, input|
        id = input["decision_id"].to_s.strip
        error("Decision ID must be the ID Check budget returned.") unless id =~ /\A[0-9a-fA-F-]{8,64}\z/
        # One ask, no retry: a 5xx leaves the hold to lapse on its own.
        answer = post("/v1/gateway/admit/#{id}/cancel")
        { "decision_id" => id, "cancelled" => answer["cancelled"] == true }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "decision_id" },
          { name: "cancelled", type: "boolean", control_type: "checkbox", hint: "False when there was nothing to cancel: the decision held nothing, was already cancelled, had expired, or isn't this connection's." }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { "decision_id" => "3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10", "cancelled" => true }
      end
    },

    get_team_spend: {
      title: "Get team spend",
      subtitle: "A team's budgets and counted spend this month",
      description: "Get a team's budget room and month-to-date spend from <span class='provider'>TensorCost</span>",
      help: "Reads the budgets that apply to the team and how much of each is spent or held. Nothing is held.",

      input_fields: lambda do |_object_definitions|
        [{ name: "team", optional: false, hint: "The TensorCost team's name, slug or ID." }]
      end,

      execute: lambda do |_connection, input|
        post("/v1/gateway/headroom", { "team" => input["team"] })
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "allowed", type: "boolean", control_type: "checkbox" },
          { name: "budgets", type: "array", of: "object", properties: call(:budget_fields, nil) },
          { name: "counted_spend_mtd_cents", type: "number", hint: "The team's counted spend this UTC month. Each call counts once, however many sources saw it." },
          { name: "counted_spend_scope" }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          "allowed" => true,
          "budgets" => [{
            "id" => "2f5c8e1a-6b4d-4a9e-b3f7-0c1d2e3f4a5b", "name" => "Search team", "period" => "month",
            "mode" => "hard_cap", "cap_cents" => 2000000, "spent_cents" => 1650000,
            "held_cents" => 1200, "remaining_cents" => 348800, "burn_pct" => 82.5
          }],
          "counted_spend_mtd_cents" => 1650000,
          "counted_spend_scope" => "team"
        }
      end
    }
  },

  triggers: {
    budget_threshold_crossed: {
      title: "Budget threshold crossed",
      subtitle: "A TensorCost budget crossed an alert threshold",
      description: "<span class='provider'>Budget threshold crossed</span> in TensorCost",
      help: "Starts the recipe when one of the workspace's budgets crosses an alert threshold. The recipe subscribes when it starts and unsubscribes when it stops.",

      input_fields: lambda do |_object_definitions|
        []
      end,

      webhook_subscribe: lambda do |webhook_url, _connection, _input, _recipe_id|
        post("/v1/gateway/subscriptions", {
          "url" => webhook_url,
          "event_types" => ["budget.threshold_crossed"]
        })
      end,

      webhook_notification: lambda do |_input, payload, _extended_input_schema, _extended_output_schema, _headers, _params|
        payload
      end,

      webhook_unsubscribe: lambda do |webhook_subscribe_output, _connection|
        id = webhook_subscribe_output["id"]
        next if id.to_s.empty?
        delete("/v1/gateway/subscriptions/#{id}").
          after_error_response(404) { |_code, _body, _headers, _message| {} }
      end,

      dedup: lambda do |event|
        "#{event.dig('budget', 'id')}@#{event['crossed_at']}"
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: "event" },
          { name: "budget", type: "object", properties: [
            { name: "id" }, { name: "name" }, { name: "period" }, { name: "cap_cents", type: "number" }
          ] },
          { name: "threshold_pct", type: "number" },
          { name: "spent_cents", type: "number" },
          { name: "crossed_at", type: "date_time" },
          { name: "scope", type: "object", properties: [
            { name: "team" }, { name: "developer" }, { name: "provider" },
            # What an agent, project, model, environment, tag or custom budget
            # covers, keyed by its dimension (TensorCost 2026-11-21 and later).
            { name: "agent" }, { name: "project" }, { name: "model" },
            { name: "environment" }, { name: "tag" }, { name: "instance_family" }, { name: "custom" }
          ] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          "event" => "budget.threshold_crossed",
          "budget" => { "id" => "2f5c8e1a-6b4d-4a9e-b3f7-0c1d2e3f4a5b", "name" => "Search team", "period" => "month", "cap_cents" => 2000000 },
          "threshold_pct" => 80,
          "spent_cents" => 1600000,
          "crossed_at" => "2026-11-14T09:30:00Z",
          "scope" => { "team" => "search" }
        }
      end
    }
  }
}
