"""TensorCost for the LiteLLM proxy.

- ``TensorCostAdmit``: a pre-call guardrail that asks TensorCost whether each
  call may go ahead, and follows a refusal or a reroute.
- ``spend_logger``: the callback instance that pushes each call's spend row
  back to TensorCost. LiteLLM's ``callbacks`` setting takes an instance, so
  config names this one (``tensorcost_litellm.spend_logger``).
- ``budget_sync``: sets a LiteLLM team's ``max_budget`` from a TensorCost
  budget's room, so LiteLLM refuses on its own if TensorCost can't be reached.
"""

from ._shared import VERSION
from .guardrail import TensorCostAdmit, provably_never_billed
from .logger import TensorCostSpendLogger

__all__ = ["TensorCostAdmit", "TensorCostSpendLogger", "provably_never_billed", "spend_logger"]
__version__ = VERSION

#: The instance ``litellm_settings.callbacks`` names. It reads TENSORCOST_URL
#: and TENSORCOST_GATEWAY_KEY when it first pushes.
spend_logger = TensorCostSpendLogger()
