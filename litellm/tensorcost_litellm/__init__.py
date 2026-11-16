"""TensorCost for the LiteLLM proxy.

- ``TensorCostAdmit``: a pre-call guardrail that asks TensorCost whether each
  call may go ahead, and follows a refusal or a reroute.
- ``spend_logger``: the callback instance that pushes each call's spend row
  back to TensorCost. LiteLLM's ``callbacks`` setting takes an instance, so
  config names this one (``tensorcost_litellm.spend_logger``).
- ``budget_sync``: sets a LiteLLM team's ``max_budget`` from a TensorCost
  budget's room, so LiteLLM refuses on its own if TensorCost can't be reached.

The guardrail and the logger import LiteLLM's proxy classes (and so FastAPI),
which only exist inside the LiteLLM proxy. ``budget_sync`` is a standalone CLI
that needs only httpx, and importing any submodule runs this file first, so
the proxy-side names load lazily, on first use, not at import.
"""

from __future__ import annotations

from typing import Any

from ._shared import VERSION

__all__ = ["TensorCostAdmit", "TensorCostSpendLogger", "provably_never_billed", "spend_logger"]
__version__ = VERSION

_spend_logger: Any = None


def __getattr__(name: str) -> Any:
    global _spend_logger
    if name in ("TensorCostAdmit", "provably_never_billed"):
        from . import guardrail

        return getattr(guardrail, name)
    if name == "TensorCostSpendLogger":
        from .logger import TensorCostSpendLogger

        return TensorCostSpendLogger
    if name == "spend_logger":
        # The instance litellm_settings.callbacks names. It reads TENSORCOST_URL
        # and TENSORCOST_GATEWAY_KEY when it first pushes. One per process.
        if _spend_logger is None:
            from .logger import TensorCostSpendLogger

            _spend_logger = TensorCostSpendLogger()
        return _spend_logger
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
