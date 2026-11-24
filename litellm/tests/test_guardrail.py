from __future__ import annotations

import asyncio

from tensorcost_litellm._shared import VERSION
import copy
import time
import uuid

import pytest
from fastapi import HTTPException

from tensorcost_litellm import TensorCostAdmit, provably_never_billed
from tensorcost_litellm._shared import CORRELATION_METADATA_KEY, calls
from tensorcost_litellm.guardrail import model_info_from_list

MODEL_LIST = [
    {"model_name": "claude-sonnet", "litellm_params": {"model": "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"}},
    {"model_name": "claude-haiku", "litellm_params": {"model": "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"}},
    {"model_name": "gpt-4o", "litellm_params": {"model": "gpt-4o", "custom_llm_provider": "openai"}},
]


class Key:
    team_id = "team-search"
    user_id = "ana@acme.com"
    key_alias = "ci-key"


def allow(ttl=0, **extra):
    def handler(req):
        body = {
            "decision": "allow",
            "decision_id": str(uuid.uuid4()),
            "reason": None,
            "message": None,
            "reservation_cents": 1.2,
            "attribution": {"team": "search", "developer": "ana@acme.com", "unmapped": []},
            "fail_mode": "open",
            "cache_ttl_seconds": ttl,
        }
        body.update(extra)
        return 200, body, {"x-tc-fail-mode": "open"}

    return handler


def guard(server, **kw):
    kw.setdefault("api_base", server.url)
    kw.setdefault("api_key", "tcgw_test")
    kw.setdefault("model_info", lambda: model_info_from_list(MODEL_LIST))
    kw.setdefault("token_counter", lambda model, messages: 42)
    return TensorCostAdmit(guardrail_name="tensorcost", event_hook="pre_call", default_on=True, **kw)


def request(**over):
    data = {
        "model": "claude-sonnet",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 512,
        "litellm_call_id": str(uuid.uuid4()),
        "metadata": {"requester_metadata": {"tags": ["feature=summary"]}},
    }
    data.update(over)
    return data


def run(coro):
    return asyncio.run(coro)


def test_allow_passes_the_request_through_and_sends_what_the_contract_reads(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server)
    data = request()
    before = copy.deepcopy(data)
    out = run(g.async_pre_call_hook(Key(), None, data, "completion"))

    assert out is data
    stamped = out["metadata"].pop(CORRELATION_METADATA_KEY)
    assert out == before
    [hit] = server.hits("/v1/gateway/admit")
    assert hit["headers"]["authorization"] == "Bearer tcgw_test"
    # The plugin names itself; TensorCost's WAF blocks a request with no User-Agent.
    assert hit["headers"]["user-agent"] == f"TensorCost-LiteLLM/{VERSION}"
    body = hit["body"]
    assert body["correlation_id"] == stamped
    assert body["model"] == "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    assert body["provider"] == "bedrock"
    assert body["provider"] == "bedrock"
    assert body["accepts_models"] == [
        {"name": "claude-sonnet", "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "provider": "bedrock"},
        {"name": "claude-haiku", "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "provider": "bedrock"},
        {"name": "gpt-4o", "model": "gpt-4o", "provider": "openai"},
        "claude-sonnet",
        "claude-haiku",
        "gpt-4o",
    ]
    assert body["max_tokens"] == 512
    assert body["input_tokens"] == 42
    assert body["gateway"] == {"kind": "litellm", "instance": None}
    assert body["callers"] == [
        {"kind": "team", "id": "team-search"},
        {"kind": "user", "id": "ana@acme.com"},
        {"kind": "key", "id": "ci-key"},
        {"kind": "tag", "id": "feature=summary"},
    ]
    assert body["tags"] == ["feature=summary"]
    record = calls.get(stamped)
    assert record.correlation_id == stamped
    assert record.request_ref == id(data)


def test_the_hook_mints_its_own_correlation_id_over_the_callers(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server)
    data = request(metadata={CORRELATION_METADATA_KEY: "forged", "requester_metadata": {CORRELATION_METADATA_KEY: "forged"}})
    run(g.async_pre_call_hook(Key(), None, data, "completion"))
    minted = data["metadata"][CORRELATION_METADATA_KEY]
    assert minted != "forged"
    uuid.UUID(minted)
    assert CORRELATION_METADATA_KEY not in data["metadata"]["requester_metadata"]
    assert server.hits("/v1/gateway/admit")[0]["body"]["correlation_id"] == minted


def test_litellm_metadata_gets_the_id_when_the_route_uses_it(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server)
    data = request(metadata={"user_id": "x"}, litellm_metadata={})
    run(g.async_pre_call_hook(Key(), None, data, "anthropic_messages"))
    assert CORRELATION_METADATA_KEY in data["litellm_metadata"]
    # The provider's own metadata field is left as the caller sent it.
    assert data["metadata"] == {"user_id": "x"}


def test_the_customer_in_the_metadata_goes_to_admit(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server)
    run(g.async_pre_call_hook(Key(), None, request(metadata={"tensorcost_customer": " acme "}), "completion"))
    run(g.async_pre_call_hook(Key(), None, request(metadata={"requester_metadata": {"tensorcost_customer": "globex"}}), "completion"))
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    run(g.async_pre_call_hook(Key(), None, request(metadata={"tensorcost_customer": "x" * 129}), "completion"))
    bodies = [h["body"] for h in server.hits("/v1/gateway/admit")]
    assert [b.get("customer") for b in bodies] == ["acme", "globex", None, None]


def test_one_customers_cached_allow_never_covers_another_customers_call(server):
    server.on("/v1/gateway/admit", allow(ttl=5, reservation_cents=0))
    g = guard(server)
    run(g.async_pre_call_hook(Key(), None, request(metadata={"tensorcost_customer": "acme"}), "completion"))
    run(g.async_pre_call_hook(Key(), None, request(metadata={"tensorcost_customer": "acme"}), "completion"))
    run(g.async_pre_call_hook(Key(), None, request(metadata={"tensorcost_customer": "globex"}), "completion"))
    assert [h["body"].get("customer") for h in server.hits("/v1/gateway/admit")] == ["acme", "globex"]


def test_refuse_raises_429_with_the_message_and_retry_after(server):
    message = "TensorCost: Search team has reached its monthly AI budget ($20,000). Ask ana@acme.com to raise it."

    def refuse(req):
        return 200, {
            "decision": "refuse",
            "decision_id": str(uuid.uuid4()),
            "reason": "budget_hard_cap",
            "message": message,
            "retry_after_seconds": 3600,
            "reservation_cents": 1.0,
            "attribution": {"team": "search", "developer": None, "unmapped": []},
            "fail_mode": "open",
            "cache_ttl_seconds": 0,
        }, {}

    server.on("/v1/gateway/admit", refuse)
    g = guard(server)
    data = request()
    with pytest.raises(HTTPException) as caught:
        run(g.async_pre_call_hook(Key(), None, data, "completion"))
    err = caught.value
    assert err.status_code == 429
    assert err.detail["error"]["type"] == "budget_exceeded"
    assert err.detail["error"]["message"] == message
    assert err.detail["error"]["retry_after_seconds"] == 3600
    assert err.headers == {"Retry-After": "3600"}
    # A refused call holds nothing the hook could cancel.
    assert calls.get(err.detail["error"].get("correlation_id", "")) is None
    assert calls.get(data["metadata"][CORRELATION_METADATA_KEY]) is None


def test_reroute_rewrites_the_model(server):
    rid = str(uuid.uuid4())
    server.on(
        "/v1/gateway/admit",
        allow(decision="reroute", decision_id=rid, model="claude-haiku", route={"policy_id": "p", "from_model": "claude-sonnet", "to_model": "claude-haiku"}),
    )
    g = guard(server)
    data = request()
    run(g.async_pre_call_hook(Key(), None, data, "completion"))
    assert data["model"] == "claude-haiku"
    assert calls.get(data["metadata"][CORRELATION_METADATA_KEY]).decision_id == rid


def test_a_two_second_stall_allows_under_open(server):
    server.on("/v1/gateway/admit", allow())
    server.delay["/v1/gateway/admit"] = 2.0
    g = guard(server, fail_mode="open")
    data = request()
    started = time.monotonic()
    out = run(g.async_pre_call_hook(Key(), None, data, "completion"))
    assert out["model"] == "claude-sonnet"
    assert time.monotonic() - started < 1.8


def test_a_two_second_stall_raises_503_under_closed(server):
    server.on("/v1/gateway/admit", allow())
    server.delay["/v1/gateway/admit"] = 2.0
    g = guard(server, fail_mode="closed")
    started = time.monotonic()
    with pytest.raises(HTTPException) as caught:
        run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    assert caught.value.status_code == 503
    assert caught.value.detail["error"]["type"] == "budget_check_unavailable"
    assert time.monotonic() - started < 1.8


@pytest.mark.parametrize("status", [401, 429, 500, 503])
def test_a_non_2xx_is_tensorcost_failing_and_the_fail_mode_decides(server, status):
    server.on("/v1/gateway/admit", lambda req: (status, {"message": "no"}, {}))
    assert run(guard(server, fail_mode="open").async_pre_call_hook(Key(), None, request(), "completion"))["model"] == "claude-sonnet"
    with pytest.raises(HTTPException) as caught:
        run(guard(server, fail_mode="closed").async_pre_call_hook(Key(), None, request(), "completion"))
    assert caught.value.status_code == 503


def test_a_body_without_a_decision_is_a_failure(server):
    server.on("/v1/gateway/admit", lambda req: (200, {"ok": True}, {}))
    with pytest.raises(HTTPException):
        run(guard(server, fail_mode="closed").async_pre_call_hook(Key(), None, request(), "completion"))


def test_the_last_fail_mode_tensorcost_reported_overrides_the_configured_one(server):
    def closed(req):
        status, body, _ = allow()(req)
        body["fail_mode"] = "closed"
        return status, body, {"x-tc-fail-mode": "closed"}

    server.on("/v1/gateway/admit", closed)
    g = guard(server, fail_mode="open")
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    assert g.fail_mode == "closed"
    server.delay["/v1/gateway/admit"] = 2.0
    with pytest.raises(HTTPException) as caught:
        run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    assert caught.value.status_code == 503


def test_an_answer_that_couldnt_read_the_fail_mode_doesnt_change_it(server):
    g = guard(server, fail_mode="open")
    g.seen_fail_mode = "closed"
    server.on("/v1/gateway/admit", allow(fail_mode="open", fail_mode_known=False, degraded=True, detail="fail_mode_unknown"))
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    assert g.fail_mode == "closed"


def test_a_cached_allow_makes_no_second_call_within_the_ttl(server):
    server.on("/v1/gateway/admit", allow(ttl=5, reservation_cents=0))
    g = guard(server)
    first, second = request(), request()
    run(g.async_pre_call_hook(Key(), None, first, "completion"))
    run(g.async_pre_call_hook(Key(), None, second, "completion"))
    assert len(server.hits("/v1/gateway/admit")) == 1
    # The second call has its own correlation id, and no decision of its own to cancel.
    assert second["metadata"][CORRELATION_METADATA_KEY] != first["metadata"][CORRELATION_METADATA_KEY]
    assert calls.get(second["metadata"][CORRELATION_METADATA_KEY]).decision_id is None


def test_the_cache_expires_with_the_ttl(server, monkeypatch):
    import tensorcost_litellm.guardrail as mod

    now = [1000.0]
    monkeypatch.setattr(mod.time, "monotonic", lambda: now[0])
    server.on("/v1/gateway/admit", allow(ttl=5, reservation_cents=0))
    g = guard(server)
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    now[0] += 4.9
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    assert len(server.hits("/v1/gateway/admit")) == 1
    now[0] += 0.2
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    assert len(server.hits("/v1/gateway/admit")) == 2


@pytest.mark.parametrize(
    "answer",
    [
        {"cache_ttl_seconds": 0, "reservation_cents": 0},
        {"cache_ttl_seconds": 5, "reservation_cents": 0, "degraded": True},
        {"cache_ttl_seconds": 5, "reservation_cents": 0, "fail_mode_known": False},
        # TensorCost says 0 for an allow that held anything; the hook never
        # reuses one that reserved anything either, whatever the TTL says.
        {"cache_ttl_seconds": 5, "reservation_cents": 1.2},
        {"cache_ttl_seconds": 5, "reservation_cents": None},
    ],
)
def test_only_what_tensorcost_marks_cacheable_is_reused(server, answer):
    server.on("/v1/gateway/admit", allow(**answer))
    g = guard(server)
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    assert len(server.hits("/v1/gateway/admit")) == 2


def test_a_reroute_is_never_cached(server):
    server.on("/v1/gateway/admit", allow(ttl=5, reservation_cents=0, decision="reroute", model="claude-haiku"))
    g = guard(server)
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    assert len(server.hits("/v1/gateway/admit")) == 2


def test_a_bigger_call_isnt_covered_by_a_smaller_ones_cached_allow(server):
    server.on("/v1/gateway/admit", allow(ttl=5, reservation_cents=0))
    g = guard(server)
    run(g.async_pre_call_hook(Key(), None, request(max_tokens=100), "completion"))
    run(g.async_pre_call_hook(Key(), None, request(max_tokens=64000), "completion"))
    assert len(server.hits("/v1/gateway/admit")) == 2
    # A longer prompt isn't covered either.
    counts = iter([10, 100_000])
    g2 = guard(server, token_counter=lambda model, messages: next(counts))
    run(g2.async_pre_call_hook(Key(), None, request(), "completion"))
    run(g2.async_pre_call_hook(Key(), None, request(), "completion"))
    assert len(server.hits("/v1/gateway/admit")) == 4


def test_no_admit_is_ever_resent(server):
    server.on("/v1/gateway/admit", lambda req: (503, {}, {}))
    run(guard(server).async_pre_call_hook(Key(), None, request(), "completion"))
    assert len(server.hits("/v1/gateway/admit")) == 1


def test_a_request_with_no_model_is_left_alone(server):
    g = guard(server)
    data = {"messages": []}
    assert run(g.async_pre_call_hook(Key(), None, data, "completion")) == {"messages": []}
    assert server.requests == []


def test_settings_come_from_os_environ_references(server, monkeypatch):
    monkeypatch.setenv("MY_TC_URL", server.url + "/")
    monkeypatch.setenv("MY_TC_KEY", "tcgw_env")
    g = TensorCostAdmit(api_base="os.environ/MY_TC_URL", api_key="os.environ/MY_TC_KEY", model_info=lambda: ([], {}))
    assert g.api_base == server.url
    assert g.api_key == "tcgw_env"


def test_a_bad_fail_mode_is_refused_at_startup():
    with pytest.raises(ValueError):
        TensorCostAdmit(api_base="http://x", api_key="k", fail_mode="maybe")


def test_litellms_own_guardrail_settings_reach_the_base_class(server):
    g = guard(server)
    assert g.guardrail_name == "tensorcost"
    assert g.default_on is True


# ------------------------------------------------------------- cancel


class ProviderError(Exception):
    def __init__(self, status_code, num_retries=None):
        super().__init__(f"status {status_code}")
        self.status_code = status_code
        if num_retries is not None:
            self.num_retries = num_retries


class Timeout(Exception):
    status_code = 408


class APIConnectionError(Exception):
    status_code = 500


class BudgetExceededError(Exception):
    pass


@pytest.mark.parametrize(
    "exc,never",
    [
        (ProviderError(401), True),
        (ProviderError(403), True),
        (ProviderError(404), True),
        (ProviderError(429), True),
        (BudgetExceededError("over"), True),
        (ProviderError(400), False),
        (ProviderError(408), False),
        (ProviderError(500), False),
        (ProviderError(503), False),
        (ProviderError(429, num_retries=2), False),
        (Timeout(), False),
        (APIConnectionError(), False),
        (RuntimeError("stream broke"), False),
    ],
)
def test_only_a_provably_unbilled_failure_counts_as_never_billed(exc, never):
    assert provably_never_billed(exc) is never


def _admitted(server, g):
    data = request()
    run(g.async_pre_call_hook(Key(), None, data, "completion"))
    return data


def _fail(g, data, exc):
    async def go():
        await g.async_post_call_failure_hook(data, exc, Key())
        await asyncio.gather(*list(g._background))

    run(go())


def test_a_provider_429_cancels_the_hold(server):
    did = str(uuid.uuid4())
    server.on("/v1/gateway/admit", allow(decision_id=did))
    server.on(f"/v1/gateway/admit/{did}/cancel", lambda req: (200, {"decision_id": did, "cancelled": True}, {}))
    g = guard(server)
    data = _admitted(server, g)
    _fail(g, data, ProviderError(429))
    [hit] = server.hits(f"/v1/gateway/admit/{did}/cancel")
    assert hit["method"] == "POST"


def test_the_cancel_is_tried_once_more_after_a_5xx(server):
    did = str(uuid.uuid4())
    server.on("/v1/gateway/admit", allow(decision_id=did))
    server.on(f"/v1/gateway/admit/{did}/cancel", lambda req: (503, {}, {}))
    g = guard(server)
    data = _admitted(server, g)
    _fail(g, data, ProviderError(401))
    assert len(server.hits(f"/v1/gateway/admit/{did}/cancel")) == 2


@pytest.mark.parametrize("exc", [ProviderError(500), Timeout(), ProviderError(400), ProviderError(429, num_retries=1)])
def test_a_call_that_may_have_been_billed_keeps_its_hold(server, exc):
    server.on("/v1/gateway/admit", allow())
    g = guard(server)
    data = _admitted(server, g)
    _fail(g, data, exc)
    assert [r for r in server.requests if r["path"].endswith("/cancel")] == []


def test_a_cached_allow_never_cancels_another_calls_hold(server):
    server.on("/v1/gateway/admit", allow(ttl=5, reservation_cents=0))
    g = guard(server)
    _admitted(server, g)
    second = _admitted(server, g)
    _fail(g, second, ProviderError(429))
    assert [r for r in server.requests if r["path"].endswith("/cancel")] == []


def test_two_calls_sending_the_same_call_id_keep_their_own_decisions(server):
    """A client chooses x-litellm-call-id: one call's 401 can't cancel the other's hold."""
    ids = iter([str(uuid.uuid4()), str(uuid.uuid4())])
    decisions = []

    def admit(req):
        did = next(ids)
        decisions.append(did)
        return allow(decision_id=did)(req)

    server.on("/v1/gateway/admit", admit)
    server.on("/v1/gateway/admit/*", lambda req: (200, {"cancelled": True}, {}))
    g = guard(server)
    a = request(litellm_call_id="same-id")
    b = request(litellm_call_id="same-id")
    run(g.async_pre_call_hook(Key(), None, a, "completion"))
    run(g.async_pre_call_hook(Key(), None, b, "completion"))
    assert a["metadata"][CORRELATION_METADATA_KEY] != b["metadata"][CORRELATION_METADATA_KEY]
    _fail(g, b, ProviderError(401))
    cancelled = [r["path"] for r in server.requests if r["path"].endswith("/cancel")]
    assert cancelled == [f"/v1/gateway/admit/{decisions[1]}/cancel"]


def test_a_request_carrying_another_calls_correlation_id_cancels_nothing(server):
    did = str(uuid.uuid4())
    server.on("/v1/gateway/admit", allow(decision_id=did))
    server.on("/v1/gateway/admit/*", lambda req: (200, {"cancelled": True}, {}))
    g = guard(server)
    a = request()
    run(g.async_pre_call_hook(Key(), None, a, "completion"))
    # A request whose own admit never ran, naming A's id in its metadata.
    forged = {"model": "claude-sonnet", "metadata": {CORRELATION_METADATA_KEY: a["metadata"][CORRELATION_METADATA_KEY]}}
    _fail(g, forged, ProviderError(401))
    assert [r for r in server.requests if r["path"].endswith("/cancel")] == []
    assert calls.get(a["metadata"][CORRELATION_METADATA_KEY]).final_failed is False


def test_no_cancel_after_the_router_fell_back(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server)
    for marks in ({"metadata": {"previous_models": [{"model": "claude-sonnet"}]}}, {"fallback_depth": 1}):
        data = _admitted(server, g)
        for k, v in marks.items():
            if isinstance(v, dict):
                data[k].update(v)
            else:
                data[k] = v
        _fail(g, data, ProviderError(429))
    assert [r for r in server.requests if r["path"].endswith("/cancel")] == []


@pytest.mark.parametrize("reason", ["check_unavailable", "invalid_request"])
def test_a_refusal_because_tensorcost_couldnt_check_is_a_503_not_a_budget(server, reason):
    def refuse(req):
        return 200, {
            "decision": "refuse",
            "decision_id": str(uuid.uuid4()),
            "reason": reason,
            "message": None,
            "reservation_cents": 0,
            "attribution": {"team": None, "developer": None, "unmapped": []},
            "fail_mode": "closed",
            "cache_ttl_seconds": 0,
        }, {}

    server.on("/v1/gateway/admit", refuse)
    with pytest.raises(HTTPException) as caught:
        run(guard(server).async_pre_call_hook(Key(), None, request(), "completion"))
    assert caught.value.status_code == 503
    assert caught.value.detail["error"]["type"] == "budget_check_unavailable"
    assert caught.value.detail["error"]["reason"] == reason


def test_a_slow_token_count_is_given_up_and_the_check_goes_without_it(server):
    server.on("/v1/gateway/admit", allow())

    def slow(model, messages):
        time.sleep(1.0)
        return 5

    async def timed():
        started = time.monotonic()
        await guard(server, token_counter=slow).async_pre_call_hook(Key(), None, request(), "completion")
        return time.monotonic() - started

    # Timed inside the loop: asyncio.run itself waits for the counting thread at shutdown.
    assert run(timed()) < 0.9
    assert "input_tokens" not in server.hits("/v1/gateway/admit")[0]["body"]


def test_a_throttled_answer_is_followed_and_logged_once_a_minute(server, caplog):
    server.on("/v1/gateway/admit", allow(degraded=True, detail="throttled", reservation_cents=0))
    g = guard(server)
    with caplog.at_level("WARNING", logger="tensorcost_litellm"):
        run(g.async_pre_call_hook(Key(), None, request(), "completion"))
        run(g.async_pre_call_hook(Key(), None, request(), "completion"))
    notes = [r for r in caplog.records if "past its TensorCost admit rate" in r.getMessage()]
    assert len(notes) == 1


def test_an_admit_429_says_the_key_is_unknown(server, caplog):
    server.on("/v1/gateway/admit", lambda req: (429, {}, {}))
    with caplog.at_level("WARNING", logger="tensorcost_litellm"):
        run(guard(server, fail_mode="open").async_pre_call_hook(Key(), None, request(), "completion"))
    assert any("throttled this key as unknown" in r.getMessage() for r in caplog.records)



def test_model_info_drops_the_provider_routing_prefix():
    from tensorcost_litellm.guardrail import model_info_from_list

    names, deployments = model_info_from_list(
        [
            {"model_name": "gpt-4.1-mini", "litellm_params": {"model": "openai/gpt-4.1-mini"}},
            {"model_name": "haiku", "litellm_params": {"model": "bedrock/anthropic.claude-3-haiku", "custom_llm_provider": "bedrock"}},
            {"model_name": "plain", "litellm_params": {"model": "gpt-4o"}},
        ]
    )
    assert deployments["gpt-4.1-mini"] == ("gpt-4.1-mini", "openai", None)
    assert deployments["haiku"] == ("anthropic.claude-3-haiku", "bedrock", None)
    assert deployments["plain"] == ("gpt-4o", None, None)


def test_a_policy_refusal_is_403_and_a_budget_refusal_stays_429():
    from tensorcost_litellm.guardrail import _refusal

    gov = _refusal({"reason": "model_governance_denied", "message": "not approved", "decision_id": "d1"})
    assert gov.status_code == 403
    assert gov.detail["error"]["type"] == "permission_denied"
    assert gov.detail["error"]["decision_id"] == "d1"
    budget = _refusal({"reason": "budget_hard_cap", "message": "cap reached"})
    assert budget.status_code == 429
    assert budget.detail["error"]["type"] == "budget_exceeded"


# A model_list alias is the caller's name for a deployment, never the model
# of record: customers name them anything ("azure-gpt-5.4", "prod-chat").
ALIAS_LIST = [
    {"model_name": "azure-gpt-5.4", "litellm_params": {"model": "azure/gpt-5.4", "api_base": "https://acme.openai.azure.com"}},
    {"model_name": "cheap", "litellm_params": {"model": "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0"}},
    {"model_name": "gpt-4.1-mini", "litellm_params": {"model": "openai/gpt-4.1-mini"}},
    {"model_name": "bare"},
]


def test_an_alias_resolves_to_its_deployments_model_and_provider():
    names, deployments = model_info_from_list(ALIAS_LIST)
    assert names == ["azure-gpt-5.4", "cheap", "gpt-4.1-mini", "bare"]
    assert deployments["azure-gpt-5.4"] == ("gpt-5.4", "azure", None)
    assert deployments["cheap"] == ("us.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock", None)
    # An alias equal to the model resolves to the same model.
    assert deployments["gpt-4.1-mini"] == ("gpt-4.1-mini", "openai", None)
    # No litellm_params: nothing to resolve, and no crash.
    assert deployments["bare"] == (None, None, None)


def test_admit_names_the_deployment_not_the_alias(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server, model_info=lambda: model_info_from_list(ALIAS_LIST))
    for alias, model, provider in (
        ("azure-gpt-5.4", "gpt-5.4", "azure"),
        ("cheap", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock"),
    ):
        data = request(model=alias)
        run(g.async_pre_call_hook(Key(), None, data, "completion"))
        # The request LiteLLM routes keeps the alias.
        assert data["model"] == alias
        body = server.hits("/v1/gateway/admit")[-1]["body"]
        assert (body["model"], body["provider"]) == (model, provider)


def test_a_name_no_deployment_has_goes_as_asked_with_no_provider(server):
    # LiteLLM will answer this call 400 itself; admit gets no guessed provider.
    server.on("/v1/gateway/admit", allow())
    g = guard(server, model_info=lambda: model_info_from_list(ALIAS_LIST))
    run(g.async_pre_call_hook(Key(), None, request(model="not-configured"), "completion"))
    body = server.hits("/v1/gateway/admit")[-1]["body"]
    assert body["model"] == "not-configured"
    assert "provider" not in body


class KeyNoTeam:
    team_id = None
    user_id = None
    key_alias = "billing-svc"
    end_user_id = None


def _admit_application(server, data, key=None):
    server.on("/v1/gateway/admit", allow())
    run(guard(server).async_pre_call_hook(key or Key(), None, data, "completion"))
    return server.hits("/v1/gateway/admit")[-1]["body"].get("application")


def test_the_application_goes_to_admit_by_its_order_of_precedence(server):
    header = {"proxy_server_request": {"headers": {"X-TC-Application": "support-bot"}}}
    meta = {"tensorcost_application": "from-metadata", "requester_metadata": {"tags": ["application=from-tag"]}}
    # The header first, over metadata and tags.
    assert _admit_application(server, request(metadata=dict(meta), **header)) == "support-bot"
    # Then the request metadata, or the caller's own copy of it.
    assert _admit_application(server, request(metadata=dict(meta))) == "from-metadata"
    assert _admit_application(server, request(metadata={"requester_metadata": {"tensorcost_application": "mine"}})) == "mine"
    # Then an application= or app: tag.
    assert _admit_application(server, request(metadata={"requester_metadata": {"tags": ["feature=x", "app:search"]}})) == "search"
    # Then LiteLLM's end user (the body's user), then the key's alias.
    assert _admit_application(server, request(metadata={}, user="checkout"), KeyNoTeam()) == "checkout"
    assert _admit_application(server, request(metadata={}), KeyNoTeam()) == "billing-svc"
    # A header with a control character in it is no name.
    assert _admit_application(server, request(metadata={}, proxy_server_request={"headers": {"x-tc-application": "a\nb"}}), KeyNoTeam()) == "billing-svc"


def test_an_allow_for_one_application_is_never_reused_for_another(server):
    server.on("/v1/gateway/admit", allow(ttl=30, reservation_cents=0))
    g = guard(server)
    for app in ("a", "b", "a"):
        run(g.async_pre_call_hook(Key(), None, request(proxy_server_request={"headers": {"x-tc-application": app}}), "completion"))
    assert [h["body"]["application"] for h in server.hits("/v1/gateway/admit")] == ["a", "b"]


# ----------------------------------------------------- accepts_models (0.1.4)


def test_accepts_models_pairs_each_alias_with_its_deployment_then_sends_the_bare_names(server):
    # On a test install, 0.1.3 sent only "azure-gpt-5.4-mini", which never
    # matched a route to gpt-5.4-mini, and 71 calls gave 0 reroutes.
    server.on("/v1/gateway/admit", allow())
    g = guard(server, model_info=lambda: model_info_from_list(ALIAS_LIST))
    run(g.async_pre_call_hook(Key(), None, request(model="azure-gpt-5.4"), "completion"))
    body = server.hits("/v1/gateway/admit")[-1]["body"]
    assert body["accepts_models"] == [
        {"name": "azure-gpt-5.4", "model": "gpt-5.4", "provider": "azure"},
        {"name": "cheap", "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "provider": "bedrock"},
        {"name": "gpt-4.1-mini", "model": "gpt-4.1-mini", "provider": "openai"},
        # Nothing to describe for a name with no litellm_params: a bare name only.
        "azure-gpt-5.4",
        "cheap",
        "gpt-4.1-mini",
        "bare",
    ]


def test_a_deployment_with_no_provider_is_described_without_one():
    from tensorcost_litellm.guardrail import accepted_models

    names, deployments = model_info_from_list([{"model_name": "plain", "litellm_params": {"model": "gpt-4o"}}])
    assert accepted_models(names, deployments) == [{"name": "plain", "model": "gpt-4o"}, "plain"]


def test_a_wildcard_route_goes_only_as_a_bare_name():
    from tensorcost_litellm.guardrail import accepted_models

    names, deployments = model_info_from_list(
        [
            {"model_name": "bedrock/*", "litellm_params": {"model": "bedrock/*"}},
            {"model_name": "*", "litellm_params": {"model": "*"}},
            {"model_name": "mini", "litellm_params": {"model": "openai/gpt-4o-mini"}},
        ]
    )
    assert accepted_models(names, deployments) == [{"name": "mini", "model": "gpt-4o-mini", "provider": "openai"}, "bedrock/*", "*", "mini"]


def test_both_halves_keep_the_contracts_cap_of_32():
    from tensorcost_litellm.guardrail import MAX_MODELS, accepted_models

    names, deployments = model_info_from_list([{"model_name": f"m{i}", "litellm_params": {"model": f"openai/m{i}"}} for i in range(40)])
    out = accepted_models(names, deployments)
    assert [e for e in out if isinstance(e, dict)] == [{"name": f"m{i}", "model": f"m{i}", "provider": "openai"} for i in range(MAX_MODELS)]
    assert [e for e in out if isinstance(e, str)] == [f"m{i}" for i in range(MAX_MODELS)]


def _reroute_to(server, target, model_info):
    server.on("/v1/gateway/admit", allow(decision="reroute", model=target, route={"policy_id": "p", "from_model": "gpt-5.4", "to_model": "gpt-5.4-mini"}))
    data = request(model="azure-gpt-5.4")
    run(guard(server, model_info=model_info).async_pre_call_hook(Key(), None, data, "completion"))
    return data


def test_a_reroute_to_an_alias_sets_the_alias_litellm_routes_by(server):
    alias_list = ALIAS_LIST + [{"model_name": "azure-gpt-5.4-mini", "litellm_params": {"model": "azure/gpt-5.4-mini"}}]
    data = _reroute_to(server, "azure-gpt-5.4-mini", lambda: model_info_from_list(alias_list))
    assert data["model"] == "azure-gpt-5.4-mini"


def test_a_reroute_to_a_name_the_proxy_doesnt_serve_runs_the_call_as_asked(server, caplog):
    # LiteLLM would fail the call with "Invalid model name"; the asked model runs instead.
    data = _reroute_to(server, "gpt-5.4-mini", lambda: model_info_from_list(ALIAS_LIST))
    assert data["model"] == "azure-gpt-5.4"
    assert any("isn't a model_name here" in r.getMessage() for r in caplog.records)


def test_a_reroute_a_wildcard_route_covers_is_followed(server):
    data = _reroute_to(server, "openai/gpt-5.4-mini", lambda: model_info_from_list([{"model_name": "openai/*", "litellm_params": {"model": "openai/*"}}]))
    assert data["model"] == "openai/gpt-5.4-mini"


def test_a_reroute_is_followed_when_the_model_list_couldnt_be_read(server):
    data = _reroute_to(server, "azure-gpt-5.4-mini", lambda: ([], {}))
    assert data["model"] == "azure-gpt-5.4-mini"


# ------------------------------------------- base_model: Azure deployment names

# Enterprises name Azure deployments their own way; LiteLLM's Azure docs ask
# for base_model so the call is priced as the model behind the name.
NAMED_AZURE = [
    {
        "model_name": "chat-mini",
        "litellm_params": {"model": "azure/prod-mini-deploy", "api_base": "https://acme.openai.azure.com"},
        "model_info": {"base_model": "azure/gpt-4o-mini"},
    },
    {"model_name": "chat-big", "litellm_params": {"model": "azure/prod-big-deploy", "base_model": "azure/gpt-4o"}, "model_info": {"base_model": "azure/gpt-4.1"}},
    {"model_name": "chat-same", "litellm_params": {"model": "azure/gpt-4o"}, "model_info": {"base_model": "azure/gpt-4o"}},
    {"model_name": "chat-bare-base", "litellm_params": {"model": "azure/prod-nano"}, "model_info": {"base_model": "gpt-4.1-nano"}},
]


def test_a_deployments_base_model_is_its_model_and_its_name_goes_beside_it():
    _, deployments = model_info_from_list(NAMED_AZURE)
    assert deployments["chat-mini"] == ("gpt-4o-mini", "azure", "prod-mini-deploy")
    # litellm_params.base_model wins over model_info's, as LiteLLM prices it.
    assert deployments["chat-big"] == ("gpt-4o", "azure", "prod-big-deploy")
    # A base_model that is the deployment's own model changes nothing.
    assert deployments["chat-same"] == ("gpt-4o", "azure", None)
    assert deployments["chat-bare-base"] == ("gpt-4.1-nano", "azure", "prod-nano")


def test_admit_checks_the_base_model_and_names_the_deployment(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server, model_info=lambda: model_info_from_list(NAMED_AZURE))
    data = request(model="chat-mini")
    run(g.async_pre_call_hook(Key(), None, data, "completion"))
    body = server.hits("/v1/gateway/admit")[-1]["body"]
    assert (body["model"], body["provider"], body["deployment"]) == ("gpt-4o-mini", "azure", "prod-mini-deploy")
    assert {"name": "chat-mini", "model": "gpt-4o-mini", "provider": "azure", "deployment": "prod-mini-deploy"} in body["accepts_models"]
    assert {"name": "chat-same", "model": "gpt-4o", "provider": "azure"} in body["accepts_models"]
    # LiteLLM still routes by the alias.
    assert data["model"] == "chat-mini"


def test_without_base_model_admit_is_as_before(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server, model_info=lambda: model_info_from_list(ALIAS_LIST))
    run(g.async_pre_call_hook(Key(), None, request(model="azure-gpt-5.4"), "completion"))
    body = server.hits("/v1/gateway/admit")[-1]["body"]
    assert body["model"] == "gpt-5.4"
    assert "deployment" not in body
    assert all("deployment" not in e for e in body["accepts_models"] if isinstance(e, dict))


def test_a_model_info_callable_that_returns_pairs_still_works(server):
    server.on("/v1/gateway/admit", allow())
    g = guard(server, model_info=lambda: (["x"], {"x": ("gpt-4o", "openai")}))
    run(g.async_pre_call_hook(Key(), None, request(model="x"), "completion"))
    body = server.hits("/v1/gateway/admit")[-1]["body"]
    assert (body["model"], body["provider"]) == ("gpt-4o", "openai")
    assert body["accepts_models"] == [{"name": "x", "model": "gpt-4o", "provider": "openai"}, "x"]
