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
and a failure's error class and code, and the end customer the caller named
under ``tensorcost_customer`` in the request's metadata. It never carries the
prompt, the response, the request parameters or the rest of the caller's own
metadata.

A batch holds at most 500 rows. A push that fails with a 5xx, a 429 or a
dropped connection is sent once more. A batch that fails twice is dropped
and logged. Rows still queued when the proxy exits are sent once, with a
short timeout, from an exit hook.
"""

from __future__ import annotations

import asyncio
import atexit
import logging
import re
import time
import uuid
import weakref
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx
from litellm.integrations.custom_logger import CustomLogger

from ._shared import (
    CORRELATION_METADATA_KEY,
    CUSTOMER_METADATA_KEY,
    KEY_ENV,
    auth_headers,
    base_url,
    calls,
    non_negative_int,
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
RETRY_DELAY_SECONDS = 0.5
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
#: The one thing the parser reads from an error message: that a budget was exceeded.
_BUDGET_EXCEEDED = re.compile(r"budget (?:has been )?exceeded|exceeded (?:its |the )?budget", re.I)

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
        hold_failure_seconds: float = HOLD_FAILURE_SECONDS,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._api_base_setting = api_base
        self._api_key_setting = api_key
        self.batch_size = max(1, min(int(batch_size), BATCH_MAX))
        self.flush_interval_seconds = float(flush_interval_seconds)
        self.max_queue = int(max_queue)
        self.retry_delay_seconds = float(retry_delay_seconds)
        self.hold_failure_seconds = float(hold_failure_seconds)
        self._queue: List[Dict[str, Any]] = []
        #: Failure rows waiting for their call to finish, by correlation id: (first seen, rows).
        self._held: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
        self._timer: Optional[asyncio.Task] = None
        self._flushing: Optional[asyncio.Lock] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._client_loop: Optional[asyncio.AbstractEventLoop] = None
        self.dropped = 0
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
        if len(self._queue) >= self.batch_size:
            await self.flush()
        elif (self._queue or self._held) and (self._timer is None or self._timer.done()):
            self._timer = asyncio.ensure_future(self._flush_later())

    def _enqueue(self, row: Dict[str, Any]) -> None:
        if len(self._queue) >= self.max_queue:
            self.dropped += 1
            if self.dropped % 1000 == 1:
                log.warning("tensorcost: spend queue full, %d rows dropped so far", self.dropped)
            return
        self._queue.append(row)

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
        await asyncio.sleep(self.flush_interval_seconds)
        await self.flush()
        if self._queue or self._held:
            self._timer = asyncio.ensure_future(self._flush_later())

    async def flush(self, everything: bool = False) -> None:
        """Push everything queued, a batch at a time, and any held rows whose call is done."""
        if self._flushing is None:
            self._flushing = asyncio.Lock()
        async with self._flushing:
            self._release_held(everything)
            while self._queue:
                batch = self._queue[: self.batch_size]
                del self._queue[: self.batch_size]
                await self._push(batch)

    def flush_at_exit(self) -> None:
        """Send what is left, once, synchronously: the event loop may be gone by now."""
        self._release_held(everything=True)
        if not self._queue or not self.api_base or not self.api_key:
            return
        url = f"{self.api_base}/v1/gateway/logs?format=litellm"
        rows, self._queue = self._queue, []
        try:
            with httpx.Client(timeout=EXIT_PUSH_TIMEOUT_SECONDS) as client:
                for i in range(0, len(rows), self.batch_size):
                    client.post(url, json=rows[i : i + self.batch_size], headers=auth_headers(self.api_key))
        except Exception as err:
            log.warning("tensorcost: couldn't send all of %d spend rows at exit: %s", len(rows), type(err).__name__)

    async def _push(self, batch: List[Dict[str, Any]]) -> None:
        if not self.api_base or not self.api_key:
            log.warning("tensorcost: TENSORCOST_URL or TENSORCOST_GATEWAY_KEY isn't set; %d spend rows not sent", len(batch))
            return
        url = f"{self.api_base}/v1/gateway/logs?format=litellm"
        for attempt in (1, 2):
            try:
                res = await self._http().post(url, json=batch, headers=auth_headers(self.api_key), timeout=PUSH_TIMEOUT_SECONDS)
            except httpx.HTTPError as err:
                why = type(err).__name__
            else:
                if res.status_code < 300:
                    return
                if res.status_code < 500 and res.status_code != 429:
                    # TensorCost refused the batch itself; sending it again won't change that.
                    log.warning("tensorcost: spend push refused (%d); %d rows dropped", res.status_code, len(batch))
                    return
                why = f"TensorCost answered {res.status_code}"
            if attempt == 1:
                await asyncio.sleep(self.retry_delay_seconds)
        log.warning("tensorcost: spend push failed twice (%s); %d rows dropped", why, len(batch))

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
    # Never the message itself, which can quote the request: only that a
    # budget was exceeded, the one thing TensorCost reads from it.
    if isinstance(message, str) and _BUDGET_EXCEEDED.search(message):
        out["error_message"] = "budget exceeded"
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
