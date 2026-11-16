# Runs connector.rb against the recorded cassettes with nothing installed but
# Ruby: no gems, no Workato SDK. A small stand-in supplies post, delete, error,
# call and workato.uuid, and replays fixtures/vcr_cassettes/*.json by method and
# path. It checks the connector's own logic (the decision rules, the callers,
# the row it posts). It doesn't check that Workato's SDK accepts the file; the
# RSpec suite in spec/ does that where the SDK is installed.
#
#   ruby tests/connector_harness_test.rb
require "json"
require "minitest/autorun"
require "securerandom"

ROOT = File.expand_path("..", __dir__)

class HarnessHttpError < StandardError; end

# A request that runs when its result is first used, as Workato's does.
class Chain
  def initialize(ctx, method, path, body)
    @ctx = ctx
    @method = method
    @path = path
    @body = body
    @handlers = []
  end

  def after_error_response(*codes, &blk)
    @handlers << [codes, blk]
    self
  end

  def resolve
    return @resolved if defined?(@resolved)
    status, parsed = @ctx.send_request(@method, @path, @body)
    if status >= 400
      handler = @handlers.find { |codes, _| codes.any? { |c| c === status } }
      raise HarnessHttpError, "#{status} from #{@method.upcase} #{@path}" unless handler
      @resolved = handler[1].call(status, parsed, {}, "#{status}")
    else
      @resolved = parsed
    end
  end

  def is_a?(klass)

    resolve.is_a?(klass)
  end
  def to_h
    resolve.to_h
  end
  def [](key)
    resolve[key]
  end
  def to_s
    resolve.to_s
  end
  def method_missing(name, *args, &blk)
    resolve.public_send(name, *args, &blk)
  end
  def respond_to_missing?(*)
    true
  end
end

class Ctx
  attr_reader :sent

  def initialize(connector, cassette, settings)
    @connector = connector
    @settings = settings
    @sent = []
    file = File.join(ROOT, "fixtures/vcr_cassettes/#{cassette}.json")
    @recorded = cassette ? JSON.parse(File.read(file))["http_interactions"] : []
  end

  def post(path, body = nil)
    Chain.new(self, "post", path, body)
  end
  def delete(path)
    Chain.new(self, "delete", path, nil)
  end
  def headers(h)
    h
  end
  def error(message)
    raise(HarnessHttpError, message)
  end
  def workato
    Struct.new(:uuid).new(SecureRandom.uuid)
  end

  def call(name, *args)
    instance_exec(*args, &@connector[:methods].fetch(name))
  end

  def send_request(method, path, body)
    @sent << [method, path, body]
    hit = @recorded.find { |i| i["request"]["method"] == method && URI(i["request"]["uri"]).request_uri == path }
    raise "no recorded interaction for #{method} #{path}" unless hit
    text = hit["response"]["body"]["string"]
    [hit["response"]["status"]["code"], text.empty? ? {} : JSON.parse(text)]
  end

  def run(lambda_, *args)
    out = instance_exec(*args, &lambda_)
    Chain === out ? out.resolve : out
  end
end

class ConnectorTest < Minitest::Test
  CONNECTOR = eval(File.read(File.join(ROOT, "connector.rb")), TOPLEVEL_BINDING, "connector.rb")
  SETTINGS = { "base_url" => "https://tensorcost.example.com", "gateway_key" => "tcgw_test_key", "key_name" => "recipes-prod", "fail_mode" => "open" }.freeze
  CALLERS = [
    { "kind" => "team", "id" => "search" },
    { "kind" => "tag", "id" => "team=search" },
    { "kind" => "user", "id" => "ana@acme.com" },
    { "kind" => "key", "id" => "recipes-prod" },
    { "kind" => "tag", "id" => "cost-center=search" }
  ].freeze
  CHECK = {
    "model" => "claude-sonnet-4-5", "provider" => "anthropic", "max_tokens" => 4096, "input_tokens" => 1800,
    "team" => "search", "user_email" => "ana@acme.com", "recipe_id" => "recipe-4417", "agent_id" => "triage",
    "tags" => [{ "key" => "cost-center", "value" => "search" }]
  }.freeze

  def ctx(cassette, settings = SETTINGS)
    Ctx.new(CONNECTOR, cassette, settings)
  end
  def action(name, c, input)
    c.run(CONNECTOR[:actions][name][:execute], c.instance_variable_get(:@settings), input)
  end

  def test_every_request_carries_the_key_and_a_user_agent
    # TensorCost's WAF blocks a request with no User-Agent; the connector names itself.
    applied = ctx(nil).instance_exec(SETTINGS, &CONNECTOR[:connection][:authorization][:apply])
    assert_equal "Bearer tcgw_test_key", applied[:Authorization]
    assert_match %r{\ATensorCost-Workato/\d+\.\d+\.\d+\z}, applied[:"User-Agent"]
  end

  def test_connection_test_passes_with_a_valid_key
    c = ctx("connection_test_ok")
    assert_equal true, c.run(CONNECTOR[:test], SETTINGS)["allowed"]
    assert_equal [["post", "/v1/gateway/headroom", {}]], c.sent
  end

  def test_connection_test_says_the_key_was_refused_on_401
    c = ctx("connection_test_401")
    err = assert_raises(HarnessHttpError) { c.run(CONNECTOR[:test], SETTINGS) }
    assert_includes err.message, "Your TensorCost gateway key was refused"
  end

  def test_a_refusal_that_came_as_200_is_not_allowed_and_carries_the_message
    out = action(:check_budget, ctx("check_budget_refuse"), CHECK)
    assert_equal false, out["allowed"]
    assert_equal "refuse", out["decision"]
    assert_equal "budget_hard_cap", out["reason"]
    assert_includes out["message"], "Search team has reached its monthly AI budget"
    assert_equal "7d2a4e19-0c3b-4f8a-9e61-5b0d8c2f7a34", out["decision_id"]
  end

  def test_check_budget_sends_the_callers_and_no_reroute_request
    c = ctx("check_budget_allow")
    out = action(:check_budget, c, CHECK)
    assert_equal true, out["allowed"]
    assert_equal 6.684, out["reservation_cents"]
    _, path, body = c.sent.fetch(0)
    assert_equal "/v1/gateway/admit", path
    assert_equal CALLERS, body["callers"]
    assert_equal "recipe-4417", body["workflow_id"]
    assert_equal false, body["can_reroute"]
    refute body.key?("correlation_id")
  end

  def test_fail_open_allows_after_one_failed_ask
    c = ctx("check_budget_error")
    out = action(:check_budget, c, CHECK)
    assert_equal true, out["allowed"]
    assert_equal true, out["degraded"]
    assert_equal 1, c.sent.length
  end

  def test_fail_closed_stops_the_step
    closed = SETTINGS.merge("fail_mode" => "closed")
    out = action(:check_budget, ctx("check_budget_error", closed), CHECK)
    assert_equal false, out["allowed"]
    assert_equal "refuse", out["decision"]
  end

  RECORD = {
    "provider" => "anthropic", "model" => "claude-sonnet-4-5", "input_tokens" => 1800, "output_tokens" => 412,
    "cached_input_tokens" => 600, "provider_response_id" => "msg_01Abc",
    "decision_id" => "3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10", "started_at" => "2026-11-14T09:30:00Z",
    "status" => "success", "log_id" => "from-the-recipe",
    "team" => "search", "user_email" => "ana@acme.com", "tags" => [{ "key" => "cost-center", "value" => "search" }]
  }.freeze

  def logged_row(input)
    c = ctx("record_ai_spend")
    out = action(:record_ai_spend, c, input)
    assert_equal 1, c.sent.length
    [c.sent.first, out]
  end

  def test_record_ai_spend_posts_one_row_with_the_same_callers_as_the_check
    (method, path, body), out = logged_row(RECORD)
    assert_equal ["post", "/v1/gateway/logs?format=tensorcost"], [method, path]
    assert_equal ["logs"], body.keys
    assert_equal 1, body["logs"].length
    row = body["logs"].first
    assert_equal row["log_id"], out["log_id"]
    assert_equal "3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10", row["correlation_id"]
    assert_equal CALLERS, row["callers"]
    assert_equal CALLERS, ctx_callers_of_check
  end

  def ctx_callers_of_check
    c = ctx("check_budget_allow")
    action(:check_budget, c, CHECK)
    c.sent.first[2]["callers"]
  end

  def test_the_log_id_comes_from_the_decision_so_a_retried_job_counts_once
    (_, _, first), = logged_row(RECORD)
    (_, _, second), = logged_row(RECORD)
    assert_equal "wk:3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10", first["logs"][0]["log_id"]
    assert_equal first["logs"][0]["log_id"], second["logs"][0]["log_id"]
    refute_equal "from-the-recipe", first["logs"][0]["log_id"]
  end

  def test_without_a_decision_the_log_id_comes_from_the_provider_response_id
    (_, _, body), = logged_row(RECORD.reject { |k, _| k == "decision_id" })
    assert_equal "wk:msg_01Abc", body["logs"][0]["log_id"]
    refute body["logs"][0].key?("correlation_id")
  end

  def test_with_neither_the_log_id_is_minted_new_each_run
    bare = RECORD.reject { |k, _| %w[decision_id provider_response_id].include?(k) }
    (_, _, a), = logged_row(bare)
    (_, _, b), = logged_row(bare)
    assert_match(/\A\h{8}-\h{4}-4\h{3}-[89ab]\h{3}-\h{12}\z/, a["logs"][0]["log_id"])
    refute_equal a["logs"][0]["log_id"], b["logs"][0]["log_id"]
  end

  def test_a_team_is_sent_as_a_caller_and_as_a_team_tag_and_no_team_sends_neither
    callers = ctx("check_budget_allow").call(:callers, SETTINGS, CHECK)
    assert_includes callers, { "kind" => "team", "id" => "search" }
    assert_includes callers, { "kind" => "tag", "id" => "team=search" }
    none = ctx("check_budget_allow").call(:callers, SETTINGS, CHECK.reject { |k, _| k == "team" })
    assert_empty none.select { |c| c["id"].to_s.start_with?("team=") || c["kind"] == "team" }
  end

  def test_check_budget_surfaces_unmapped_callers
    out = action(:check_budget, ctx("check_budget_allow"), CHECK)
    assert_equal [], out["unmapped"]
  end

  DECISION = "3f0b7c2e-9a51-4d6e-8f43-2a7c1e5b9d10".freeze

  def test_cancel_check_posts_the_fenced_cancel_once_with_no_body
    c = ctx("cancel_check")
    out = action(:cancel_check, c, { "decision_id" => DECISION })
    assert_equal true, out["cancelled"]
    assert_equal [["post", "/v1/gateway/admit/#{DECISION}/cancel", nil]], c.sent
  end

  def test_cancel_check_fails_the_step_on_a_5xx_without_retrying
    c = ctx("cancel_check_error")
    assert_raises(HarnessHttpError) { action(:cancel_check, c, { "decision_id" => DECISION }) }
    assert_equal 1, c.sent.length
  end

  def test_cancel_check_refuses_an_id_that_is_not_a_decision_id
    c = ctx("cancel_check")
    assert_raises(HarnessHttpError) { action(:cancel_check, c, { "decision_id" => "../../v1/other" }) }
    assert_empty c.sent
  end

  def test_the_cancel_help_says_when_not_to_use_it
    help = CONNECTOR[:actions][:cancel_check][:help]
    assert_includes help, "provably never ran"
    assert_includes help, "Never use it after the provider was called"
  end

  def test_an_unreadable_row_fails_the_step
    input = { "provider" => "acme-llm", "model" => "claude-sonnet-4-5", "input_tokens" => 1, "output_tokens" => 1, "started_at" => "2026-11-14T09:30:00Z" }
    err = assert_raises(HarnessHttpError) { action(:record_ai_spend, ctx("record_ai_spend_unreadable"), input) }
    assert_includes err.message, "unknown_provider"
  end

  def test_get_team_spend_returns_budgets_and_counted_spend
    out = action(:get_team_spend, ctx("get_team_spend"), { "team" => "search" })
    assert_equal 1_650_000, out["counted_spend_mtd_cents"]
    assert_equal 348_800, out["budgets"].first["remaining_cents"]
  end

  def test_trigger_subscribes_dedups_and_unsubscribes
    trigger = CONNECTOR[:triggers][:budget_threshold_crossed]
    c = ctx("trigger_subscribe")
    url = "https://webhooks.workato.com/webhooks/rest/abc/tensorcost"
    sub = c.run(trigger[:webhook_subscribe], url, SETTINGS, {}, "recipe-1")
    assert_equal "9b1e5c7a-2d4f-4a6b-8c0e-1f3a5b7c9d2e", sub["id"]
    assert_equal({ "url" => url, "event_types" => ["budget.threshold_crossed"] }, c.sent[0][2])
    payload = { "event" => "budget.threshold_crossed", "budget" => { "id" => "b1" }, "crossed_at" => "2026-11-14T09:30:00Z" }
    assert_equal payload, c.run(trigger[:webhook_notification], {}, payload, {}, {}, {}, {})
    assert_equal "b1@2026-11-14T09:30:00Z", c.run(trigger[:dedup], payload)
    c.run(trigger[:webhook_unsubscribe], sub, SETTINGS)
    assert_equal ["delete", "/v1/gateway/subscriptions/9b1e5c7a-2d4f-4a6b-8c0e-1f3a5b7c9d2e"], c.sent[1][0, 2]
  end

  def test_the_help_text_for_record_ai_spend
    assert_includes CONNECTOR[:actions][:record_ai_spend][:help], "Only for calls made with your own provider keys. Workato's built-in AI is billed by Workato and isn't counted here."
  end
end
