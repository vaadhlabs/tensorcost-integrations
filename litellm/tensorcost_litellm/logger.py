"""TensorCostSpendLogger: pushes each call's spend row to TensorCost.

LiteLLM calls ``async_log_success_event`` and ``async_log_failure_event``
after every call, and after every attempt its router makes. The logger turns
each event's ``standard_logging_object`` into the spend-log row TensorCost's
``format=litellm`` parser reads (the shape of LiteLLM's own spend-log rows,
with ``start_time``/``end_time``) and pushes rows in batches to
``POST /v1/gateway/logs?format=litellm``.

The row's ``request_id``, TensorCost's dedupe key, is a UUID the logger mints
for the event when it queues the row. It is never LiteLLM's call id: a client
sets that with the ``x-litellm-call-id`` header, and one id on every request
would have every row after the first deduped away. The minted id stays with
the row through the logger's own resend, so a resend still counts once.

The correlation id the guardrail minted goes on at most one row per call, so
admit's estimate for an unknown-cost row is booked once: the call's success
row, or, when no success comes, one of its failure rows. A failure row waits
up to HOLD_FAILURE_SECONDS for the call to finish before it goes. Every other
row of the call goes without it. The id is sent only when this process's
guardrail minted it, never one a caller put in their own metadata.

A row also carries the provider's response id as ``id``, model, tokens,
cache tokens, LiteLLM's cost, timing, the team, user and key alias, tags,
and a failure's error class and code, the end customer the caller named
under ``tensorcost_customer`` in the request's metadata, and the application
the guardrail sent admit (``_shared.request_application``). It never carries the
prompt, the response, the request parameters or the rest of the caller's own
metadata.

A batch holds at most 500 rows. A push that fails in a way waiting can fix
(a 5xx, a 408 or 429, a timeout, a refused or dropped connection) loses
nothing: its rows go back to the front of the queue and the logger waits,
doubling from ``retry_delay_seconds`` (1 s) up to ``retry_max_delay_seconds``
(60 s), with jitter, before it tries again. It keeps trying for as long as
the outage lasts. While it waits, nothing is pushed and LiteLLM's hooks only
queue. A retried row keeps its ``request_id``, so a batch TensorCost stored
before its answer was lost is deduped, not counted twice.

A refusal waiting can't fix (any other 4xx: a bad key, a malformed or
oversized batch) drops that batch and logs it once, with the status and
TensorCost's message.

The queue is bounded at ``max_queue`` rows (20,000), the batch in flight
included. When an outage outlasts it, the oldest rows go first, as in
TensorCost's Python SDK, and each drop is counted in ``dropped`` and logged
as an error. There is no disk spool: what is queued lives in this process.

When the proxy exits, an exit hook sends what is queued (and the batch that
was in flight, which dedupe makes safe) once, within a few seconds, and logs
how many rows it couldn't send.
"""

from __future__ import annotations

import asyncio
import atexit
import logging
import random
import re
import time
import uuid
import weakref
from collections import deque
from datetime import datetime
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

import httpx
from litellm.integrations.custom_logger import CustomLogger

from ._shared import (
    APPLICATION_METADATA_KEY,
    CORRELATION_METADATA_KEY,
    CUSTOMER_METADATA_KEY,
    KEY_ENV,
    auth_headers,
    base_url,
    calls,
    non_negative_int,
    request_application,
    request_customer,
    resolve_setting,
    text,
)

log = logging.getLogger("tensorcost_litellm")

#: TensorCost refuses a push of more than this many rows (413).
BATCH_MAX = 500
DEFAULT_FLUSH_SECONDS = 5.0
DEFAULT_QUEUE_MAX = 20_000
PUSH_TIMEOUT_SECONDS = 15.0
EXIT_PUSH_TIMEOUT_SECONDS = 3.0
#: The exit hook stops trying after this long in all, however much is left.
EXIT_DEADLINE_SECONDS = 5.0
#: The first wait after a failed push; each failure doubles it, up to the max.
RETRY_DELAY_SECONDS = 1.0
RETRY_MAX_DELAY_SECONDS = 60.0
#: While TensorCost stays down, a failed push is logged at most this often.
RETRY_LOG_EVERY_SECONDS = 60.0
#: After the first, one queue-full error per this many dropped rows.
DROP_LOG_EVERY = 1000
#: How much of a refusal's body goes in the log.
REFUSAL_BODY_CHARS = 300

# What one push came to.
_SENT, _RETRY, _REFUSED = "sent", "retry", "refused"
#: How long a failed attempt's row waits for the call to succeed or fail for good.
HOLD_FAILURE_SECONDS = 120.0

#: Fields of LiteLLM's error_information TensorCost's parser reads. Nothing else is sent.
_ERROR_FIELDS = (
    "error_code",
    "error_class",
    "llm_provider",
    "error_provider_request_id",
    "error_rate_limit_category",
)
#: What the parser reads from an error message: that a budget was exceeded,
#: or that LiteLLM had no deployment for the model the caller asked for.
_BUDGET_EXCEEDED = re.compile(r"budget (?:has been )?exceeded|exceeded (?:its |the )?budget", re.I)
_INVALID_MODEL = re.compile(r"invalid model name", re.I)

#: Caller fields of LiteLLM's logging metadata that name who made the call.
_CALLER_FIELDS = ("user_api_key_team_id", "user_api_key_user_id", "user_api_key_alias", "user_api_key_team_alias")

_live_loggers: "weakref.WeakSet[TensorCostSpendLogger]" = weakref.WeakSet()


class TensorCostSpendLogger(CustomLogger):
    def __init__(
        self,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
        batch_size: int = BATCH_MAX,
        flush_interval_seconds: float = DEFAULT_FLUSH_SECONDS,
        max_queue: int = DEFAULT_QUEUE_MAX,
        retry_delay_seconds: float = RETRY_DELAY_SECONDS,
        retry_max_delay_seconds: float = RETRY_MAX_DELAY_SECONDS,
        hold_failure_seconds: float = HOLD_FAILURE_SECONDS,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._api_base_setting = api_base
        self._api_key_setting = api_key
        self.batch_size = max(1, min(int(batch_size), BATCH_MAX))
        self.flush_interval_seconds = float(flush_interval_seconds)
        self.max_queue = max(1, int(max_queue))
        self.retry_delay_seconds = max(0.0, float(retry_delay_seconds))
        self.retry_max_delay_seconds = max(self.retry_delay_seconds, float(retry_max_delay_seconds))
        self.hold_failure_seconds = float(hold_failure_seconds)
        self._queue: Deque[Dict[str, Any]] = deque()
        #: The batch a push has taken off the queue and not yet settled. It
        #: counts toward max_queue, and the exit hook resends it.
        self._in_flight: List[Dict[str, Any]] = []
        #: Failure rows waiting for their call to finish, by correlation id: (first seen, rows).
        self._held: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
        self._timer: Optional[asyncio.Task] = None
        self._kick: Optional[asyncio.Task] = None
        self._flushing: Optional[asyncio.Lock] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._client_loop: Optional[asyncio.AbstractEventLoop] = None
        #: The clock backoff runs on. Tests swap it for a fake one.
        self._now: Callable[[], float] = time.monotonic
        #: Failed pushes in a row, when the current outage began, when the next try may go.
        self._failures = 0
        self._outage_since: Optional[float] = None
        self._retry_at = 0.0
        self._last_retry_log = 0.0
        #: Rows dropped because the queue was full, and rows TensorCost refused.
        self.dropped = 0
        self.refused = 0
        _live_loggers.add(self)

    # Settings are read when first used, not at import: LiteLLM imports the
    # module-level instance before a test or a proxy may have set the env.
    @property
    def api_base(self) -> Optional[str]:
        return base_url(self._api_base_setting)

    @property
    def api_key(self) -> Optional[str]:
        return resolve_setting(self._api_key_setting, KEY_ENV)

    # ------------------------------------------------------------------ hooks

    async def async_log_success_event(self, kwargs: dict, response_obj: Any, start_time: Any, end_time: Any) -> None:
        await self._record(kwargs, response_obj, start_time, end_time, failed=False)

    async def async_log_failure_event(self, kwargs: dict, response_obj: Any, start_time: Any, end_time: Any) -> None:
        await self._record(kwargs, response_obj, start_time, end_time, failed=True)

    # ------------------------------------------------------------- the queue

    async def _record(self, kwargs: dict, response_obj: Any, start_time: Any, end_time: Any, failed: bool) -> None:
        try:
            row = spend_row(kwargs, response_obj, start_time, end_time, failed)
        except Exception as err:  # a logging hook must never break the call
            log.debug("tensorcost: couldn't build a spend row: %s", err)
            return
        if row is None:
            return
        corr = row["metadata"].get(CORRELATION_METADATA_KEY)
        record = calls.get(corr) if corr else None
        if record is None:
            self._enqueue(row)
        elif record.correlation_sent:
            # The call's one row with its correlation id has gone already.
            self._enqueue(_without_correlation(row))
        elif failed:
            # A failed attempt may be followed by a success: it waits.
            first, rows = self._held.get(corr, (time.monotonic(), []))
            rows.append(row)
            self._held[corr] = (first, rows)
        else:
            record.correlation_sent = True
            _, earlier = self._held.pop(corr, (0.0, []))
            for r in earlier:
                self._enqueue(_without_correlation(r))
            self._enqueue(row)
        # The hook only queues. Pushes run on their own task, so a slow or
        # absent TensorCost never holds up LiteLLM's logging of the call.
        if len(self._queue) >= self.batch_size and not self._backing_off() and (self._kick is None or self._kick.done()):
            self._kick = asyncio.ensure_future(self._flush_quietly())
        if (self._queue or self._held) and (self._timer is None or self._timer.done()):
            self._timer = asyncio.ensure_future(self._flush_later())

    def _enqueue(self, row: Dict[str, Any]) -> None:
        # The batch in flight counts: if its push fails it comes back.
        while self._queue and len(self._queue) + len(self._in_flight) >= self.max_queue:
            self._queue.popleft()
            self._count_dropped()
        if len(self._queue) + len(self._in_flight) >= self.max_queue:
            # Only the batch in flight is left, and it fills the bound by itself.
            self._count_dropped()
            return
        self._queue.append(row)

    def _count_dropped(self) -> None:
        self.dropped += 1
        if self.dropped % DROP_LOG_EVERY == 1:
            if self._outage_since is not None:
                down = f"TensorCost unreachable for {self._now() - self._outage_since:.0f}s"
            else:
                down = "pushes aren't keeping up with calls"
            log.error(
                "tensorcost: spend queue full (%d rows waiting; %s); dropping the oldest rows, "
                "%d dropped so far. Those calls are missing from TensorCost's spend, budgets and FOCUS export.",
                self.max_queue,
                down,
                self.dropped,
            )

    def _backing_off(self) -> bool:
        return self._failures > 0 and self._now() < self._retry_at

    def _release_held(self, everything: bool = False) -> None:
        """Failure rows whose call has finished (or waited long enough) go, one of them with the correlation id."""
        now = time.monotonic()
        for corr in list(self._held):
            first, rows = self._held[corr]
            record = calls.get(corr)
            if not everything and record is not None and not record.final_failed and now - first < self.hold_failure_seconds:
                continue
            del self._held[corr]
            if record is not None and record.correlation_sent:
                for r in rows:
                    self._enqueue(_without_correlation(r))
                continue
            if record is not None:
                record.correlation_sent = True
            for r in rows[:-1]:
                self._enqueue(_without_correlation(r))
            self._enqueue(rows[-1])

    async def _flush_later(self) -> None:
        """The logger's clock: a flush every interval, or when a backoff ends, while anything is waiting."""
        while self._queue or self._held:
            wait = self.flush_interval_seconds
            if self._failures > 0:
                wait = max(0.0, self._retry_at - self._now())
                if self._held:
                    wait = min(wait, self.flush_interval_seconds)
            await asyncio.sleep(wait)
            await self._flush_quietly()

    async def _flush_quietly(self) -> None:
        # A background flush must never end the task with an exception nobody reads.
        try:
            await self.flush()
        except Exception as err:  # pragma: no cover - a bug, not an outage
            log.error("tensorcost: spend flush failed: %s: %s", type(err).__name__, err)

    async def flush(self, everything: bool = False) -> None:
        """Push what is queued, a batch at a time, and any held rows whose call is done.

        While a backoff runs this pushes nothing: the timer comes back when it ends.
        """
        if self._flushing is None:
            self._flushing = asyncio.Lock()
        async with self._flushing:
            self._release_held(everything)
            while self._queue and not self._backing_off():
                n = min(self.batch_size, len(self._queue))
                self._in_flight = [self._queue.popleft() for _ in range(n)]
                try:
                    outcome = await self._push(self._in_flight)
                except BaseException:
                    # Cancelled (the loop is shutting down) or a bug: the rows
                    # go back, and the exit hook still has them.
                    batch, self._in_flight = self._in_flight, []
                    self._queue.extendleft(reversed(batch))
                    raise
                batch, self._in_flight = self._in_flight, []
                if outcome == _RETRY:
                    # Back at the front, in order, with the same request ids.
                    self._queue.extendleft(reversed(batch))
                    return

    def flush_at_exit(self) -> None:
        """Send what is left, once, synchronously and within a few seconds: the event loop may be gone by now."""
        self._release_held(everything=True)
        # A batch in flight when the loop stopped may or may not have landed; dedupe makes a resend safe.
        rows = self._in_flight + list(self._queue)
        self._in_flight, self._queue = [], deque()
        if not rows:
            return
        if not self.api_base or not self.api_key:
            log.error("tensorcost: TENSORCOST_URL or TENSORCOST_GATEWAY_KEY isn't set; %d spend rows not sent at exit", len(rows))
            return
        url = f"{self.api_base}/v1/gateway/logs?format=litellm"
        deadline = time.monotonic() + EXIT_DEADLINE_SECONDS
        sent = 0
        why = ""
        try:
            with httpx.Client(timeout=EXIT_PUSH_TIMEOUT_SECONDS) as client:
                for i in range(0, len(rows), self.batch_size):
                    left = deadline - time.monotonic()
                    if left <= 0:
                        why = f"out of time after {EXIT_DEADLINE_SECONDS:.0f}s"
                        break
                    batch = rows[i : i + self.batch_size]
                    res = client.post(url, json=batch, headers=auth_headers(self.api_key), timeout=min(EXIT_PUSH_TIMEOUT_SECONDS, left))
                    if res.status_code >= 300:
                        # Down or refusing: the next batch would get the same answer.
                        why = f"TensorCost answered {res.status_code}"
                        break
                    sent += len(batch)
        except Exception as err:
            why = type(err).__name__
        if sent < len(rows):
            log.error(
                "tensorcost: %d of %d spend rows not sent at exit (%s); those calls are missing from TensorCost",
                len(rows) - sent,
                len(rows),
                why,
            )

    async def _push(self, batch: List[Dict[str, Any]]) -> str:
        """One attempt. Settles the batch as sent, refused (dropped, logged once) or to retry (backoff set)."""
        if not self.api_base or not self.api_key:
            log.error("tensorcost: TENSORCOST_URL or TENSORCOST_GATEWAY_KEY isn't set; %d spend rows dropped", len(batch))
            return _REFUSED
        url = f"{self.api_base}/v1/gateway/logs?format=litellm"
        retry_after: Optional[float] = None
        try:
            res = await self._http().post(url, json=batch, headers=auth_headers(self.api_key), timeout=PUSH_TIMEOUT_SECONDS)
        except httpx.HTTPError as err:
            # Connect refused, timeouts, a dropped connection: TensorCost is unreachable.
            why = type(err).__name__
        except Exception as err:
            # Not the network. Retrying the same rows would fail the same way.
            log.error("tensorcost: couldn't send %d spend rows (%s: %s); dropped", len(batch), type(err).__name__, err)
            self.refused += len(batch)
            return _REFUSED
        else:
            if res.status_code < 300:
                self._recovered()
                return _SENT
            if res.status_code < 500 and res.status_code not in (408, 429):
                self._refusal(res, len(batch))
                return _REFUSED
            why = f"TensorCost answered {res.status_code}"
            retry_after = _retry_after_seconds(res.headers.get("retry-after"))
        self._failed(why, len(batch), retry_after)
        return _RETRY

    def _failed(self, why: str, n: int, retry_after: Optional[float]) -> None:
        now = self._now()
        self._failures += 1
        if self._outage_since is None:
            self._outage_since = now
        delay = backoff_delay(self._failures, self.retry_delay_seconds, self.retry_max_delay_seconds)
        if retry_after is not None:
            delay = min(max(delay, retry_after), self.retry_max_delay_seconds)
        self._retry_at = now + delay
        if self._failures == 1 or now - self._last_retry_log >= RETRY_LOG_EVERY_SECONDS:
            self._last_retry_log = now
            log.warning(
                "tensorcost: spend push failed (%s); %d rows kept, %d queued in all; try %d, next in %.1fs, failing for %.0fs",
                why,
                n,
                len(self._queue) + n,
                self._failures,
                delay,
                now - self._outage_since,
            )

    def _recovered(self) -> None:
        if self._failures == 0:
            return
        log.warning(
            "tensorcost: spend push delivered after %d failed tries over %.0fs; %d rows still queued, sending now",
            self._failures,
            self._now() - (self._outage_since or self._now()),
            len(self._queue),
        )
        self._failures = 0
        self._outage_since = None
        self._retry_at = 0.0

    def _refusal(self, res: httpx.Response, n: int) -> None:
        # TensorCost refused the batch itself; sending it again won't change that.
        self.refused += n
        hint = {
            401: "check TENSORCOST_GATEWAY_KEY: TensorCost doesn't know this key",
            403: "check TENSORCOST_GATEWAY_KEY: the key's connection may not push logs",
            413: "the batch is larger than TensorCost takes",
        }.get(res.status_code, "TensorCost couldn't read the batch")
        try:
            body = res.text[:REFUSAL_BODY_CHARS]
        except Exception:  # pragma: no cover
            body = ""
        log.error("tensorcost: spend push refused (%d, %s); %d rows dropped. TensorCost said: %s", res.status_code, hint, n, body or "(nothing)")

    def _http(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        if self._client is None or self._client_loop is not loop:
            self._client = httpx.AsyncClient()
            self._client_loop = loop
        return self._client


@atexit.register
def _flush_all_at_exit() -> None:
    for lg in list(_live_loggers):
        lg.flush_at_exit()


def backoff_delay(failures: int, base: float, cap: float) -> float:
    """The wait after the n-th failed push in a row: base doubled per failure, capped, jittered to 50–100%.

    The same shape as TensorCost's Python SDK, so many proxies coming back
    from one outage don't all push in the same second.
    """
    capped = min(cap, base * (2 ** min(max(failures, 1) - 1, 30)))
    return capped * (0.5 + random.random() * 0.5)


def _retry_after_seconds(value: Optional[str]) -> Optional[float]:
    """A Retry-After given in seconds. A date, or anything else, is ignored."""
    try:
        seconds = float(value) if value else None
    except ValueError:
        return None
    return seconds if seconds is not None and seconds >= 0 else None


# ------------------------------------------------------------ the row shape


def spend_row(kwargs: dict, response_obj: Any, start_time: Any, end_time: Any, failed: bool) -> Optional[Dict[str, Any]]:
    """The spend-log row for one logged event, or None when LiteLLM gave no logging payload."""
    slp = kwargs.get("standard_logging_object")
    if not isinstance(slp, dict):
        return None
    md = slp.get("metadata") if isinstance(slp.get("metadata"), dict) else {}
    cache_hit = slp.get("cache_hit") is True

    metadata: Dict[str, Any] = {}
    for field in _CALLER_FIELDS:
        value = text(md.get(field))
        if value:
            metadata[field] = value
    status = "failure" if failed else (text(slp.get("status"), 20) or "success")
    metadata["status"] = status
    error = _error_information(slp.get("error_information"))
    if error:
        metadata["error_information"] = error
    correlation_id = _correlation_id(kwargs)
    if correlation_id:
        metadata[CORRELATION_METADATA_KEY] = correlation_id
    # The end customer the caller named: the row counts toward its limits.
    customer = request_customer(kwargs.get("litellm_params")) or request_customer({"metadata": md})
    if customer:
        metadata[CUSTOMER_METADATA_KEY] = customer
    # The application, resolved as the guardrail resolved it for admit.
    tags = slp.get("request_tags") if isinstance(slp.get("request_tags"), list) else None
    application = request_application(kwargs.get("litellm_params"), tags, slp.get("end_user"), md.get("user_api_key_alias"))
    if application:
        metadata[APPLICATION_METADATA_KEY] = application

    row: Dict[str, Any] = {
        # Minted here, once per logged event: the dedupe key no caller can set.
        "request_id": str(uuid.uuid4()),
        "model": text(slp.get("model")),
        "model_group": text(slp.get("model_group")),
        "api_base": text(slp.get("api_base"), 2000),
        "status": status,
        "call_type": text(slp.get("call_type"), 100),
        "spend": _number(slp.get("response_cost")),
        "response_cost": _number(slp.get("response_cost")),
        "prompt_tokens": non_negative_int(slp.get("prompt_tokens")),
        "completion_tokens": non_negative_int(slp.get("completion_tokens")),
        "total_tokens": non_negative_int(slp.get("total_tokens")),
        "start_time": _epoch(slp.get("startTime"), start_time),
        "end_time": _epoch(slp.get("endTime"), end_time),
        "user": metadata.get("user_api_key_user_id"),
        "end_user": text(slp.get("end_user")),
        "team_id": metadata.get("user_api_key_team_id"),
        "request_tags": [t for t in (text(x) for x in (slp.get("request_tags") or []) if isinstance(slp.get("request_tags"), list)) if t],
        "cache_hit": cache_hit,
        "metadata": metadata,
    }
    # The provider's own response id is the call's same-call key. A cache
    # hit repeats the cached answer's id, which belongs to the earlier call.
    if not cache_hit and not failed:
        provider_id = text(_get(response_obj, "id"), 500)
        if provider_id:
            row["id"] = provider_id
    usage = _usage_object(response_obj, md.get("usage_object"))
    if usage:
        row["usage_object"] = usage
    return {k: v for k, v in row.items() if v is not None}


def _without_correlation(row: Dict[str, Any]) -> Dict[str, Any]:
    md = {k: v for k, v in row["metadata"].items() if k != CORRELATION_METADATA_KEY}
    return {**row, "metadata": md}


def _correlation_id(kwargs: dict) -> Optional[str]:
    """The id the guardrail stamped on the request, if this process's guardrail minted it."""
    params = kwargs.get("litellm_params")
    if not isinstance(params, dict):
        return None
    for key in ("litellm_metadata", "metadata"):
        md = params.get(key)
        if isinstance(md, dict):
            value = text(md.get(CORRELATION_METADATA_KEY), 200)
            # A value the guardrail didn't mint here is a caller's: dropped.
            if value and calls.get(value) is not None:
                return value
    return None


def _error_information(info: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(info, dict):
        return None
    out: Dict[str, Any] = {}
    for field in _ERROR_FIELDS:
        value = info.get(field)
        if isinstance(value, (int, str)) and not isinstance(value, bool) and str(value).strip():
            out[field] = value
    message = info.get("error_message")
    # Never the message itself, which can quote the request: only a fixed
    # text for the two things TensorCost reads from it. A model LiteLLM
    # couldn't resolve ("Invalid model name passed in model=prod-chat") never
    # reached a provider, and TensorCost reads the row as LiteLLM's own
    # refusal rather than spend on a model named after the caller's alias.
    if isinstance(message, str) and _BUDGET_EXCEEDED.search(message):
        out["error_message"] = "budget exceeded"
    elif isinstance(message, str) and _INVALID_MODEL.search(message):
        out["error_message"] = "invalid model name"
    return out or None


def _usage_object(response_obj: Any, raw: Any) -> Optional[Dict[str, Any]]:
    """Cache reads and writes, from LiteLLM's usage block or the provider's own."""
    cached: Optional[int] = None
    written: Optional[int] = None
    for usage in (_get(response_obj, "usage"), raw):
        if usage is None:
            continue
        details = _get(usage, "prompt_tokens_details")
        if cached is None:
            cached = non_negative_int(_get(details, "cached_tokens")) if details is not None else None
        if cached is None:
            cached = non_negative_int(_get(usage, "cache_read_input_tokens"))
        if written is None:
            written = non_negative_int(_get(usage, "cache_creation_input_tokens"))
    out: Dict[str, Any] = {}
    if cached is not None:
        out["prompt_tokens_details"] = {"cached_tokens": cached}
    if written is not None:
        out["cache_creation_input_tokens"] = written
    return out or None


def _get(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _epoch(value: Any, fallback: Any) -> Optional[float]:
    """Seconds since the epoch, from the payload's float or the hook's datetime."""
    for v in (value, fallback):
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
        if isinstance(v, datetime):
            return v.timestamp()
    return None
