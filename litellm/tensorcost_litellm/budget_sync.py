"""Set a LiteLLM team's ``max_budget`` from a TensorCost budget's room.

The guardrail asks TensorCost before every call. A team budget pushed down
into LiteLLM as well keeps holding when TensorCost can't be reached: LiteLLM
refuses the team's calls on its own once its spend reaches ``max_budget``.

TensorCost's quota-sync job does this push for a connection whose LiteLLM
admin URL and key are stored in TensorCost. This module is the same push
for anyone who would rather keep the admin key on their side and run it
themselves.

The push:

1. ``GET /team/info?team_id=...`` reads the team's ``spend`` and current
   ``max_budget``. If the answer has neither field, this LiteLLM names them
   differently and nothing is changed: the result is ``unsupported``.
2. The new ``max_budget`` is the team's LiteLLM spend plus the room left on
   the TensorCost budget, in dollars, rounded down to the cent. Counting from
   LiteLLM's own spend means the limit holds whatever LiteLLM's budget reset
   schedule is. It is never above the team's own limit: the push only ever
   tightens. The team's own limit is the one it had before the first push.
3. On a first push, that own limit is saved (``save_original``; the CLI's
   state file) before anything is changed. An update whose answer is lost
   may still have landed, and the team's own limit would go with it. If it
   can't be saved, nothing is sent. A saved limit is never replaced; later
   pushes pass it back as ``original_max_budget``, and only a restore
   (``restore_team_budget``, ``--restore``) clears it.
4. ``POST /team/update`` with ``team_id`` and ``max_budget``. The push counts
   only when LiteLLM's answer, or a second read of the team, carries the new
   ``max_budget`` back.

Field names are from LiteLLM's ``team_endpoints.py`` (``/team/update`` takes
``UpdateTeamRequest`` with ``team_id`` and ``max_budget`` and answers
``{"team_id", "data"}``). The check in step 1 and 3 is there because they
weren't confirmed against every LiteLLM release.

Usage::

    LITELLM_URL=https://litellm.example.com LITELLM_ADMIN_KEY=sk-... \\
      python -m tensorcost_litellm.budget_sync --team-id search --room-usd 412.50

    # when the TensorCost budget no longer covers the team:
    python -m tensorcost_litellm.budget_sync --team-id search --restore

The CLI keeps each team's own limit in a JSON state file
(``--state-file``, default ``tensorcost-budget-sync.json`` in the working
directory). Keep that file: it is how a restore knows what to put back.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import asdict, dataclass
import tempfile
from typing import Any, Callable, Dict, Optional, Union

import httpx

TIMEOUT_SECONDS = 10.0


class _Unset:
    pass


#: "Not given": the team's current max_budget is taken as its own limit (a first push).
UNSET = _Unset()


@dataclass
class PushResult:
    #: pushed, failed or unsupported.
    status: str
    max_budget: Optional[float] = None
    #: The team's max_budget before this push (None: it had none).
    prior_max_budget: Optional[float] = None
    error: Optional[str] = None


def plan_max_budget(team_spend_usd: float, room_usd: float, ceiling: Optional[float] = None) -> float:
    """LiteLLM spend plus the room, rounded down to the cent; never below the spend, never above the team's own limit."""
    room = max(0.0, room_usd)
    want = math.floor((team_spend_usd + room) * 100 + 1e-6) / 100
    return want if ceiling is None else min(want, ceiling)


def push_team_budget(
    base_url: str,
    admin_key: str,
    team_id: str,
    room_usd: float,
    client: Optional[httpx.Client] = None,
    original_max_budget: Union[float, None, _Unset] = UNSET,
    save_original: Optional[Callable[[Optional[float]], None]] = None,
) -> PushResult:
    """Push the room. On a first push (no ``original_max_budget``), ``save_original``
    is called with the team's own limit before any update, and must have stored it."""
    own = client is None
    http = client or httpx.Client(timeout=TIMEOUT_SECONDS)
    try:
        return _push(http, base_url.rstrip("/"), admin_key, team_id, room_usd, original_max_budget, save_original)
    finally:
        if own:
            http.close()


def restore_team_budget(base_url: str, admin_key: str, team_id: str, original: Optional[float], client: Optional[httpx.Client] = None) -> PushResult:
    """Put the team's own limit back (None: no limit)."""
    own = client is None
    http = client or httpx.Client(timeout=TIMEOUT_SECONDS)
    try:
        return _set(http, base_url.rstrip("/"), {"authorization": f"Bearer {admin_key}", "content-type": "application/json"}, team_id, original, original)
    finally:
        if own:
            http.close()


def _push(
    http: httpx.Client,
    base: str,
    key: str,
    team_id: str,
    room_usd: float,
    original: Union[float, None, _Unset],
    save_original: Optional[Callable[[Optional[float]], None]],
) -> PushResult:
    headers = {"authorization": f"Bearer {key}", "content-type": "application/json"}
    try:
        res = http.get(f"{base}/team/info", params={"team_id": team_id}, headers=headers)
    except httpx.HTTPError as err:
        return PushResult("failed", error=f"couldn't reach LiteLLM ({type(err).__name__})")
    failed = _failure(res, team_id)
    if failed:
        return failed
    info = _json(res)
    team = info.get("team_info") if isinstance(info, dict) else None
    if not isinstance(team, dict) or "spend" not in team or "max_budget" not in team:
        return PushResult("unsupported", error="LiteLLM's /team/info answer has no team_info.spend or team_info.max_budget")
    spend = team.get("spend")
    spend = 0.0 if spend is None else spend
    prior = team.get("max_budget")
    if not _is_number(spend) or (prior is not None and not _is_number(prior)):
        return PushResult("unsupported", error="LiteLLM's team spend or max_budget isn't a number")
    prior_f = None if prior is None else float(prior)
    ceiling = prior_f if isinstance(original, _Unset) else original
    target = plan_max_budget(float(spend), room_usd, ceiling)
    if prior_f is not None and abs(prior_f - target) < 0.005:
        return PushResult("pushed", max_budget=target, prior_max_budget=prior_f)
    if isinstance(original, _Unset) and save_original is not None:
        try:
            save_original(prior_f)
        except Exception as err:
            return PushResult("failed", prior_max_budget=prior_f, error=f"couldn't save the team's own limit first, so nothing was pushed ({type(err).__name__})")
    return _set(http, base, headers, team_id, target, prior_f)


def _set(http: httpx.Client, base: str, headers: dict, team_id: str, target: Optional[float], prior_f: Optional[float]) -> PushResult:
    try:
        res = http.post(f"{base}/team/update", json={"team_id": team_id, "max_budget": target}, headers=headers)
    except httpx.HTTPError as err:
        return PushResult("failed", prior_max_budget=prior_f, error=f"couldn't reach LiteLLM ({type(err).__name__})")
    if res.status_code == 422:
        return PushResult("unsupported", prior_max_budget=prior_f, error="LiteLLM's /team/update rejected the max_budget field (422)")
    failed = _failure(res, team_id)
    if failed:
        failed.prior_max_budget = prior_f
        return failed
    body = _json(res)
    data = body.get("data") if isinstance(body, dict) else None
    echoed = data.get("max_budget") if isinstance(data, dict) else None
    if not _same(echoed, target):
        # Some releases answer without the row: read the team again before
        # saying the push didn't take.
        if _reads_back(http, base, headers, team_id, target):
            return PushResult("pushed", max_budget=target, prior_max_budget=prior_f)
        return PushResult("unsupported", prior_max_budget=prior_f, error="LiteLLM's /team/update answer didn't carry the new max_budget back")
    return PushResult("pushed", max_budget=target, prior_max_budget=prior_f)


def _reads_back(http: httpx.Client, base: str, headers: dict, team_id: str, target: Optional[float]) -> bool:
    try:
        res = http.get(f"{base}/team/info", params={"team_id": team_id}, headers=headers)
    except httpx.HTTPError:
        return False
    body = _json(res) if res.status_code < 300 else None
    team = body.get("team_info") if isinstance(body, dict) else None
    value = team.get("max_budget") if isinstance(team, dict) else None
    return isinstance(team, dict) and _same(value, target)


def _same(value: Any, target: Optional[float]) -> bool:
    if target is None:
        return value is None
    return _is_number(value) and abs(float(value) - target) < 0.005


def _failure(res: httpx.Response, team_id: str) -> Optional[PushResult]:
    if res.status_code < 300:
        return None
    if res.status_code in (401, 403):
        return PushResult("failed", error=f"LiteLLM refused the admin key ({res.status_code})")
    if res.status_code == 404:
        return PushResult("failed", error=f"LiteLLM has no team {team_id}")
    return PushResult("failed", error=f"LiteLLM answered {res.status_code}")


def _json(res: httpx.Response) -> Any:
    try:
        return res.json()
    except ValueError:
        return None


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class StateFile:
    """Each team's own limit from before the first push, by team id. Written atomically."""

    def __init__(self, path: str) -> None:
        self.path = path

    def load(self) -> Dict[str, Optional[float]]:
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return {}
        teams = data.get("teams") if isinstance(data, dict) else None
        return dict(teams) if isinstance(teams, dict) else {}

    def _write(self, teams: Dict[str, Optional[float]]) -> None:
        folder = os.path.dirname(os.path.abspath(self.path))
        fd, tmp = tempfile.mkstemp(dir=folder, prefix=".budget-sync-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"teams": teams}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def remember(self, team_id: str, original: Optional[float]) -> None:
        """Store a team's own limit; one already stored is never replaced."""
        teams = self.load()
        if team_id in teams:
            return
        teams[team_id] = original
        self._write(teams)

    def forget(self, team_id: str) -> None:
        teams = self.load()
        if teams.pop(team_id, "absent") != "absent":
            self._write(teams)


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="Set a LiteLLM team's max_budget from a TensorCost budget's room.")
    parser.add_argument("--team-id", required=True)
    parser.add_argument("--room-usd", type=float, help="What's left on the TensorCost budget, in dollars")
    parser.add_argument("--restore", action="store_true", help="Put the team's own limit back and forget it")
    parser.add_argument("--state-file", default="tensorcost-budget-sync.json", help="Where each team's own limit is kept")
    parser.add_argument(
        "--original-max-budget",
        help="The team's own max_budget (a number, or 'none'), for a team the state file doesn't have yet. Never replaces a stored one.",
    )
    args = parser.parse_args(argv)
    url = os.environ.get("LITELLM_URL")
    key = os.environ.get("LITELLM_ADMIN_KEY")
    if not url or not key:
        print("Set LITELLM_URL and LITELLM_ADMIN_KEY.", file=sys.stderr)
        return 2
    state = StateFile(args.state_file)
    stored = state.load()

    if args.restore:
        if args.team_id not in stored:
            print(f"No own limit is stored for team {args.team_id} in {args.state_file}; nothing to put back.", file=sys.stderr)
            return 1
        result = restore_team_budget(url, key, args.team_id, stored[args.team_id])
        if result.status == "pushed":
            state.forget(args.team_id)
        print(json.dumps(asdict(result)))
        return 0 if result.status == "pushed" else 1

    if args.room_usd is None:
        print("Give --room-usd, or --restore.", file=sys.stderr)
        return 2
    if args.team_id not in stored and args.original_max_budget is not None:
        given = None if args.original_max_budget.strip().lower() == "none" else float(args.original_max_budget)
        state.remember(args.team_id, given)
        stored = state.load()
    original: Union[float, None, _Unset] = stored[args.team_id] if args.team_id in stored else UNSET
    result = push_team_budget(
        url,
        key,
        args.team_id,
        args.room_usd,
        original_max_budget=original,
        save_original=lambda value: state.remember(args.team_id, value),
    )
    print(json.dumps(asdict(result)))
    return 0 if result.status == "pushed" else 1


if __name__ == "__main__":
    sys.exit(main())
