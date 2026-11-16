require "spec_helper"

RSpec.describe "TensorCost connector" do
  let(:settings) do
    {
      "base_url" => "https://tensorcost.example.com",
      "gateway_key" => "tcgw_test_key",
      "key_name" => "recipes-prod",
      "fail_mode" => "open"
    }
  end
  let(:connector) { Workato::Connector::Sdk::Connector.from_file(File.expand_path("../connector.rb", __dir__), settings) }

  let(:check_input) do
    {
      "model" => "claude-sonnet-4-5", "provider" => "anthropic",
      "max_tokens" => 4096, "input_tokens" => 1800,
      "team" => "search", "user_email" => "ana@acme.com",
      "recipe_id" => "recipe-4417", "agent_id" => "triage",
      "tags" => [{ "key" => "cost-center", "value" => "search" }]
    }
  end
  let(:callers) do
    [
      { "kind" => "team", "id" => "search" },
      { "kind" => "tag", "id" => "team=search" },
      { "kind" => "user", "id" => "ana@acme.com" },
      { "kind" => "key", "id" => "recipes-prod" },
      { "kind" => "tag", "id" => "cost-center=search" }
    ]
  end
  let(:sent) { SENT_REQUESTS.map { |r| [r.method.to_s, URI(r.uri).request_uri, r.body.to_s.empty? ? nil : JSON.parse(r.body)] } }

  describe "connection test" do
    it "passes with a valid key", cassette: "connection_test_ok" do
      expect(connector.test(settings)).to be_truthy
      expect(sent).to eq([["post", "/v1/gateway/headroom", {}]])
    end

    it "fails with a plain message when the key is refused", cassette: "connection_test_401" do
      expect { connector.test(settings) }.to raise_error(/Your TensorCost gateway key was refused/)
    end
  end

  describe "check_budget" do
    let(:action) { connector.actions.check_budget }

    it "answers allowed false with TensorCost's message on a refusal that came as a 200", cassette: "check_budget_refuse" do
      out = action.execute(settings, check_input)
      expect(out["allowed"]).to eq(false)
      expect(out["decision"]).to eq("refuse")
      expect(out["reason"]).to eq("budget_hard_cap")
      expect(out["message"]).to include("Search team has reached its monthly AI budget")
      expect(out["budget"]["name"]).to eq("Search team")
      expect(out["decision_id"]).to eq("7d2a4e19-0c3b-4f8a-9e61-5b0d8c2f7a34")
    end

    it "sends the callers, the recipe as workflow_id, and asks for no reroute", cassette: "check_budget_allow" do
      out = action.execute(settings, check_input)
      expect(out["allowed"]).to eq(true)
      expect(out["reservation_cents"]).to eq(6.684)
      body = sent.fetch(0)[2]
      expect(sent.fetch(0)[0, 2]).to eq(["post", "/v1/gateway/admit"])
      expect(body["callers"]).to eq(callers)
      expect(body["workflow_id"]).to eq("recipe-4417")
      expect(body["agent_id"]).to eq("triage")
      expect(body["can_reroute"]).to eq(false)
      expect(body).not_to have_key("correlation_id")
    end

    it "allows the step when TensorCost fails and the connection fails open, asking once", cassette: "check_budget_error" do
      out = action.execute(settings, check_input)
      expect(out["allowed"]).to eq(true)
      expect(out["degraded"]).to eq(true)
      expect(out["reason"]).to eq("check_unavailable")
      expect(sent.length).to eq(1)
    end

    it "stops the step when TensorCost fails and the connection fails closed", cassette: "check_budget_error" do
      closed = settings.merge("fail_mode" => "closed")
      out = connector.actions.check_budget.execute(closed, check_input)
      expect(out["allowed"]).to eq(false)
      expect(out["decision"]).to eq("refuse")
      expect(out["message"]).to include("budget check is unavailable")
    end
  end

  describe "record_ai_spend" do
    let(:action) { connector.actions.record_ai_spend }
    let(:input) do
      {
        "provider" => "anthropic", "model" => "claude-sonnet-4-5",
        "input_tokens" => 1800, "output_tokens" => 412, "cached_input_tokens" => 600,
        "provider_response_id" => "msg_01Abc",
        "decision_id" => "3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10",
        "started_at" => "2026-11-14T09:30:00Z", "ended_at" => "2026-11-14T09:30:04Z",
        "status" => "success",
        "team" => "search", "user_email" => "ana@acme.com",
        "tags" => [{ "key" => "cost-center", "value" => "search" }]
      }
    end

    it "posts one row in the tensorcost format, with the same callers as check_budget", cassette: "record_ai_spend" do
      action.execute(settings, input)
      expect(sent.length).to eq(1)
      method, path, body = sent.first
      expect([method, path]).to eq(["post", "/v1/gateway/logs?format=tensorcost"])
      expect(body.keys).to eq(["logs"])
      expect(body["logs"].length).to eq(1)
      row = body["logs"].first
      expect(row).to include(
        "provider" => "anthropic", "model" => "claude-sonnet-4-5",
        "input_tokens" => 1800, "output_tokens" => 412, "cached_input_tokens" => 600,
        "provider_response_id" => "msg_01Abc",
        "correlation_id" => "3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10"
      )
      expect(row["callers"]).to eq(callers)
    end

    it "derives the log_id from the decision so a retried job sends the same row, and ignores one in the input", cassette: "record_ai_spend" do
      first = action.execute(settings, input.merge("log_id" => "from-the-recipe"))
      expect(first["log_id"]).to eq("wk:3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10")
      expect(sent.first[2]["logs"].first["log_id"]).to eq(first["log_id"])
      expect(action.execute(settings, input)["log_id"]).to eq(first["log_id"])
    end

    it "falls back to the provider response id, then to a new UUID", cassette: "record_ai_spend" do
      expect(action.execute(settings, input.reject { |k, _| k == "decision_id" })["log_id"]).to eq("wk:msg_01Abc")
      bare = input.reject { |k, _| %w[decision_id provider_response_id].include?(k) }
      a = action.execute(settings, bare)["log_id"]
      expect(a).to match(/\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/)
      expect(action.execute(settings, bare)["log_id"]).not_to eq(a)
    end

    it "fails the step when TensorCost couldn't read the row, so spend isn't silently lost", cassette: "record_ai_spend_unreadable" do
      expect { action.execute(settings, input.merge("provider" => "acme-llm")) }.to raise_error(/couldn't read this spend row \(unknown_provider\)/)
    end

    it "says in its help that Workato's built-in AI isn't counted" do
      help = connector.actions.record_ai_spend.help
      help = help.call(settings, {}) if help.respond_to?(:call)
      text = help.is_a?(Hash) ? help["body"] : help
      expect(text).to include("Only for calls made with your own provider keys. Workato's built-in AI is billed by Workato and isn't counted here.")
    end
  end

  describe "cancel_check" do
    let(:id) { "3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10" }

    it "posts the fenced cancel once, with no body", cassette: "cancel_check" do
      out = connector.actions.cancel_check.execute(settings, { "decision_id" => id })
      expect(out["cancelled"]).to eq(true)
      expect(sent).to eq([["post", "/v1/gateway/admit/#{id}/cancel", nil]])
    end

    it "fails the step on a 5xx and doesn't ask again", cassette: "cancel_check_error" do
      expect { connector.actions.cancel_check.execute(settings, { "decision_id" => id }) }.to raise_error(StandardError)
      expect(sent.length).to eq(1)
    end
  end

  describe "get_team_spend" do
    it "returns the budgets and counted spend", cassette: "get_team_spend" do
      out = connector.actions.get_team_spend.execute(settings, { "team" => "search" })
      expect(out["counted_spend_mtd_cents"]).to eq(1650000)
      expect(out["budgets"].first["remaining_cents"]).to eq(348800)
      expect(sent).to eq([["post", "/v1/gateway/headroom", { "team" => "search" }]])
    end
  end

  describe "trigger budget_threshold_crossed" do
    let(:trigger) { connector.triggers.budget_threshold_crossed }
    let(:url) { "https://webhooks.workato.com/webhooks/rest/abc/tensorcost" }
    let(:payload) do
      {
        "event" => "budget.threshold_crossed",
        "budget" => { "id" => "2f5c8e1a-6b4d-4a9e-b3f7-0c1d2e3f4a5b", "name" => "Search team", "period" => "month", "cap_cents" => 2000000 },
        "threshold_pct" => 80, "spent_cents" => 1600000, "crossed_at" => "2026-11-14T09:30:00Z",
        "scope" => { "team" => "search" }
      }
    end

    it "subscribes, receives the payload and unsubscribes when the recipe stops", cassette: "trigger_subscribe" do
      subscription = trigger.webhook_subscribe(url, settings, {}, "recipe-1")
      expect(subscription["id"]).to eq("9b1e5c7a-2d4f-4a6b-8c0e-1f3a5b7c9d2e")
      expect(sent[0]).to eq(["post", "/v1/gateway/subscriptions", { "url" => url, "event_types" => ["budget.threshold_crossed"] }])

      expect(trigger.webhook_notification({}, payload, {}, {}, {}, {})).to eq(payload)
      expect(trigger.dedup(payload)).to eq("2f5c8e1a-6b4d-4a9e-b3f7-0c1d2e3f4a5b@2026-11-14T09:30:00Z")

      trigger.webhook_unsubscribe(subscription, settings)
      expect(sent[1][0, 2]).to eq(["delete", "/v1/gateway/subscriptions/9b1e5c7a-2d4f-4a6b-8c0e-1f3a5b7c9d2e"])
    end
  end
end
