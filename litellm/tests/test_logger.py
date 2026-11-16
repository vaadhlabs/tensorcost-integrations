from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import datetime, timezone

import pytest

from tensorcost_litellm import TensorCostSpendLogger, spend_logger
from tensorcost_litellm._shared import CORRELATION_METADATA_KEY, CallRecord, calls
from tensorcost_litellm.logger import BATCH_MAX, spend_row

START = datetime(2026, 11, 14, 10, 0, 0, tzinfo=timezone.utc)
END = datetime(2026, 11, 14, 10, 0, 2, tzinfo=timezone.utc)


def payload(call_id=None, **over):
    slp = {
        "id": call_id or str(uuid.uuid4()),
        "call_type": "acompletion",
        "response_cost": 0.01946,
        "status": "success",
        "total_tokens": 20500,
        "prompt_tokens": 20000,
        "completion_tokens": 500,
        "startTime": START.timestamp(),
        "endTime": END.timestamp(),
        "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "model_group": "claude-sonnet",
        "api_base": "https://bedrock-runtime.us-east-1.amazonaws.com",
        "metadata": {
            "user_api_key_team_id": "team-search",
            "user_api_key_user_id": "ana@acme.com",
            "user_api_key_alias": "ci-key",
            "user_api_key_hash": "hash-of-the-virtual-key",
            "requester_metadata": {"customer_note": "private", CORRELATION_METADATA_KEY: "forged"},
            "usage_object": {"input_tokens": 2000, "cache_read_input_tokens": 18000},
        },
        "cache_hit": False,
        "request_tags": ["feature=summary"],
        "end_user": "support-bot",
        "messages": [{"role": "user", "content": "the prompt"}],
        "response": {"choices": [{"message": {"content": "the answer"}}]},
        "model_parameters": {"temperature": 0.2},
        "hidden_params": {"api_base": "x"},
        "error_str": None,
        "error_information": None,
    }
    slp.update(over)
    return slp


class Usage:
    def __init__(self, cached=None, written=None):
        self.prompt_tokens_details = {"cached_tokens": cached} if cached is not None else None
        self.cache_creation_input_tokens = written


class Response:
    def __init__(self, id="msg_bdrk_01", usage=None):
        self.id = id
        self.usage = usage


def kwargs_for(slp, call_id=None, metadata=None):
    return {
        "litellm_call_id": call_id or slp["id"],
        "standard_logging_object": slp,
        "litellm_params": {"metadata": metadata or {}},
        "messages": slp["messages"],
    }


def minted(corr="corr-1"):
    """A correlation id the guardrail minted in this process."""
    calls.put(CallRecord(corr, "dec-1", time.monotonic()))
    return {CORRELATION_METADATA_KEY: corr}


def test_a_success_row_is_the_spend_log_shape_the_parser_reads():
    call_id = str(uuid.uuid4())
    slp = payload(call_id)
    row = spend_row(kwargs_for(slp, metadata=minted()), Response(usage=Usage(cached=18000, written=300)), START, END, failed=False)

    # The dedupe key is minted by the logger, never LiteLLM's call id.
    assert row["request_id"] != call_id
    uuid.UUID(row["request_id"])
    assert row["id"] == "msg_bdrk_01"
    assert row["model"] == slp["model"]
    assert row["model_group"] == "claude-sonnet"
    assert row["status"] == "success"
    assert row["call_type"] == "acompletion"
    assert row["spend"] == row["response_cost"] == 0.01946
    assert (row["prompt_tokens"], row["completion_tokens"], row["total_tokens"]) == (20000, 500, 20500)
    assert row["start_time"] == START.timestamp() and row["end_time"] == END.timestamp()
    assert row["team_id"] == "team-search" and row["user"] == "ana@acme.com" and row["end_user"] == "support-bot"
    assert row["request_tags"] == ["feature=summary"]
    assert row["usage_object"] == {"prompt_tokens_details": {"cached_tokens": 18000}, "cache_creation_input_tokens": 300}
    assert row["metadata"] == {
        "user_api_key_team_id": "team-search",
        "user_api_key_user_id": "ana@acme.com",
        "user_api_key_alias": "ci-key",
        "status": "success",
        CORRELATION_METADATA_KEY: "corr-1",
    }


def test_the_customer_the_caller_named_goes_on_the_row():
    slp = payload()
    row = spend_row(kwargs_for(slp, metadata={"tensorcost_customer": "acme"}), Response(), START, END, failed=False)
    assert row["metadata"]["tensorcost_customer"] == "acme"
    row = spend_row(kwargs_for(slp, metadata={"requester_metadata": {"tensorcost_customer": "globex"}}), Response(), START, END, failed=False)
    assert row["metadata"]["tensorcost_customer"] == "globex"
    row = spend_row(kwargs_for(slp), Response(), START, END, failed=False)
    assert "tensorcost_customer" not in row["metadata"]
    row = spend_row(kwargs_for(slp, metadata={"tensorcost_customer": "bad\nid"}), Response(), START, END, failed=False)
    assert "tensorcost_customer" not in row["metadata"]


def test_no_prompt_response_or_caller_metadata_leaves_the_proxy():
    slp = payload()
    text = json.dumps(spend_row(kwargs_for(slp), Response(), START, END, failed=False))
    for leaked in ("the prompt", "the answer", "temperature", "customer_note", "requester_metadata", "user_api_key_hash", "forged", "hidden_params"):
        assert leaked not in text


def test_cache_tokens_come_from_the_providers_usage_when_litellms_has_none():
    row = spend_row(kwargs_for(payload()), Response(usage=None), START, END, failed=False)
    assert row["usage_object"] == {"prompt_tokens_details": {"cached_tokens": 18000}}


def test_only_a_correlation_id_this_guardrail_minted_is_sent():
    slp = payload()
    row = spend_row(kwargs_for(slp, metadata=minted("stamped")), Response(), START, END, failed=False)
    assert row["metadata"][CORRELATION_METADATA_KEY] == "stamped"
    # A value a caller put there, which no guardrail here minted, is dropped.
    row = spend_row(kwargs_for(slp, metadata={CORRELATION_METADATA_KEY: "caller-chosen"}), Response(), START, END, failed=False)
    assert CORRELATION_METADATA_KEY not in row["metadata"]


def test_two_calls_with_the_same_litellm_call_id_are_two_rows():
    a = spend_row(kwargs_for(payload("same-id"), call_id="same-id"), Response(), START, END, failed=False)
    b = spend_row(kwargs_for(payload("same-id"), call_id="same-id"), Response(), START, END, failed=False)
    assert a["request_id"] != b["request_id"]


def test_a_cache_hit_carries_no_provider_id():
    row = spend_row(kwargs_for(payload(cache_hit=True)), Response(id="chatcmpl-old"), START, END, failed=False)
    assert row["cache_hit"] is True
    assert "id" not in row


def test_a_failure_row_carries_the_error_class_and_code_only():
    slp = payload(
        status="failure",
        response_cost=0.0,
        error_str="the prompt was rejected: the prompt",
        error_information={
            "error_code": "429",
            "error_class": "RateLimitError",
            "llm_provider": "bedrock",
            "error_message": "Your prompt said: the prompt",
            "traceback": "File ... the prompt",
        },
    )
    row = spend_row(kwargs_for(slp), None, START, END, failed=True)
    assert row["status"] == "failure"
    assert row["metadata"]["status"] == "failure"
    info = row["metadata"]["error_information"]
    assert info["error_code"] == "429" and info["error_class"] == "RateLimitError" and info["llm_provider"] == "bedrock"
    # The message can quote the request, so it never leaves.
    assert "error_message" not in info
    assert "traceback" not in info
    assert "id" not in row
    assert "the prompt" not in json.dumps(row)


def test_a_budget_refusal_is_sent_as_that_and_nothing_more():
    slp = payload(status="failure", error_information={"error_class": "ProxyException", "error_message": "Budget has been exceeded! Current cost: 12, Max budget: 10, prompt: the prompt"})
    info = spend_row(kwargs_for(slp), None, START, END, failed=True)["metadata"]["error_information"]
    assert info["error_message"] == "budget exceeded"


def test_no_payload_no_row():
    assert spend_row({"litellm_call_id": "x"}, None, START, END, failed=False) is None


def test_the_module_instance_is_a_spend_logger():
    assert isinstance(spend_logger, TensorCostSpendLogger)


# ---------------------------------------------------------------- pushes


def logger(server, **kw):
    kw.setdefault("api_base", server.url)
    kw.setdefault("api_key", "tcgw_test")
    kw.setdefault("flush_interval_seconds", 60)
    kw.setdefault("retry_delay_seconds", 0.01)
    return TensorCostSpendLogger(**kw)


def counts(req):
    n = len(req["body"])
    return 200, {"received": n, "inserted": n, "deduped": 0, "skipped": 0, "parse_errors": []}, {}


def push_rows(lg, n):
    async def go():
        for _ in range(n):
            slp = payload()
            await lg.async_log_success_event(kwargs_for(slp), Response(), START, END)
        await lg.flush()

    asyncio.run(go())


def test_pushes_go_to_the_litellm_format_with_the_key(server):
    server.on("/v1/gateway/logs", counts)
    push_rows(logger(server), 3)
    [hit] = server.hits("/v1/gateway/logs")
    assert hit["query"] == "/v1/gateway/logs?format=litellm"
    assert hit["headers"]["authorization"] == "Bearer tcgw_test"
    assert hit["headers"]["user-agent"] == "TensorCost-LiteLLM/0.1.0"
    assert isinstance(hit["body"], list) and len(hit["body"]) == 3


def test_a_batch_holds_at_most_500_rows(server):
    server.on("/v1/gateway/logs", counts)
    push_rows(logger(server), 1201)
    sizes = [len(r["body"]) for r in server.hits("/v1/gateway/logs")]
    assert sizes == [500, 500, 201]
    assert max(sizes) <= BATCH_MAX


def test_a_batch_size_above_500_is_held_to_500(server):
    assert logger(server, batch_size=2000).batch_size == 500


def test_a_5xx_is_retried_once(server):
    answers = iter([(503, {}, {}), None])

    def flaky(req):
        a = next(answers)
        return a if a else counts(req)

    server.on("/v1/gateway/logs", flaky)
    push_rows(logger(server), 2)
    hits = server.hits("/v1/gateway/logs")
    assert len(hits) == 2
    assert hits[0]["body"] == hits[1]["body"]


def test_two_5xx_drop_the_batch_after_one_retry(server):
    server.on("/v1/gateway/logs", lambda req: (500, {}, {}))
    push_rows(logger(server), 2)
    assert len(server.hits("/v1/gateway/logs")) == 2


def test_a_4xx_is_not_retried(server):
    server.on("/v1/gateway/logs", lambda req: (400, {"message": "bad"}, {}))
    push_rows(logger(server), 2)
    assert len(server.hits("/v1/gateway/logs")) == 1


def test_rows_queued_under_the_batch_size_go_on_the_timer(server):
    server.on("/v1/gateway/logs", counts)
    lg = logger(server, flush_interval_seconds=0.05)

    async def go():
        await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        await asyncio.sleep(0.5)

    asyncio.run(go())
    assert [len(r["body"]) for r in server.hits("/v1/gateway/logs")] == [1]


def test_a_full_queue_drops_rows_rather_than_growing(server):
    lg = logger(server, max_queue=3, batch_size=500)

    async def go():
        for _ in range(5):
            await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)

    asyncio.run(go())
    assert lg.dropped == 2


# ------------------------------------------- one row per call carries the correlation id


def event(lg, failed, corr, status=None):
    slp = payload(status="failure" if failed else "success", response_cost=0.0 if failed else 0.01946,
                  prompt_tokens=0 if failed else 20000, completion_tokens=0 if failed else 500, total_tokens=0 if failed else 20500,
                  error_information={"error_code": str(status), "error_class": "InternalServerError"} if failed else None)
    kw = kwargs_for(slp, call_id="router-call", metadata={CORRELATION_METADATA_KEY: corr})
    return (lg.async_log_failure_event if failed else lg.async_log_success_event)(kw, None if failed else Response(), START, END)


def pushed_rows(server):
    return [row for r in server.hits("/v1/gateway/logs") for row in r["body"]]


def test_a_failed_router_attempt_and_the_later_success_are_two_rows_and_only_the_success_names_the_call(server):
    server.on("/v1/gateway/logs", counts)
    lg = logger(server)
    minted("call-a")

    async def go():
        await event(lg, True, "call-a", 500)
        await lg.flush()  # the failure waits for the call to finish
        assert pushed_rows(server) == []
        await event(lg, False, "call-a")
        await lg.flush()

    asyncio.run(go())
    rows = pushed_rows(server)
    assert [r["status"] for r in rows] == ["failure", "success"]
    assert rows[0]["request_id"] != rows[1]["request_id"]
    assert CORRELATION_METADATA_KEY not in rows[0]["metadata"]
    assert rows[1]["metadata"][CORRELATION_METADATA_KEY] == "call-a"


def test_a_call_that_failed_for_good_names_itself_on_its_last_failure_row(server):
    server.on("/v1/gateway/logs", counts)
    lg = logger(server)
    minted("call-b")

    async def go():
        await event(lg, True, "call-b", 500)
        await event(lg, True, "call-b", 503)
        calls.get("call-b").final_failed = True  # the guardrail's failure hook ran
        await lg.flush()
        # A row logged after that goes without it.
        await event(lg, True, "call-b", 503)
        await lg.flush()

    asyncio.run(go())
    rows = pushed_rows(server)
    assert len(rows) == 3
    assert [CORRELATION_METADATA_KEY in r["metadata"] for r in rows] == [False, True, False]


def test_a_failure_row_waits_no_longer_than_the_hold(server):
    server.on("/v1/gateway/logs", counts)
    lg = logger(server, hold_failure_seconds=0.05, flush_interval_seconds=0.02)
    minted("call-c")

    async def go():
        await event(lg, True, "call-c", 500)
        await asyncio.sleep(0.4)

    asyncio.run(go())
    rows = pushed_rows(server)
    assert len(rows) == 1 and rows[0]["metadata"][CORRELATION_METADATA_KEY] == "call-c"


def test_rows_still_queued_at_exit_are_sent_once(server):
    server.on("/v1/gateway/logs", counts)
    lg = logger(server)
    minted("call-d")

    async def go():
        await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        await event(lg, True, "call-d", 500)

    asyncio.run(go())
    assert pushed_rows(server) == []
    lg.flush_at_exit()
    rows = pushed_rows(server)
    assert len(rows) == 2
    assert sum(CORRELATION_METADATA_KEY in r["metadata"] for r in rows) == 1
