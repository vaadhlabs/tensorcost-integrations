from __future__ import annotations

import pytest

import json
import time

import httpx

from tensorcost_litellm.budget_sync import StateFile, main, plan_max_budget, push_team_budget, restore_team_budget


def team_info(spend=120.0, max_budget=None, **extra):
    info = {"team_id": "search", "spend": spend, "max_budget": max_budget}
    info.update(extra)
    return lambda req: (200, {"team_id": "search", "team_info": info, "keys": [], "team_memberships": []}, {})


def echo_update(req):
    return 200, {"team_id": req["body"]["team_id"], "data": {"team_id": req["body"]["team_id"], "max_budget": req["body"]["max_budget"]}}, {}


def test_the_limit_is_litellms_spend_plus_the_room_rounded_down():
    assert plan_max_budget(120.0, 380.129) == 500.12
    assert plan_max_budget(120.0, -5) == 120.0
    assert plan_max_budget(0.1, 0.2) == 0.3


def test_a_push_sets_max_budget_and_confirms_it(server):
    server.on("/team/info", team_info(spend=120.0, max_budget=900.0))
    server.on("/team/update", echo_update)
    result = push_team_budget(server.url, "sk-admin", "search", 380.0)
    assert result.status == "pushed"
    assert result.max_budget == 500.0
    assert result.prior_max_budget == 900.0
    [info] = server.hits("/team/info")
    assert info["query"] == "/team/info?team_id=search"
    assert info["headers"]["authorization"] == "Bearer sk-admin"
    [update] = server.hits("/team/update")
    assert update["body"] == {"team_id": "search", "max_budget": 500.0}


def test_a_limit_already_in_place_sends_no_update(server):
    server.on("/team/info", team_info(spend=120.0, max_budget=500.0))
    result = push_team_budget(server.url, "sk-admin", "search", 380.0)
    assert result.status == "pushed"
    assert server.hits("/team/update") == []


def test_a_team_info_without_the_fields_is_unsupported_and_changes_nothing(server):
    server.on("/team/info", lambda req: (200, {"team_id": "search", "team_info": {"team_id": "search", "budget": 1}}, {}))
    result = push_team_budget(server.url, "sk-admin", "search", 10.0)
    assert result.status == "unsupported"
    assert "team_info.spend" in result.error
    assert server.hits("/team/update") == []


def test_the_push_never_loosens_the_teams_own_limit(server):
    server.on("/team/info", team_info(spend=20.0, max_budget=50.0))
    server.on("/team/update", echo_update)
    result = push_team_budget(server.url, "sk-admin", "search", 1000.0)
    # spend + room would be 1,020; the team's own 50 stays.
    assert (result.status, result.max_budget, result.prior_max_budget) == ("pushed", 50.0, 50.0)
    assert server.hits("/team/update") == []


def test_a_later_push_takes_the_original_limit_not_the_one_it_set(server):
    server.on("/team/info", team_info(spend=20.0, max_budget=30.0))  # 30 is an earlier push's
    server.on("/team/update", echo_update)
    assert push_team_budget(server.url, "sk-admin", "search", 40.0, original_max_budget=500.0).max_budget == 60.0
    assert push_team_budget(server.url, "sk-admin", "search", 1000.0, original_max_budget=500.0).max_budget == 500.0
    assert push_team_budget(server.url, "sk-admin", "search", 1000.0, original_max_budget=None).max_budget == 1020.0


def test_an_update_without_the_echo_counts_when_the_team_reads_back_the_value(server):
    reads = iter([(20.0, None), (20.0, 30.0)])

    def info(req):
        spend, mb = next(reads)
        return team_info(spend=spend, max_budget=mb)(req)

    server.on("/team/info", info)
    server.on("/team/update", lambda req: (200, {"team_id": "search", "data": {"team_id": "search"}}, {}))
    assert push_team_budget(server.url, "sk-admin", "search", 10.0).status == "pushed"


def test_an_update_that_doesnt_echo_max_budget_is_unsupported(server):
    server.on("/team/info", team_info())
    server.on("/team/update", lambda req: (200, {"team_id": "search", "data": {"team_id": "search"}}, {}))
    result = push_team_budget(server.url, "sk-admin", "search", 10.0)
    assert result.status == "unsupported"
    assert "max_budget" in result.error


def test_a_422_on_update_is_unsupported(server):
    server.on("/team/info", team_info())
    server.on("/team/update", lambda req: (422, {"detail": [{"loc": ["body", "max_budget"]}]}, {}))
    assert push_team_budget(server.url, "sk-admin", "search", 10.0).status == "unsupported"


@pytest.mark.parametrize("status,needle", [(401, "admin key"), (403, "admin key"), (404, "no team"), (500, "answered 500")])
def test_errors_are_failed_with_a_reason_and_no_body(server, status, needle):
    server.on("/team/info", lambda req: (status, {"error": "secret detail"}, {}))
    result = push_team_budget(server.url, "sk-admin", "search", 10.0)
    assert result.status == "failed"
    assert needle in result.error
    assert "secret detail" not in result.error


def test_an_unreachable_litellm_is_failed():
    result = push_team_budget("http://127.0.0.1:9", "sk-admin", "search", 10.0)
    assert result.status == "failed"


def test_the_cli_needs_the_url_and_key(monkeypatch, capsys):
    monkeypatch.delenv("LITELLM_URL", raising=False)
    monkeypatch.delenv("LITELLM_ADMIN_KEY", raising=False)
    assert main(["--team-id", "search", "--room-usd", "1"]) == 2


def test_the_cli_prints_the_result(server, monkeypatch, capsys, tmp_path):
    monkeypatch.chdir(tmp_path)  # the default state file lands here
    server.on("/team/info", team_info(spend=0.0))
    server.on("/team/update", echo_update)
    monkeypatch.setenv("LITELLM_URL", server.url)
    monkeypatch.setenv("LITELLM_ADMIN_KEY", "sk-admin")
    assert main(["--team-id", "search", "--room-usd", "25"]) == 0
    assert '"status": "pushed"' in capsys.readouterr().out


# ---------------------------------------------- the own limit is saved first (round 2, R1)


def lossy_litellm(server, spend=10.0, max_budget=50.0):
    """A LiteLLM team whose next update lands and then answers too late for the client."""
    team = {"spend": spend, "max_budget": max_budget, "slow": False}

    def info(req):
        return 200, {"team_id": "search", "team_info": {"team_id": "search", "spend": team["spend"], "max_budget": team["max_budget"]}}, {}

    def update(req):
        team["max_budget"] = req["body"]["max_budget"]
        if team["slow"]:
            team["slow"] = False
            time.sleep(1.0)
        return echo_update(req)

    server.on("/team/info", info)
    server.on("/team/update", update)
    return team


def test_the_reviewers_case_through_the_cli_state_file(server, monkeypatch, tmp_path):
    team = lossy_litellm(server)
    monkeypatch.setenv("LITELLM_URL", server.url)
    monkeypatch.setenv("LITELLM_ADMIN_KEY", "sk-admin")
    monkeypatch.setattr("tensorcost_litellm.budget_sync.TIMEOUT_SECONDS", 0.3)
    state = str(tmp_path / "state.json")

    team["slow"] = True
    assert main(["--team-id", "search", "--room-usd", "10", "--state-file", state]) == 1  # the answer was lost
    assert team["max_budget"] == 20.0
    assert json.load(open(state)) == {"teams": {"search": 50.0}}

    assert main(["--team-id", "search", "--room-usd", "10", "--state-file", state]) == 0
    # The stored own limit survived; a later read of TensorCost's 20 didn't replace it.
    assert json.load(open(state)) == {"teams": {"search": 50.0}}

    assert main(["--team-id", "search", "--restore", "--state-file", state]) == 0
    assert team["max_budget"] == 50.0
    assert json.load(open(state)) == {"teams": {}}


def test_nothing_is_sent_when_the_own_limit_cant_be_saved(server):
    team = lossy_litellm(server)

    def broken(value):
        raise OSError("disk full")

    result = push_team_budget(server.url, "sk-admin", "search", 10.0, save_original=broken)
    assert result.status == "failed" and "nothing was pushed" in result.error
    assert server.hits("/team/update") == []
    assert team["max_budget"] == 50.0


def test_a_stored_own_limit_is_never_replaced(tmp_path):
    state = StateFile(str(tmp_path / "s.json"))
    state.remember("search", 50.0)
    state.remember("search", 20.0)
    assert state.load() == {"search": 50.0}
    state.forget("search")
    state.remember("search", None)
    assert state.load() == {"search": None}


def test_restore_puts_no_limit_back_as_none(server):
    server.on("/team/update", echo_update)
    assert restore_team_budget(server.url, "sk-admin", "search", None).status == "pushed"
    assert server.hits("/team/update")[0]["body"] == {"team_id": "search", "max_budget": None}

