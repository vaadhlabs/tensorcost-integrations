"""The admit protocol's client conformance cases, run against the guardrail.

The cases are ``admit-conformance/cases.json`` and the server is
``@tensorcost/admit-mock``, both beside this package in the integrations
repository. The mock is started with Node and checks every admit request the
guardrail sends against the protocol's OpenAPI file. This runner follows
``admit-conformance/lib/runner.mjs``, which says what each step means.

Skipped when ``node`` isn't on the PATH or the two folders aren't there (an
sdist of this package on its own).
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from fastapi import HTTPException

from tensorcost_litellm import TensorCostAdmit
from tensorcost_litellm.guardrail import model_info_from_list

ROOT = Path(__file__).resolve().parents[2]
MOCK_BIN = ROOT / "admit-mock" / "bin" / "admit-mock.mjs"
CASES_FILE = ROOT / "admit-conformance" / "cases.json"
NODE = shutil.which("node")

#: What this client can do, in the cases' terms: LiteLLM rewrites the model, and cancels a hold.
CAPABILITIES = {"reroute", "cancel"}
KEY = "tcgw_conformance"

pytestmark = pytest.mark.skipif(
    NODE is None or not MOCK_BIN.exists() or not CASES_FILE.exists(),
    reason="needs node, and admit-mock/ and admit-conformance/ beside litellm/",
)

CASES: Dict[str, Any] = json.loads(CASES_FILE.read_text()) if CASES_FILE.exists() else {"cases": [], "client": {}}


class ProviderError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__(f"status {status_code}")
        self.status_code = status_code


class Timeout(Exception):
    """Named as LiteLLM's own timeout class, which the guardrail never treats as proof."""

    status_code = 408


class Key:
    def __init__(self, team_id: str) -> None:
        self.team_id = team_id
        self.user_id = None
        self.key_alias = None


@pytest.fixture(scope="module")
def mock_url():
    proc = subprocess.Popen([NODE, str(MOCK_BIN), "--port", "0"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline().strip()
        if not line.startswith("admit-mock listening on "):
            raise RuntimeError(f"admit-mock didn't start: {line} {proc.stderr.read() if proc.poll() is not None else ''}")
        yield line.rsplit(" ", 1)[1]
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def _mock(url: str, path: str, body: Optional[dict] = None) -> Dict[str, Any]:
    req = urllib.request.Request(
        f"{url}{path}",
        data=None if body is None else json.dumps(body).encode(),
        method="GET" if body is None else "POST",
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read())


def _guard(url: str, fail_mode: str) -> TensorCostAdmit:
    defaults = CASES["client"]
    model_list = [{"model_name": m, "litellm_params": {"model": f"anthropic/{m}"}} for m in defaults["models"]]
    return TensorCostAdmit(
        guardrail_name="tensorcost",
        event_hook="pre_call",
        default_on=True,
        api_base=url,
        api_key=KEY,
        fail_mode=fail_mode,
        timeout_seconds=defaults["timeout_ms"] / 1000,
        model_info=lambda: model_info_from_list(model_list),
        token_counter=lambda model, messages: 42,
    )


async def _run_case(url: str, case: Dict[str, Any]) -> List[str]:
    defaults = CASES["client"]
    problems: List[str] = []
    _mock(url, "/_mock/reset", {"fail_mode": case.get("workspace_fail_mode", case["client"]["fail_mode"])})
    g = _guard(url, case["client"]["fail_mode"])
    last_data: Optional[dict] = None
    last_key: Optional[Key] = None
    last_decision: Optional[str] = None

    for i, step in enumerate(case["steps"], 1):
        where = f"step {i}"
        if "wait_ms" in step:
            await asyncio.sleep(step["wait_ms"] / 1000)
            continue
        before = _mock(url, "/_mock/log")
        if "call" in step:
            want = step["expect"]
            key = Key(step["call"])
            data = {"model": defaults["model"], "messages": [{"role": "user", "content": "hi"}], "max_tokens": defaults["max_tokens"]}
            try:
                await g.async_pre_call_hook(key, None, data, "completion")
                outcome, message = "sent", None
            except HTTPException as err:
                outcome = "blocked"
                detail = err.detail if isinstance(err.detail, dict) else {}
                message = (detail.get("error") or {}).get("message")
            log = _mock(url, "/_mock/log")
            asked = len(log["admits"]) - len(before["admits"])
            if outcome != want["outcome"]:
                problems.append(f"{where} ({step['call']}): the call was {outcome}, wants {want['outcome']}")
            if want.get("model") and outcome == "sent" and data["model"] != want["model"]:
                problems.append(f"{where} ({step['call']}): sent as {data['model']}, wants {want['model']}")
            if want.get("admit") == "asked" and asked == 0:
                problems.append(f"{where} ({step['call']}): admit was not asked")
            if want.get("admit") == "not_asked" and asked:
                problems.append(f"{where} ({step['call']}): admit was asked")
            if asked > 1:
                problems.append(f"{where} ({step['call']}): admit was asked {asked} times for one call")
            if want.get("message_contains") and want["message_contains"] not in (message or ""):
                problems.append(f"{where} ({step['call']}): the refusal shown doesn't carry TensorCost's message")
            if asked:
                last_decision = (log["admits"][-1].get("answer") or {}).get("decision_id")
            elif outcome == "sent":
                last_decision = None
            if outcome == "sent":
                last_data, last_key = data, key
        elif "fail" in step:
            assert last_data is not None and last_key is not None, f"{case['id']} {where}: a fail step needs a sent call before it"
            exc: Exception = Timeout() if step["fail"].get("timeout") else ProviderError(step["fail"]["status"])
            await g.async_post_call_failure_hook(last_data, exc, last_key)
            await asyncio.gather(*list(g._background))
            log = _mock(url, "/_mock/log")
            fresh = log["cancels"][len(before["cancels"]):]
            what = "a timeout" if step["fail"].get("timeout") else f"a {step['fail']['status']}"
            if step["expect"]["cancel"] == "sent":
                if len(fresh) != 1:
                    problems.append(f"{where}: after {what} the client sent {len(fresh)} cancels, wants 1")
                elif last_decision and fresh[0]["decision_id"] != last_decision:
                    problems.append(f"{where}: the cancel names another decision")
                elif fresh[0]["cancelled"] is not True:
                    problems.append(f"{where}: the cancel did not drop the call's hold")
            elif fresh:
                problems.append(f"{where}: after {what} the client cancelled the call's hold")

    log = _mock(url, "/_mock/log")
    if not log.get("spec"):
        problems.append("the mock found no OpenAPI file to check requests against")
    after = case.get("after") or {}
    if "admits" in after and len(log["admits"]) != after["admits"]:
        problems.append(f"admit was asked {len(log['admits'])} times, wants {after['admits']}")
    if "cancels" in after and len(log["cancels"]) != after["cancels"]:
        problems.append(f"{len(log['cancels'])} cancels, wants {after['cancels']}")
    for n, a in enumerate(log["admits"], 1):
        problems.extend(f"admit request {n} doesn't match the OpenAPI file: {e}" for e in a.get("request_errors") or [])
        problems.extend(f"the mock's answer {n} doesn't match the OpenAPI file: {e}" for e in a.get("response_errors") or [])
    return problems


@pytest.mark.parametrize("case", CASES["cases"], ids=[c["id"] for c in CASES["cases"]])
def test_conformance_case(mock_url, case):
    missing = set(case.get("needs") or []) - CAPABILITIES
    if missing:
        pytest.skip(f"LiteLLM can rewrite the model, so this case is for clients that can't ({', '.join(sorted(missing))})")
    problems = asyncio.run(_run_case(mock_url, case))
    assert problems == [], "\n".join(problems)


def test_every_case_but_the_no_reroute_one_applies_to_litellm():
    skipped = [c["id"] for c in CASES["cases"] if set(c.get("needs") or []) - CAPABILITIES]
    assert skipped == ["a-client-that-cannot-reroute-opts-out"]
