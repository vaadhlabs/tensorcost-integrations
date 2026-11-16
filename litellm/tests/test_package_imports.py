"""budget_sync is a standalone CLI: it must import and run with only httpx,
outside the LiteLLM proxy's environment (no fastapi, no litellm)."""

import os
import subprocess
import sys
import textwrap

import pytest

from conftest import REAL_LITELLM

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BLOCK_PROXY_DEPS = textwrap.dedent(
    """
    import importlib.abc, sys

    class Block(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if name.split(".")[0] in ("fastapi", "litellm", "starlette"):
                raise ModuleNotFoundError(f"No module named {name!r}")
            return None

    sys.meta_path.insert(0, Block())
    """
)


def _run(code: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", BLOCK_PROXY_DEPS + code],
        cwd=HERE,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": HERE},
    )


def test_budget_sync_imports_without_the_proxy_dependencies():
    r = _run("import tensorcost_litellm.budget_sync as m; print(m.__name__)")
    assert r.returncode == 0, r.stderr
    assert "tensorcost_litellm.budget_sync" in r.stdout


def test_budget_sync_cli_help_runs_without_the_proxy_dependencies():
    r = _run("import runpy, sys; sys.argv=['budget_sync','--help']; runpy.run_module('tensorcost_litellm.budget_sync', run_name='__main__')")
    assert "usage" in (r.stdout + r.stderr).lower(), r.stderr


@pytest.mark.skipif(not REAL_LITELLM, reason="needs the real LiteLLM proxy deps; CI's litellm job has them")
def test_the_guardrail_and_logger_still_resolve_from_the_package():
    # LiteLLM config names tensorcost_litellm.TensorCostAdmit and
    # tensorcost_litellm.spend_logger; both must still resolve by attribute.
    r = subprocess.run(
        [sys.executable, "-c", "import tensorcost_litellm as t; print(t.TensorCostAdmit.__name__, type(t.spend_logger).__name__, t.__version__)"],
        cwd=HERE, capture_output=True, text=True, env={**os.environ, "PYTHONPATH": HERE},
    )
    assert r.returncode == 0, r.stderr
    assert "TensorCostAdmit TensorCostSpendLogger" in r.stdout
