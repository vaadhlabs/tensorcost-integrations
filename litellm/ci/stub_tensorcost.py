"""A stand-in TensorCost for the end-to-end job.

POST /v1/gateway/admit allows every call except one whose max_tokens is 999,
which it refuses the way TensorCost refuses a budget. POST /v1/gateway/logs
takes the logger's rows. GET /seen answers everything it was sent, for the
driver to check.

    python ci/stub_tensorcost.py 8787
"""

from __future__ import annotations

import json
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REFUSE_MAX_TOKENS = 999
REFUSAL_MESSAGE = "TensorCost: CI team has reached its monthly AI budget ($10). Ask a TensorCost admin to raise it."

seen = {"admits": [], "logs": [], "cancels": []}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _answer(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/seen":
            with lock:
                return self._answer(200, seen)
        return self._answer(404, {})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"null")
        if self.headers.get("authorization") != "Bearer tcgw_ci_key":
            return self._answer(401, {"message": "not a gateway key"})
        path = self.path.split("?", 1)[0]
        if path == "/v1/gateway/admit":
            with lock:
                seen["admits"].append(body)
            base = {
                "decision_id": str(uuid.uuid4()),
                "reservation_cents": 1.0,
                "reservation_basis": "max_tokens",
                "reservation_kind": "estimated",
                "attribution": {"team": None, "developer": None, "unmapped": []},
                "fail_mode": "open",
                "cache_ttl_seconds": 0,
            }
            if body.get("max_tokens") == REFUSE_MAX_TOKENS:
                return self._answer(
                    200,
                    {**base, "decision": "refuse", "reason": "budget_hard_cap", "message": REFUSAL_MESSAGE, "retry_after_seconds": 3600},
                    {"x-tc-fail-mode": "open"},
                )
            return self._answer(200, {**base, "decision": "allow", "reason": None, "message": None}, {"x-tc-fail-mode": "open"})
        if path == "/v1/gateway/logs":
            rows = body if isinstance(body, list) else (body or {}).get("logs", [])
            with lock:
                seen["logs"].extend(rows)
            return self._answer(200, {"received": len(rows), "inserted": len(rows), "deduped": 0, "skipped": 0, "parse_errors": []})
        if path.startswith("/v1/gateway/admit/") and path.endswith("/cancel"):
            with lock:
                seen["cancels"].append(path)
            return self._answer(200, {"decision_id": path.split("/")[4], "cancelled": True})
        return self._answer(404, {})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
