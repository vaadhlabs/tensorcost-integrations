/**
 * The version the rendered templates name in their User-Agent,
 * `TensorCost-APIM/<this>` and `TensorCost-Apigee/<this>`. A send-request or
 * ServiceCallout with no User-Agent of its own may be blocked by a web
 * application firewall in front of TensorCost, and a gateway that fails open
 * would then admit every call unchecked. Raise it when a template's requests
 * change. It is the templates' version, not this package's.
 */
export const GATEWAY_TEMPLATE_VERSION = "1.0.0";
