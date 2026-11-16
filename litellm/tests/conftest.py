"""Test fixtures: LiteLLM stand-ins when LiteLLM isn't installed, and a stub TensorCost.

The plugin imports two LiteLLM base classes. When the real ``litellm`` package
is installed the tests use it; otherwise they register minimal stand-ins with
the same constructor and hook names, so the plugin's own logic is tested
without LiteLLM. CI runs them against the real package (see the workflow).
"""

from __future__ import annotations

import json
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest

try:  # pragma: no cover - depends on the machine
    import litellm.integrations.custom_guardrail  # noqa: F401
    import litellm.integrations.custom_logger  # noqa: F401

    REAL_LITELLM = True
except Exception:  # pragma: no cover
    REAL_LITELLM = False

    class CustomLogger:  # the hook names LiteLLM's CustomLogger has
        def __init__(self, **kwargs: Any) -> None:
            self.init_kwargs = kwargs

        async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
            pass

        async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
            pass

        async def async_post_call_failure_hook(self, request_data, original_exception, user_api_key_dict, traceback_str=None):
            pass

    class CustomGuardrail(CustomLogger):
        def __init__(self, guardrail_name=None, supported_event_hooks=None, event_hook=None, default_on=False, **kwargs: Any) -> None:
            self.guardrail_name = guardrail_name
            self.event_hook = event_hook
            self.default_on = default_on
            super().__init__(**kwargs)

    litellm_mod = types.ModuleType("litellm")
    integrations = types.ModuleType("litellm.integrations")
    guard_mod = types.ModuleType("litellm.integrations.custom_guardrail")
    logger_mod = types.ModuleType("litellm.integrations.custom_logger")
    guard_mod.CustomGuardrail = CustomGuardrail
    logger_mod.CustomLogger = CustomLogger
    litellm_mod.integrations = integrations
    integrations.custom_guardrail = guard_mod
    integrations.custom_logger = logger_mod
    sys.modules.update(
        {
            "litellm": litellm_mod,
            "litellm.integrations": integrations,
            "litellm.integrations.custom_guardrail": guard_mod,
            "litellm.integrations.custom_logger": logger_mod,
        }
    )


Handler = Callable[[Dict[str, Any]], Tuple[int, Any, Dict[str, str]]]


class StubServer:
    """A real HTTP server on 127.0.0.1 that records requests and answers per path."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.routes: Dict[str, Handler] = {}
        self.delay: Dict[str, float] = {}
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _serve(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = raw.decode("latin1")
                path = self.path.split("?", 1)[0]
                req = {"method": self.command, "path": path, "query": self.path, "headers": dict(self.headers), "body": body}
                stub.requests.append(req)
                wait = stub.delay.get(path)
                if wait:
                    time.sleep(wait)
                handler = stub.match(path)
                status, payload, headers = handler(req) if handler else (404, {"message": "no route"}, {})
                data = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
                try:
                    self.send_response(status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(data)))
                    for k, v in headers.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = _serve
            do_POST = _serve

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def match(self, path: str) -> Optional[Handler]:
        if path in self.routes:
            return self.routes[path]
        for prefix, handler in self.routes.items():
            if prefix.endswith("*") and path.startswith(prefix[:-1]):
                return handler
        return None

    def on(self, path: str, handler: Handler) -> None:
        self.routes[path] = handler

    def hits(self, path_prefix: str) -> List[Dict[str, Any]]:
        return [r for r in self.requests if r["path"].startswith(path_prefix)]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def server():
    s = StubServer()
    yield s
    s.close()


@pytest.fixture(autouse=True)
def fresh_registry():
    from tensorcost_litellm._shared import calls

    from tensorcost_litellm import logger as logger_mod

    calls.clear()
    yield
    calls.clear()
    # Test loggers point at servers that are gone by exit; their leftovers aren't sent.
    for lg in list(logger_mod._live_loggers):
        logger_mod._live_loggers.discard(lg)
