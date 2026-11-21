"""TensorCostAdmit: a LiteLLM pre-call guardrail that asks TensorCost first.

Before each call the proxy runs ``async_pre_call_hook``. It sends the call's
callers, model and size to TensorCost's ``POST /v1/gateway/admit`` and does
what the answer says:

- ``allow``: the request goes on unchanged, apart from the correlation id
  stamped in its metadata.
- ``refuse``: the hook raises a 429 carrying TensorCost's message (which names
  the budget and who can raise it) and ``Retry-After``.
- ``reroute``: the hook sets ``data["model"]`` to the model TensorCost names.

Every answered decision is an HTTP 200. Anything else (a timeout, a non-2xx,
a body that isn't a decision) means TensorCost failed, and the fail mode
decides: open lets the call through, closed refuses it with a 503. The mode
starts as configured and follows the last one TensorCost reported, unless an
answer says it couldn't read the workspace's setting.

After a call fails, ``async_post_call_failure_hook`` cancels the call's hold
on the budget, but only when the failure proves the provider can't have
billed the call. Anything else keeps the hold until the call's spend lands
or five minutes pass.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import httpx
from fastapi import HTTPException
from litellm.integrations.custom_guardrail import CustomGuardrail

from ._shared import (
    CORRELATION_METADATA_KEY,
    KEY_ENV,
    CallRecord,
    auth_headers,
    base_url,
    calls,
    non_negative_int,
    request_customer,
    resolve_setting,
    stamped_correlation_id,
    text,
)

log = logging.getLogger("tensorcost_litellm")

#: The generated snippets give the admit round trip one second.
DEFAULT_TIMEOUT_SECONDS = 1.0
#: The contract's caps on list fields; TensorCost keeps the first entries of a longer list.
MAX_CALLERS = 32
MAX_MODELS = 32
MAX_TAGS = 32

#: Statuses that refuse a call before any model work, at every provider.
NEVER_BILLED_STATUSES = frozenset({401, 403, 404, 429})

#: Refusals waiting won't change, answered 403 rather than 429.
POLICY_REFUSAL_REASONS = frozenset({"model_governance_denied", "compliance_denied", "run_stopped"})
#: How long the prompt's token count may take before the check goes without it.
TOKEN_COUNT_BUDGET_SECONDS = 0.25
#: Refusal reasons that mean TensorCost couldn't check, not that a budget is spent.
CHECK_FAILED_REASONS = frozenset({"check_unavailable", "invalid_request"})

#: LiteLLM's error classes whose status LiteLLM made up rather than the provider sent.
LITELLM_OWN_STATUS_CLASSES = frozenset({"Timeout", "APIConnectionError", "MidStreamFallbackError"})

ModelInfo = Tuple[List[str], Dict[str, Tuple[Optional[str], Optional[str]]]]


class TensorCostUnavailable(Exception):
    """TensorCost didn't give a decision: the fail mode decides."""


class TensorCostAdmit(CustomGuardrail):
    def __init__(
        self,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
        fail_mode: str = "open",
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        instance: Optional[str] = None,
        count_input_tokens: bool = True,
        model_info: Optional[Callable[[], ModelInfo]] = None,
        token_counter: Optional[Callable[..., int]] = None,
        **kwargs: Any,
    ) -> None:
        # LiteLLM passes every litellm_params entry of the guardrail's config
        # here. Ours are taken out; the rest (guardrail_name, event_hook,
        # default_on and anything newer) go to CustomGuardrail.
        super().__init__(**kwargs)
        self.api_base = base_url(api_base)
        self.api_key = resolve_setting(api_key, KEY_ENV)
        mode = (fail_mode or "open").strip().lower()
        if mode not in ("open", "closed"):
            raise ValueError("fail_mode must be open or closed")
        self.configured_fail_mode = mode
        #: The mode TensorCost last reported for the workspace, when it knew it.
        self.seen_fail_mode: Optional[str] = None
        self.timeout_seconds = float(timeout_seconds)
        self.instance = text(instance, 200)
        self.count_input_tokens = bool(count_input_tokens)
        self._model_info = model_info or _proxy_model_info
        self._token_counter = token_counter
        self._allow_cache: Dict[Tuple[Any, ...], float] = {}
        self._client: Optional[httpx.AsyncClient] = None
        self._client_loop: Optional[asyncio.AbstractEventLoop] = None
        self._background: set = set()
        self._throttle_logged_until = 0.0

    # ------------------------------------------------------------------ hooks

    async def async_pre_call_hook(self, user_api_key_dict: Any, cache: Any, data: dict, call_type: Any) -> dict:
        model = text(data.get("model"))
        if model is None:
            return data
        callers, tags = _callers(user_api_key_dict, data)
        correlation_id = str(uuid.uuid4())
        _stamp_correlation(data, correlation_id)

        names, deployments = self._models()
        asked_model, provider = deployments.get(model, (None, None))
        if provider is None and "/" in model:
            # A wildcard route ("bedrock/*"): the name is the provider's own.
            provider = model.split("/", 1)[0]
        body: Dict[str, Any] = {
            "gateway": {"kind": "litellm", "instance": self.instance},
            "callers": callers,
            "model": asked_model or model,
            "correlation_id": correlation_id,
        }
        if provider:
            body["provider"] = provider
        if names:
            body["accepts_models"] = names[:MAX_MODELS]
        if tags:
            body["tags"] = tags[:MAX_TAGS]
        # The end customer (metadata tensorcost_customer): judged against its
        # margin floors and fixed limits, and stored on the call's spend row.
        customer = request_customer(data)
        if customer:
            body["customer"] = customer
        max_tokens = _max_tokens(data)
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        input_tokens = await self._input_tokens(data, asked_model or model)
        if input_tokens:
            body["input_tokens"] = input_tokens
        if isinstance(data.get("stream"), bool):
            body["stream"] = data["stream"]

        # Keyed by callers, model and customer, as TensorCost's TTL is, and by
        # the call's size: an allow for a small call never covers a larger one,
        # and one customer's allow never covers another's.
        cache_key = (tuple((c["kind"], c["id"]) for c in callers), model, customer, max_tokens, input_tokens)
        if self._cached(cache_key):
            # A cached allow: the call runs on another call's decision, so it
            # has none of its own to cancel.
            calls.put(CallRecord(correlation_id, None, time.monotonic(), id(data)))
            return data

        try:
            answer = await self._admit(body)
        except TensorCostUnavailable as err:
            return self._unavailable(data, str(err))

        decision = answer["decision"]
        detail = answer.get("detail")
        if isinstance(detail, str) and "throttled" in detail:
            self._note_throttled(answer)
        if decision == "refuse":
            raise _refusal(answer)
        calls.put(CallRecord(correlation_id, text(answer.get("decision_id"), 100), time.monotonic(), id(data)))
        if decision == "reroute":
            target = text(answer.get("model"))
            if target:
                data["model"] = target
            return data
        if _cacheable(answer):
            self._allow_cache[cache_key] = time.monotonic() + float(answer["cache_ttl_seconds"])
        return data

    async def async_post_call_failure_hook(self, request_data: dict, original_exception: Exception, user_api_key_dict: Any, traceback_str: Optional[str] = None) -> None:
        """Cancel the call's hold when the failure proves the call was never billed.

        The call is found by the correlation id this guardrail stamped on the
        request, and only when the failing request is the very dict it
        admitted: never by LiteLLM's call id, which a client sets.
        """
        record = calls.get(stamped_correlation_id(request_data))
        if record is None or record.request_ref != id(request_data):
            return
        record.final_failed = True
        if record.decision_id is None:
            return
        if not provably_never_billed(original_exception) or _attempted_elsewhere(request_data):
            return
        task = asyncio.ensure_future(self._cancel(record.decision_id))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    # -------------------------------------------------------------- internals

    def _note_throttled(self, answer: Dict[str, Any]) -> None:
        """Once a minute: this gateway is past its admit rate, and TensorCost answered by the fail mode."""
        now = time.monotonic()
        if now < self._throttle_logged_until:
            return
        self._throttle_logged_until = now + 60.0
        log.warning(
            "tensorcost: this gateway is past its TensorCost admit rate; calls are being %s without a budget check. "
            "A TensorCost admin can raise the connection's rate on Connect > Gateways.",
            "allowed" if answer.get("decision") == "allow" else "refused",
        )

    @property
    def fail_mode(self) -> str:
        return self.seen_fail_mode or self.configured_fail_mode

    def _cached(self, key: Tuple[Any, ...]) -> bool:
        until = self._allow_cache.get(key)
        if until is None:
            return False
        if time.monotonic() < until:
            return True
        self._allow_cache.pop(key, None)
        return False

    def _models(self) -> ModelInfo:
        try:
            return self._model_info()
        except Exception:  # the proxy's router isn't there or changed shape
            return [], {}

    async def _input_tokens(self, data: dict, model: str) -> Optional[int]:
        given = non_negative_int(data.get("input_tokens"))
        if given is not None:
            return given
        if not self.count_input_tokens:
            return None
        messages = data.get("messages")
        if not isinstance(messages, list) or not messages:
            return None
        counter = self._token_counter or _litellm_token_counter()
        if counter is None:
            return None
        # Off the event loop, and only for so long: a long prompt's count
        # mustn't hold up every other call the proxy is serving.
        try:
            count = await asyncio.wait_for(asyncio.to_thread(counter, model=model, messages=messages), TOKEN_COUNT_BUDGET_SECONDS)
        except Exception:
            return None
        return non_negative_int(count)

    def _http(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        if self._client is None or self._client_loop is not loop:
            self._client = httpx.AsyncClient()
            self._client_loop = loop
        return self._client

    async def _admit(self, body: Dict[str, Any]) -> Dict[str, Any]:
        if not self.api_base or not self.api_key:
            raise TensorCostUnavailable("TENSORCOST_URL or TENSORCOST_GATEWAY_KEY isn't set")
        url = f"{self.api_base}/v1/gateway/admit"
        try:
            # One attempt, never a resend: a second admit would hold the
            # call's reservation twice.
            res = await asyncio.wait_for(
                self._http().post(url, json=body, headers=auth_headers(self.api_key), timeout=self.timeout_seconds),
                timeout=self.timeout_seconds,
            )
        except asyncio.TimeoutError:
            raise TensorCostUnavailable("no answer within the timeout")
        except httpx.HTTPError as err:
            raise TensorCostUnavailable(f"couldn't reach TensorCost ({type(err).__name__})")
        if res.status_code == 429:
            # A known connection past its rate gets a 200; a 429 means TensorCost doesn't know this key yet.
            raise TensorCostUnavailable("TensorCost throttled this key as unknown (429): check TENSORCOST_GATEWAY_KEY")
        if res.status_code != 200:
            raise TensorCostUnavailable(f"TensorCost answered {res.status_code}")
        try:
            answer = res.json()
        except ValueError:
            raise TensorCostUnavailable("TensorCost's answer wasn't JSON")
        if not isinstance(answer, dict) or answer.get("decision") not in ("allow", "refuse", "reroute"):
            raise TensorCostUnavailable("TensorCost's answer had no decision")
        self._learn_fail_mode(res.headers.get("x-tc-fail-mode"), answer)
        return answer

    def _learn_fail_mode(self, header: Optional[str], answer: Dict[str, Any]) -> None:
        # An answer decided without the workspace's setting says so; its
        # fail_mode is the default, not the workspace's, and is never kept.
        if answer.get("fail_mode_known") is False:
            return
        raw = header if isinstance(header, str) and header.strip() else answer.get("fail_mode")
        mode = raw.strip().lower() if isinstance(raw, str) else ""
        if mode in ("open", "closed"):
            self.seen_fail_mode = mode

    def _unavailable(self, data: dict, why: str) -> dict:
        if self.fail_mode == "open":
            log.warning("tensorcost: admit check failed, letting the call through (fail mode open): %s", why)
            return data
        log.warning("tensorcost: admit check failed, refusing the call (fail mode closed): %s", why)
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "type": "budget_check_unavailable",
                    "message": "TensorCost couldn't check this call's budget, and this workspace refuses calls it can't check. Try again shortly.",
                }
            },
        )

    async def _cancel(self, decision_id: str) -> None:
        if not self.api_base or not self.api_key:
            return
        url = f"{self.api_base}/v1/gateway/admit/{decision_id}/cancel"
        # The cancel is idempotent, so one more try after a 5xx or a dropped
        # connection is safe. If both fail the hold expires on its own.
        for attempt in (1, 2):
            try:
                res = await self._http().post(url, headers=auth_headers(self.api_key), timeout=2.0)
                if res.status_code < 500:
                    return
            except httpx.HTTPError:
                pass
            if attempt == 1:
                await asyncio.sleep(0.2)
        log.info("tensorcost: couldn't cancel hold %s; it expires on its own", decision_id)


# ---------------------------------------------------------------- helpers


def provably_never_billed(exc: BaseException) -> bool:
    """True only when the failure shows the provider can't have billed the call.

    A 401, 403, 404 or 429 refuses a call before any model work at every
    provider, and LiteLLM's own budget refusal comes before it calls anyone.
    A timeout, a 5xx, a 400 (Azure bills a content-filtered prompt), a
    connection that broke, or a status LiteLLM made up is not proof. Nor is
    a final error after the router retried: an earlier attempt may have run.
    """
    name = type(exc).__name__
    if name == "BudgetExceededError":
        return True
    if name in LITELLM_OWN_STATUS_CLASSES:
        return False
    retried = getattr(exc, "num_retries", None)
    if isinstance(retried, int) and not isinstance(retried, bool) and retried > 0:
        return False
    status = _status_of(exc)
    return status in NEVER_BILLED_STATUSES


def _status_of(exc: BaseException) -> Optional[int]:
    for attr in ("status_code", "code"):
        value = getattr(exc, attr, None)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
    return None


def _cacheable(answer: Dict[str, Any]) -> bool:
    """An allow TensorCost marks cacheable that placed no hold.

    TensorCost sends 0 for an allow that held anything; the hook also never
    reuses one that reserved anything, as a second line. A degraded allow, or
    one decided without the workspace's fail mode, is never reused.
    """
    ttl = answer.get("cache_ttl_seconds")
    reserved = answer.get("reservation_cents")
    if not isinstance(ttl, (int, float)) or isinstance(ttl, bool) or ttl <= 0:
        return False
    if not isinstance(reserved, (int, float)) or isinstance(reserved, bool) or reserved != 0:
        return False
    return not answer.get("degraded") and answer.get("fail_mode_known") is not False


def _attempted_elsewhere(request_data: dict) -> bool:
    """LiteLLM's router says it retried or fell back: an earlier attempt may have run."""
    for container in (request_data, request_data.get("metadata"), request_data.get("litellm_metadata")):
        if not isinstance(container, dict):
            continue
        if container.get("previous_models"):
            return True
        depth = container.get("fallback_depth")
        if isinstance(depth, int) and not isinstance(depth, bool) and depth > 0:
            return True
    return False


def _refusal(answer: Dict[str, Any]) -> HTTPException:
    reason = text(answer.get("reason"), 100)
    if reason in CHECK_FAILED_REASONS:
        # Closed fail mode or a model TensorCost can't read: not a spent
        # budget, so not a 429 a client would back off on as a quota.
        return HTTPException(
            status_code=503,
            detail={
                "error": {
                    "type": "budget_check_unavailable",
                    "reason": reason,
                    "message": text(answer.get("message"), 2000)
                    or "TensorCost couldn't check this call's budget, and this workspace refuses calls it can't check.",
                }
            },
        )
    message = text(answer.get("message"), 2000) or (
        f"TensorCost refused this call ({reason})." if reason else "TensorCost refused this call."
    )
    if reason in POLICY_REFUSAL_REASONS:
        # A model the workspace doesn't allow, a compliance rule, a stopped
        # run: no amount of waiting lets it through, so not a 429 a client
        # would back off on and retry.
        policy: Dict[str, Any] = {"type": "permission_denied", "reason": reason, "message": message}
        decision = text(answer.get("decision_id"), 100)
        if decision:
            policy["decision_id"] = decision
        return HTTPException(status_code=403, detail={"error": policy})
    error: Dict[str, Any] = {"type": "budget_exceeded", "message": message}
    if reason:
        error["reason"] = reason
    decision_id = text(answer.get("decision_id"), 100)
    if decision_id:
        error["decision_id"] = decision_id
    headers: Dict[str, str] = {}
    retry_after = non_negative_int(answer.get("retry_after_seconds"))
    if retry_after is not None:
        error["retry_after_seconds"] = retry_after
        headers["Retry-After"] = str(retry_after)
    return HTTPException(status_code=429, detail={"error": error}, headers=headers or None)


def _get(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _callers(user_api_key_dict: Any, data: dict) -> Tuple[List[Dict[str, str]], List[str]]:
    callers: List[Dict[str, str]] = []
    for kind, attr in (("team", "team_id"), ("user", "user_id"), ("key", "key_alias")):
        value = text(_get(user_api_key_dict, attr))
        if value:
            callers.append({"kind": kind, "id": value})
    tags = _tags(data)
    for tag in tags:
        if len(callers) >= MAX_CALLERS:
            break
        callers.append({"kind": "tag", "id": tag})
    return callers, tags


def _tags(data: dict) -> List[str]:
    found: List[str] = []
    for md in _metadata_dicts(data):
        for source in (md.get("tags"), (md.get("requester_metadata") or {}).get("tags") if isinstance(md.get("requester_metadata"), dict) else None):
            if isinstance(source, list):
                for t in source:
                    tag = text(t)
                    if tag and tag not in found:
                        found.append(tag)
    return found


def _metadata_dicts(data: dict) -> Iterable[dict]:
    for key in ("metadata", "litellm_metadata"):
        md = data.get(key)
        if isinstance(md, dict):
            yield md


def _stamp_correlation(data: dict, correlation_id: str) -> None:
    """Put our correlation id in the call's metadata, over anything a caller sent.

    LiteLLM keeps its own metadata under ``litellm_metadata`` on routes where
    ``metadata`` is the provider's field (Anthropic's /v1/messages), so the id
    goes there when that key exists. The caller's own copy of their metadata
    (``requester_metadata``) loses any value they put under our key.
    """
    target = data.get("litellm_metadata") if isinstance(data.get("litellm_metadata"), dict) else None
    if target is None:
        md = data.get("metadata")
        if not isinstance(md, dict):
            md = {}
            data["metadata"] = md
        target = md
    target[CORRELATION_METADATA_KEY] = correlation_id
    for md in _metadata_dicts(data):
        if md is not target:
            md.pop(CORRELATION_METADATA_KEY, None)
        requester = md.get("requester_metadata")
        if isinstance(requester, dict):
            requester.pop(CORRELATION_METADATA_KEY, None)


def _max_tokens(data: dict) -> Optional[int]:
    for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"):
        value = non_negative_int(data.get(key))
        if value is not None:
            return value
    return None


def _proxy_model_info() -> ModelInfo:
    """The proxy's model_list: names a reroute may pick, and each name's model and provider."""
    from litellm.proxy.proxy_server import llm_router  # imported late: only inside a running proxy

    if llm_router is None:
        return [], {}
    model_list: Sequence[Any] = getattr(llm_router, "model_list", None) or []
    return model_info_from_list(model_list)


def model_info_from_list(model_list: Sequence[Any]) -> ModelInfo:
    names: List[str] = []
    deployments: Dict[str, Tuple[Optional[str], Optional[str]]] = {}
    for entry in model_list:
        name = text(_get(entry, "model_name"))
        if not name:
            continue
        if name not in names:
            names.append(name)
        params = _get(entry, "litellm_params") or {}
        model = text(_get(params, "model"))
        provider = text(_get(params, "custom_llm_provider"))
        if model and not provider and "/" in model:
            provider = model.split("/", 1)[0]
        # litellm_params.model carries LiteLLM's routing prefix
        # ("openai/gpt-4.1-mini"); TensorCost wants the provider's own model
        # id beside the provider. Sent with the prefix, governance looked up
        # "openai/openai/gpt-4.1-mini" and refused every approved model.
        if model and provider and model.lower().startswith(provider.lower() + "/"):
            model = model[len(provider) + 1 :] or model
        # The first deployment of a name speaks for it.
        deployments.setdefault(name, (model, provider))
    return names, deployments


def _litellm_token_counter() -> Optional[Callable[..., int]]:
    try:
        import litellm

        return getattr(litellm, "token_counter", None)
    except Exception:
        return None
