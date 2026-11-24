from __future__ import annotations

import asyncio

from tensorcost_litellm._shared import VERSION
import json
import logging
import socket
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
        # No header, metadata or tag names one: LiteLLM's end user.
        "tensorcost_application": "support-bot",
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
    assert hit["headers"]["user-agent"] == f"TensorCost-LiteLLM/{VERSION}"
    assert isinstance(hit["body"], list) and len(hit["body"]) == 3


def test_a_batch_holds_at_most_500_rows(server):
    server.on("/v1/gateway/logs", counts)
    push_rows(logger(server), 1201)
    sizes = [len(r["body"]) for r in server.hits("/v1/gateway/logs")]
    assert sizes == [500, 500, 201]
    assert max(sizes) <= BATCH_MAX


def test_a_batch_size_above_500_is_held_to_500(server):
    assert logger(server, batch_size=2000).batch_size == 500


@pytest.mark.parametrize("status", [400, 401, 403, 413, 422])
def test_a_refusal_is_dropped_once_and_logged_with_what_tensorcost_said(server, caplog, status):
    server.on("/v1/gateway/logs", lambda req: (status, {"message": "format must be litellm, portkey or tensorcost"}, {}))
    lg = logger(server)
    caplog.set_level(logging.WARNING, logger="tensorcost_litellm")
    push_rows(lg, 2)
    asyncio.run(lg.flush())  # nothing is left to send again
    assert len(server.hits("/v1/gateway/logs")) == 1
    assert lg.refused == 2 and not lg._queue and lg._failures == 0
    [line] = [r for r in caplog.records if "refused" in r.getMessage()]
    assert line.levelno == logging.ERROR
    msg = line.getMessage()
    assert f"({status}," in msg and "2 rows dropped" in msg and "format must be litellm" in msg


# ------------------------------------------------- outages: retried until they land


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def record_ids(lg):
    """The request ids of what the logger has queued, oldest first."""
    return [r["request_id"] for r in lg._queue]


@pytest.mark.parametrize("outage_seconds", [120, 15 * 60])
def test_a_503_outage_loses_no_row_and_counts_each_once(server, outage_seconds):
    clock = FakeClock()
    start = clock.t
    attempts = []  # (fake time, the batch's request ids, answered)
    delivered = []

    def tensorcost(req):
        ids = [r["request_id"] for r in req["body"]]
        if clock() < start + outage_seconds:
            attempts.append((clock(), ids, 503))
            return 503, {"message": "TensorCost couldn't store the logs right now."}, {}
        attempts.append((clock(), ids, 200))
        delivered.extend(ids)
        return counts(req)

    server.on("/v1/gateway/logs", tensorcost)
    lg = logger(server, batch_size=4, retry_delay_seconds=1.0, retry_max_delay_seconds=60.0)
    lg._now = clock
    logged = []

    async def call():
        await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        logged.append(lg._queue[-1]["request_id"])

    async def go():
        # 16 calls, as on the install: half when Redis goes, half while it is out.
        for _ in range(8):
            await call()
        await lg.flush()
        second_half = False
        while lg._queue:
            assert clock.t < start + outage_seconds + 600, "still queued ten minutes after TensorCost came back"
            assert lg._retry_at > clock.t  # waiting out a backoff, not pushing
            clock.t = lg._retry_at
            if not second_half and clock.t > start + outage_seconds / 2:
                second_half = True
                for _ in range(8):
                    await call()
            await lg.flush()

    asyncio.run(go())

    # Every call's row landed, once.
    assert sorted(delivered) == sorted(logged) and len(logged) == 16
    assert len(set(delivered)) == 16
    assert lg.dropped == 0 and lg.refused == 0 and lg._failures == 0
    # A refused try sent rows under the keys they landed with.
    assert {i for _, ids, _ in attempts for i in ids} == set(logged)
    # Backoff: from about a second, doubling, never more than a minute apart.
    times = [t for t, _, _ in attempts]
    gaps = [b - a for a, b in zip(times, times[1:]) if b > a]
    assert 0.5 <= gaps[0] <= 1.0
    assert max(gaps) <= 60.0
    failed = [a for a in attempts if a[2] == 503]
    assert len(failed) <= 8 + outage_seconds / 30  # ~6 tries in the first minute, then one every 30-60 s


def test_a_retried_row_keeps_its_request_id(server):
    answers = iter([503, 502, 429, 200])
    bodies = []

    def flaky(req):
        bodies.append(req["body"])
        status = next(answers)
        return counts(req) if status == 200 else (status, {}, {})

    server.on("/v1/gateway/logs", flaky)
    clock = FakeClock()
    lg = logger(server)
    lg._now = clock

    async def go():
        for _ in range(3):
            await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        ids = record_ids(lg)
        while lg._queue:
            await lg.flush()
            clock.t = max(clock.t, lg._retry_at)
        return ids

    ids = asyncio.run(go())
    assert len(bodies) == 4
    # The same rows each time: same request ids, same bodies, byte for byte.
    assert all([r["request_id"] for r in b] == ids for b in bodies)
    assert all(b == bodies[0] for b in bodies)


def test_a_429_waits_at_least_its_retry_after(server):
    server.on("/v1/gateway/logs", lambda req: (429, {}, {"retry-after": "30"}))
    clock = FakeClock()
    lg = logger(server)
    lg._now = clock
    push_rows(lg, 1)
    assert lg._retry_at - clock.t >= 30
    assert len(lg._queue) == 1


def test_a_refused_connection_keeps_the_rows_until_tensorcost_is_back(server):
    with socket.socket() as s:  # a port nothing listens on
        s.bind(("127.0.0.1", 0))
        closed = f"http://127.0.0.1:{s.getsockname()[1]}"
    server.on("/v1/gateway/logs", counts)
    clock = FakeClock()
    lg = logger(server, api_base=closed)
    lg._now = clock
    push_rows(lg, 2)
    assert len(lg._queue) == 2 and lg._failures == 1 and lg.dropped == 0

    lg._api_base_setting = server.url
    clock.t = lg._retry_at
    asyncio.run(lg.flush())
    assert len(pushed_rows(server)) == 2 and not lg._queue and lg._failures == 0


def test_the_logger_retries_on_its_own_clock(server):
    answers = iter([503, 503, 503])

    def flaky(req):
        status = next(answers, 200)
        return counts(req) if status == 200 else (status, {}, {})

    server.on("/v1/gateway/logs", flaky)
    lg = logger(server, flush_interval_seconds=0.02, retry_delay_seconds=0.01, retry_max_delay_seconds=0.05)

    async def go():
        for _ in range(3):
            await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        await asyncio.sleep(1.0)  # nobody calls flush

    asyncio.run(go())
    assert len(server.hits("/v1/gateway/logs")) == 4
    assert len(pushed_rows(server)) == 12  # 3 rows, 4 tries
    assert not lg._queue


def test_the_hook_never_waits_for_tensorcost(server):
    server.on("/v1/gateway/logs", counts)
    server.delay["/v1/gateway/logs"] = 0.5
    lg = logger(server, batch_size=1)

    async def go():
        began = time.monotonic()
        for _ in range(5):
            await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        took = time.monotonic() - began
        await lg.flush()
        return took

    assert asyncio.run(go()) < 0.2  # one push alone takes 0.5 s
    assert len(pushed_rows(server)) == 5


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


def test_a_full_queue_in_an_outage_drops_the_oldest_and_says_so(server, caplog):
    up = {"ok": False}
    server.on("/v1/gateway/logs", lambda req: counts(req) if up["ok"] else (503, {}, {}))
    clock = FakeClock()
    lg = logger(server, max_queue=3, batch_size=500)
    lg._now = clock
    caplog.set_level(logging.WARNING, logger="tensorcost_litellm")
    ids = []

    async def go():
        await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        ids.append(lg._queue[-1]["request_id"])
        await lg.flush()  # 503: the outage begins
        for _ in range(4):
            clock.t += 10
            await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
            ids.append(lg._queue[-1]["request_id"])
        assert record_ids(lg) == ids[-3:]
        up["ok"] = True
        clock.t = lg._retry_at
        await lg.flush()

    asyncio.run(go())
    assert lg.dropped == 2
    assert [r["request_id"] for r in pushed_rows(server)][-3:] == ids[-3:]
    [line] = [r for r in caplog.records if "queue full" in r.getMessage()]
    assert line.levelno == logging.ERROR
    assert "3 rows waiting" in line.getMessage() and "1 dropped so far" in line.getMessage()


def test_the_batch_in_flight_counts_toward_the_queue_bound(server):
    server.on("/v1/gateway/logs", lambda req: (503, {}, {}))
    server.delay["/v1/gateway/logs"] = 0.3
    lg = logger(server, max_queue=4, batch_size=4)

    async def go():
        for _ in range(4):
            await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        await asyncio.sleep(0.1)  # the batch is in flight now
        assert len(lg._in_flight) == 4
        for _ in range(2):
            await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)
        await asyncio.sleep(0.5)  # the 503 comes back and so does the batch

    asyncio.run(go())
    assert len(lg._queue) + len(lg._in_flight) == 4 and lg.dropped == 2


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


def test_at_exit_a_tensorcost_that_is_down_is_tried_once_and_the_loss_is_logged(server, caplog):
    server.on("/v1/gateway/logs", lambda req: (503, {}, {}))
    lg = logger(server, batch_size=2)

    async def go():
        for _ in range(5):
            await lg.async_log_success_event(kwargs_for(payload()), Response(), START, END)

    asyncio.run(go())
    caplog.set_level(logging.WARNING, logger="tensorcost_litellm")
    # Shutdown cancelled the push in flight: its rows are queued again.
    assert len(lg._queue) == 5 and not lg._in_flight
    began = time.monotonic()
    lg.flush_at_exit()
    assert time.monotonic() - began < 5.5
    assert len(server.hits("/v1/gateway/logs")) <= 3  # it stops at the first failure
    [line] = [r for r in caplog.records if "not sent at exit" in r.getMessage()]
    assert line.levelno == logging.ERROR and "of 5 spend rows" in line.getMessage() and "503" in line.getMessage()


def test_at_exit_the_batch_in_flight_is_sent_again(server):
    server.on("/v1/gateway/logs", counts)
    lg = logger(server)
    row = spend_row(kwargs_for(payload()), Response(), START, END, failed=False)
    lg._in_flight = [row]
    lg.flush_at_exit()
    assert [r["request_id"] for r in pushed_rows(server)] == [row["request_id"]]


def test_a_resolved_alias_row_names_the_deployment_and_keeps_the_alias_beside_it():
    # LiteLLM's standard logging payload names the router's deployment
    # (litellm_params.model, "azure/gpt-5.4"); model_group is the caller's alias.
    slp = payload(
        model="azure/gpt-5.4",
        model_group="azure-gpt-5.4",
        custom_llm_provider="azure",
        api_base="https://acme.openai.azure.com",
    )
    row = spend_row(kwargs_for(slp), Response(), START, END, failed=False)
    assert row["model"] == "azure/gpt-5.4"
    assert row["model_group"] == "azure-gpt-5.4"
    assert row["api_base"] == "https://acme.openai.azure.com"


def test_an_unresolved_model_says_so_without_the_message():
    # LiteLLM had no deployment for the name: its 400 quotes the caller's alias.
    slp = payload(
        status="failure",
        model="azure-gpt-5.4",
        model_group=None,
        api_base="",
        response_cost=0.0,
        prompt_tokens=0,
        completion_tokens=0,
        total_tokens=0,
        error_information={
            "error_code": "400",
            "error_class": "ProxyModelNotFoundError",
            "error_message": "/chat/completions: Invalid model name passed in model=azure-gpt-5.4. Call `/v1/models` to view available models for your key.",
            "llm_provider": "",
        },
    )
    row = spend_row(kwargs_for(slp), None, START, END, failed=True)
    assert row["metadata"]["error_information"] == {
        "error_code": "400",
        "error_class": "ProxyModelNotFoundError",
        "error_message": "invalid model name",
    }
    assert "api_base" not in row
    assert "azure-gpt-5.4" not in json.dumps(row["metadata"])


def test_the_row_names_the_application_admit_was_sent():
    # The same request admit saw: header, then metadata, then tag, then end user, then key alias.
    from tensorcost_litellm._shared import request_application

    params = {"proxy_server_request": {"headers": {"x-tc-application": "support-bot"}}, "metadata": {"tensorcost_application": "other"}}
    slp = payload()
    row = spend_row({**kwargs_for(slp), "litellm_params": params}, Response(), START, END, failed=False)
    assert row["metadata"]["tensorcost_application"] == "support-bot"
    assert request_application(params, ["application=x"], "eu", "key") == "support-bot"

    slp = payload(request_tags=["app=search"], end_user=None)
    row = spend_row(kwargs_for(slp), Response(), START, END, failed=False)
    assert row["metadata"]["tensorcost_application"] == "search"

    slp = payload(request_tags=[], end_user=None)
    row = spend_row(kwargs_for(slp), Response(), START, END, failed=False)
    assert row["metadata"]["tensorcost_application"] == "ci-key"


# ------------------------------------------- base_model: Azure deployment names


def _azure(**over):
    return payload(model="azure/prod-mini-deploy", model_group="chat-mini", api_base="https://acme.openai.azure.com", **over)


@pytest.mark.parametrize(
    "params",
    [
        # Where LiteLLM 1.108.9 reads it for cost (utils.get_base_model_from_metadata), in its order.
        {"base_model": "azure/gpt-4o-mini", "metadata": {"model_info": {"base_model": "azure/gpt-4.1"}}},
        {"metadata": {"model_info": {"base_model": "azure/gpt-4o-mini"}}},
        {"metadata": {}, "litellm_metadata": {"model_info": {"base_model": "azure/gpt-4o-mini"}}},
        # A bare base_model takes the deployment's routing prefix, so the row's provider reads as before.
        {"metadata": {"model_info": {"base_model": "gpt-4o-mini"}}},
    ],
)
def test_a_deployments_base_model_is_the_rows_model_and_its_name_goes_beside_it(params):
    kw = kwargs_for(_azure())
    kw["litellm_params"] = params
    row = spend_row(kw, Response(), START, END, failed=False)
    assert row["model"] == "azure/gpt-4o-mini"
    # The Azure deployment's own name, without LiteLLM's prefix: what the guardrail sends to admit.
    assert row["deployment"] == "prod-mini-deploy"
    assert row["model_group"] == "chat-mini"


def test_a_deployment_without_a_prefix_keeps_its_name():
    # A model_list entry can name the provider in custom_llm_provider instead of the model string.
    kw = kwargs_for(payload(model="support-bot", model_group="support", api_base="https://acme.openai.azure.com"))
    kw["litellm_params"] = {"metadata": {"model_info": {"base_model": "azure/gpt-4o-mini"}}}
    row = spend_row(kw, Response(), START, END, failed=False)
    assert row["model"] == "azure/gpt-4o-mini"
    assert row["deployment"] == "support-bot"
    assert row["model_group"] == "support"


def test_without_base_model_the_row_is_as_before():
    row = spend_row(kwargs_for(_azure()), Response(), START, END, failed=False)
    assert row["model"] == "azure/prod-mini-deploy"
    assert "deployment" not in row
    same = kwargs_for(_azure())
    same["litellm_params"] = {"metadata": {"model_info": {"base_model": "azure/prod-mini-deploy"}}}
    assert "deployment" not in spend_row(same, Response(), START, END, failed=False)
