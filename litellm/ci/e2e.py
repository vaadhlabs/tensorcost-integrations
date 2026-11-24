"""Drives a real LiteLLM proxy loaded with the snippet's config.

Checks that the guardrail and the logger load and do their jobs against
ci/stub_tensorcost.py:

- an allowed call answers 200, and the guardrail sent its check with the
  model_list names, max_tokens and a correlation id it stamped;
- a call TensorCost refuses answers 429 with the refusal's message;
- the logger pushes a spend row for the allowed call, with a request_id of
  its own and the call's correlation id;
- a rerouted call runs on the alias TensorCost names, and its spend row
  names the alias's model, which is what confirms the reroute;
- a deployment with a base_model goes to admit, and onto its spend row, as
  the base model, with the deployment's own name beside it.

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


def chat(proxy: str, max_tokens: int, model: str = "mock-model") -> httpx.Response:
    return httpx.post(
        f"{proxy}/chat/completions",
        headers={"authorization": f"Bearer {MASTER_KEY}"},
        json={"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": "hi"}]},
        timeout=30,
    )


def main(proxy: str, stub: str) -> None:
    wait_for(f"{proxy}/health/liveliness")

    allowed = chat(proxy, 16)
    assert allowed.status_code == 200, f"allowed call answered {allowed.status_code}: {allowed.text[:500]}"

    rerouted = chat(proxy, 777)
    assert rerouted.status_code == 200, f"rerouted call answered {rerouted.status_code}: {rerouted.text[:500]}"
    assert "rerouted model" in rerouted.text, rerouted.text[:500]

    named = chat(proxy, 16, model="ci-named")
    assert named.status_code == 200, f"named-deployment call answered {named.status_code}: {named.text[:500]}"

    refused = chat(proxy, 999)
    assert refused.status_code == 429, f"refused call answered {refused.status_code}: {refused.text[:500]}"
    assert "reached its monthly AI budget" in refused.text, refused.text[:500]
    print("Retry-After on the refusal:", refused.headers.get("retry-after"))

    seen = httpx.get(f"{stub}/seen", timeout=5).json()
    admits = seen["admits"]
    assert len(admits) >= 4, f"expected four admit checks, got {len(admits)}"
    first = admits[0]
    assert "mock-model" in first.get("accepts_models", []), first
    assert {"name": "ci-mini", "model": "gpt-4o-mini-2024-07-18", "provider": "openai"} in first["accepts_models"], first
    reroute_correlation = admits[1]["correlation_id"]
    named_admit = admits[2]
    assert (named_admit["model"], named_admit.get("deployment")) == ("gpt-4o-mini", "ci-named-deploy"), named_admit
    assert first.get("max_tokens") == 16, first
    assert first.get("correlation_id"), first

    deadline = time.monotonic() + 30
    rows = []
    while time.monotonic() < deadline:
        rows = [r for r in httpx.get(f"{stub}/seen", timeout=5).json()["logs"] if r.get("status") == "success"]
        # The rerouted call's row may land first: wait for the allowed call's own.
        if any(r["metadata"].get("tensorcost_correlation_id") == first["correlation_id"] for r in rows):
            break
        time.sleep(1)
    row = next((r for r in rows if r["metadata"].get("tensorcost_correlation_id") == first["correlation_id"]), None)
    assert row, "the logger pushed no spend row for the allowed call within 30 s"
    assert row.get("request_id") and row.get("start_time"), row

    deadline = time.monotonic() + 30
    moved = []
    while time.monotonic() < deadline:
        moved = [r for r in httpx.get(f"{stub}/seen", timeout=5).json()["logs"] if r["metadata"].get("tensorcost_correlation_id") == reroute_correlation]
        if moved:
            break
        time.sleep(1)
    assert moved, "the logger pushed no spend row for the rerouted call within 30 s"
    # TensorCost reads row.model first: the deployment's model, not the alias.
    assert "gpt-4o-mini-2024-07-18" in (moved[0].get("model") or ""), moved[0]
    assert moved[0].get("model_group") == "ci-mini", moved[0]

    deadline = time.monotonic() + 30
    named_rows = []
    while time.monotonic() < deadline:
        named_rows = [r for r in httpx.get(f"{stub}/seen", timeout=5).json()["logs"] if r["metadata"].get("tensorcost_correlation_id") == named_admit["correlation_id"]]
        if named_rows:
            break
        time.sleep(1)
    assert named_rows, "the logger pushed no spend row for the named-deployment call within 30 s"
    # LiteLLM's router hands the deployment's model_info to the callback: the row bills as the base model.
    assert named_rows[0].get("model") == "openai/gpt-4o-mini", named_rows[0]
    # The deployment's own name, without LiteLLM's provider prefix, as admit got it.
    assert named_rows[0].get("deployment") == "ci-named-deploy", named_rows[0]
    print(f"ok: {len(admits)} checks, {len(rows)} spend rows, the reroute ran as {moved[0]['model']}, the named deployment as {named_rows[0]['model']}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
