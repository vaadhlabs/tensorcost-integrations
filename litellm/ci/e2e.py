"""Drives a real LiteLLM proxy loaded with the snippet's config.

Checks that the guardrail and the logger load and do their jobs against
ci/stub_tensorcost.py:

- an allowed call answers 200, and the guardrail sent its check with the
  model_list names, max_tokens and a correlation id it stamped;
- a call TensorCost refuses answers 429 with the refusal's message;
- the logger pushes a spend row for the allowed call, with a request_id of
  its own and the call's correlation id.

    python ci/e2e.py http://localhost:4000 http://localhost:8787
"""

from __future__ import annotations

import sys
import time

import httpx

MASTER_KEY = "sk-ci-master"


def wait_for(url: str, seconds: float = 120) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if httpx.get(url, timeout=2).status_code < 500:
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)
    raise SystemExit(f"{url} didn't come up")


def chat(proxy: str, max_tokens: int) -> httpx.Response:
    return httpx.post(
        f"{proxy}/chat/completions",
        headers={"authorization": f"Bearer {MASTER_KEY}"},
        json={"model": "mock-model", "max_tokens": max_tokens, "messages": [{"role": "user", "content": "hi"}]},
        timeout=30,
    )


def main(proxy: str, stub: str) -> None:
    wait_for(f"{proxy}/health/liveliness")

    allowed = chat(proxy, 16)
    assert allowed.status_code == 200, f"allowed call answered {allowed.status_code}: {allowed.text[:500]}"

    refused = chat(proxy, 999)
    assert refused.status_code == 429, f"refused call answered {refused.status_code}: {refused.text[:500]}"
    assert "reached its monthly AI budget" in refused.text, refused.text[:500]
    print("Retry-After on the refusal:", refused.headers.get("retry-after"))

    seen = httpx.get(f"{stub}/seen", timeout=5).json()
    admits = seen["admits"]
    assert len(admits) >= 2, f"expected two admit checks, got {len(admits)}"
    first = admits[0]
    assert "mock-model" in first.get("accepts_models", []), first
    assert first.get("max_tokens") == 16, first
    assert first.get("correlation_id"), first

    deadline = time.monotonic() + 30
    rows = []
    while time.monotonic() < deadline:
        rows = [r for r in httpx.get(f"{stub}/seen", timeout=5).json()["logs"] if r.get("status") == "success"]
        if rows:
            break
        time.sleep(1)
    assert rows, "the logger pushed no spend row for the allowed call within 30 s"
    row = rows[0]
    assert row.get("request_id") and row.get("start_time"), row
    assert row["metadata"].get("tensorcost_correlation_id") == first["correlation_id"], row
    print(f"ok: {len(admits)} checks, {len(rows)} spend rows")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
