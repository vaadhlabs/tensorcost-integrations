"""Settings, the call registry and the HTTP helpers both hooks share."""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

#: The request-metadata key the guardrail stamps with the call's correlation id.
#: TensorCost's log parser reads it from each row's metadata.
CORRELATION_METADATA_KEY = "tensorcost_correlation_id"

#: The request-metadata key a caller names the end customer under, the LiteLLM
#: side of the SDK's x-tc-customer. The guardrail sends it to admit and the
#: logger copies it into each row's metadata, where TensorCost's parser reads it.
CUSTOMER_METADATA_KEY = "tensorcost_customer"

#: The longest customer id TensorCost keeps; a longer one is left off.
MAX_CUSTOMER = 128

#: The header an SDK or proxied call names its application with, passed
#: through LiteLLM by a caller who sets it.
APPLICATION_HEADER = "x-tc-application"
#: The request-metadata key a caller names the application under, the
#: LiteLLM side of x-tc-application. The logger copies the resolved value
#: into each row's metadata under this key, where TensorCost's parser reads it.
APPLICATION_METADATA_KEY = "tensorcost_application"
#: The longest application name the gateway admit API accepts.
MAX_APPLICATION = 256

#: The plugin's version, which every request to TensorCost names in its User-Agent.
VERSION = "0.1.5"
USER_AGENT = f"TensorCost-LiteLLM/{VERSION}"

URL_ENV = "TENSORCOST_URL"
KEY_ENV = "TENSORCOST_GATEWAY_KEY"

_ENV_PREFIX = "os.environ/"


def resolve_setting(value: Optional[str], env_name: str) -> Optional[str]:
    """A config value, an ``os.environ/NAME`` reference, or the default env var."""
    if isinstance(value, str) and value.startswith(_ENV_PREFIX):
        value = os.environ.get(value[len(_ENV_PREFIX):])
    if not value:
        value = os.environ.get(env_name)
    if isinstance(value, str):
        value = value.strip()
    return value or None


def base_url(value: Optional[str]) -> Optional[str]:
    url = resolve_setting(value, URL_ENV)
    return url.rstrip("/") if url else None


@dataclass
class CallRecord:
    """What the guardrail knows about one call, for the logger and the cancel."""

    correlation_id: str
    #: The admit decision this call ran under. None when a cached allow let
    #: it through: that decision belongs to another call and is never cancelled.
    decision_id: Optional[str]
    created: float
    #: id() of the request dict the guardrail admitted. The failure hook acts
    #: only for that same dict, so a caller who puts another call's
    #: correlation id in their own request's metadata can't reach its record.
    request_ref: Optional[int] = None
    #: The proxy reported the request's final failure (the failure hook ran).
    final_failed: bool = False
    #: A row carrying this correlation id has been queued. Only one row per
    #: call ever carries it, so admit's estimate is booked at most once.
    correlation_sent: bool = False


class CallRegistry:
    """Calls the guardrail admitted, by the correlation id it minted, for 30 minutes.

    Never keyed by LiteLLM's call id: a client sets that with the
    x-litellm-call-id header. Bounded, so a burst can't grow it without limit.
    """

    def __init__(self, ttl_seconds: float = 1800.0, max_entries: int = 50_000) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._items: Dict[str, CallRecord] = {}
        self._lock = threading.Lock()

    def put(self, record: CallRecord) -> None:
        call_id = record.correlation_id
        with self._lock:
            if len(self._items) >= self._max:
                self._evict(time.monotonic())
                while len(self._items) >= self._max:
                    self._items.pop(next(iter(self._items)))
            self._items[call_id] = record

    def get(self, call_id: Optional[str]) -> Optional[CallRecord]:
        if not call_id:
            return None
        with self._lock:
            record = self._items.get(call_id)
            if record is None:
                return None
            if time.monotonic() - record.created > self._ttl:
                self._items.pop(call_id, None)
                return None
            return record

    def _evict(self, now: float) -> None:
        stale = [k for k, r in self._items.items() if now - r.created > self._ttl]
        for k in stale:
            self._items.pop(k, None)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


#: One registry per process: the guardrail writes it, the logger reads it.
calls = CallRegistry()


def stamped_correlation_id(container: Any) -> Optional[str]:
    """The correlation id the guardrail stamped on a request's metadata (never requester_metadata)."""
    if not isinstance(container, dict):
        return None
    for key in ("litellm_metadata", "metadata"):
        md = container.get(key)
        if isinstance(md, dict):
            value = text(md.get(CORRELATION_METADATA_KEY), 200)
            if value:
                return value
    return None


def request_customer(container: Any) -> Optional[str]:
    """The end customer a caller named in the request's metadata, or None.

    Read from ``metadata`` or ``litellm_metadata`` and, failing those, from the
    caller's own copy LiteLLM keeps under ``requester_metadata``. Trimmed, at
    most 128 characters and with no control characters, as TensorCost keeps it.
    """
    if not isinstance(container, dict):
        return None
    found: Optional[Any] = None
    for key in ("litellm_metadata", "metadata"):
        md = container.get(key)
        if not isinstance(md, dict):
            continue
        for source in (md, md.get("requester_metadata")):
            if isinstance(source, dict) and source.get(CUSTOMER_METADATA_KEY) is not None:
                found = source.get(CUSTOMER_METADATA_KEY)
                break
        if found is not None:
            break
    value = text(found, MAX_CUSTOMER)
    if value is None or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return None
    return value


def request_application(
    container: Any,
    tags: Optional[List[Any]] = None,
    end_user: Any = None,
    key_alias: Any = None,
) -> Optional[str]:
    """The application a call is for, the same way at admit and on its spend row.

    First of: the x-tc-application header the caller sent through LiteLLM;
    ``tensorcost_application`` in the request's metadata (or the caller's own
    copy under ``requester_metadata``); an ``application=`` or ``app=`` tag
    (``:`` works too); LiteLLM's end user (the body's ``user``); the key's
    alias. The last three are the order TensorCost's parser already used for a
    row's application, so a row from an older logger reads the same.
    ``container`` is the request dict at admit, ``litellm_params`` at log time.
    """
    for value in (_header(container, APPLICATION_HEADER), _metadata_value(container, APPLICATION_METADATA_KEY)):
        found = _label(value, MAX_APPLICATION)
        if found:
            return found
    for key in ("application", "app"):
        for tag in tags or []:
            if not isinstance(tag, str):
                continue
            lower = tag.strip().lower()
            for sep in ("=", ":"):
                if lower.startswith(key + sep):
                    found = _label(tag.strip()[len(key) + 1 :], MAX_APPLICATION)
                    if found:
                        return found
    for value in (end_user, key_alias):
        found = _label(value, MAX_APPLICATION)
        if found:
            return found
    return None


def _header(container: Any, name: str) -> Any:
    """A request header LiteLLM kept, by name in any case (proxy_server_request, then metadata)."""
    if not isinstance(container, dict):
        return None
    sources = [(container.get("proxy_server_request") or {}).get("headers") if isinstance(container.get("proxy_server_request"), dict) else None]
    for key in ("litellm_metadata", "metadata"):
        md = container.get(key)
        if isinstance(md, dict):
            sources.append(md.get("headers"))
    for headers in sources:
        if isinstance(headers, dict):
            for k, v in headers.items():
                if isinstance(k, str) and k.lower() == name:
                    return v
    return None


def _metadata_value(container: Any, name: str) -> Any:
    if not isinstance(container, dict):
        return None
    for key in ("litellm_metadata", "metadata"):
        md = container.get(key)
        if not isinstance(md, dict):
            continue
        for source in (md, md.get("requester_metadata")):
            if isinstance(source, dict) and source.get(name) is not None:
                return source.get(name)
    return None


def _label(value: Any, limit: int) -> Optional[str]:
    """text(), and nothing with a control character in it."""
    found = text(value, limit)
    if found is None or any(ord(ch) < 32 or ord(ch) == 127 for ch in found):
        return None
    return found


def auth_headers(key: str) -> Dict[str, str]:
    # The plugin's own User-Agent rather than httpx's: TensorCost's edge can
    # tell its traffic apart, and a request never arrives without one.
    return {"authorization": f"Bearer {key}", "content-type": "application/json", "accept": "application/json", "user-agent": USER_AGENT}


def text(value: Any, limit: int = 256) -> Optional[str]:
    """A trimmed non-empty string no longer than ``limit``, else None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > limit:
        return None
    return value


def non_negative_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float) and value.is_integer() and value >= 0:
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def base_model(litellm_params: Any, model_info: Any = None) -> Optional[str]:
    """The model a deployment bills as, when its config names one (``base_model``).

    Azure deployments carry names of the customer's own ("prod-mini-deploy"),
    so LiteLLM's Azure docs ask for ``base_model`` ("azure/gpt-4o-mini") to
    price them. Read as LiteLLM 1.108.9 reads it for cost
    (litellm.utils.get_base_model_from_metadata): ``litellm_params.base_model``
    first, then the deployment's ``model_info.base_model``. Pass the call's
    ``model_info`` (from a model_list entry); without one, the call's own
    ``litellm_params.metadata`` and ``litellm_metadata`` are searched for it,
    where LiteLLM's router puts the deployment's model_info on each call.
    """
    found = text(_get_field(litellm_params, "base_model"))
    if found:
        return found
    infos = [model_info] if model_info is not None else [
        _get_field(_get_field(litellm_params, key), "model_info") for key in ("metadata", "litellm_metadata")
    ]
    for info in infos:
        found = text(_get_field(info, "base_model"))
        if found:
            return found
    return None


def without_provider_prefix(model: str, provider: Optional[str]) -> str:
    """LiteLLM's routing prefix taken off: "azure/gpt-4o-mini" under azure is "gpt-4o-mini"."""
    if provider and model.lower().startswith(provider.lower() + "/"):
        return model[len(provider) + 1 :] or model
    return model


def _get_field(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None) if obj is not None else None
