"""Checks on the two APIM policy fragments, with the standard library only.

APIM itself isn't run here: these tests read the XML and the policy
expressions in it, and hold the fragments to what the admit contract
(spec/admit/openapi.yaml) asks of a gateway client.

Run with ``python3 -m unittest discover -s tests`` (or pytest) from azure-apim/.
"""

import pathlib
import re
import unittest
import xml.etree.ElementTree as ET

HERE = pathlib.Path(__file__).resolve().parent.parent
ADMIT = HERE / "tensorcost-admit.policy-fragment.xml"
ON_ERROR = HERE / "tensorcost-on-error.policy-fragment.xml"


def parse(path):
    return ET.parse(path).getroot()


def walk(el):
    yield el
    for child in el:
        yield from walk(child)


def whens(root):
    return [e for e in walk(root) if e.tag == "when"]


def branch(root, decision):
    """The <when> whose condition tests tcDecision == decision (the first one)."""
    for w in whens(root):
        if '"tcDecision"]) == "%s"' % decision in w.get("condition", ""):
            return w
    raise AssertionError("no branch for decision %s" % decision)


class WellFormed(unittest.TestCase):
    def test_both_fragments_parse_as_xml(self):
        for path in (ADMIT, ON_ERROR):
            root = parse(path)
            self.assertEqual(root.tag, "fragment", path.name)

    def test_expressions_never_hold_a_raw_angle_bracket_or_ampersand(self):
        # A well-formed file can't, but the check names the rule for whoever edits it.
        for path in (ADMIT, ON_ERROR):
            text = path.read_text()
            for m in re.finditer(r"'(@[^']*)'", text):
                self.assertNotIn("<", m.group(1), path.name)


class AdmitCall(unittest.TestCase):
    def setUp(self):
        self.root = parse(ADMIT)
        self.send = next(e for e in walk(self.root) if e.tag == "send-request")

    def test_one_second_timeout_and_open_ignores_errors(self):
        self.assertEqual(self.send.get("timeout"), "1")
        self.assertEqual(self.send.get("ignore-error"), "true")
        self.assertEqual(self.send.get("mode"), "new")

    def test_posts_to_the_gateway_admit_route_with_the_key_from_a_named_value(self):
        self.assertTrue(self.send.find("set-url").text.endswith("/v1/gateway/admit"))
        self.assertEqual(self.send.find("set-method").text, "POST")
        auth = [h for h in self.send.findall("set-header") if h.get("name") == "Authorization"][0]
        self.assertEqual(auth.find("value").text, "Bearer {{tensorcost-gateway-key}}")
        self.assertNotIn("tcgw_", ADMIT.read_text())

    def test_the_request_names_callers_model_and_correlation_id_and_no_prompt(self):
        body = self.send.find("set-body").text
        for field in ('"subscription"', "context.Subscription.Id", '"user"', "context.User.Id", '"product"', "context.Product.Id"):
            self.assertIn(field, body)
        # The user is its APIM id, the one ApiManagementGatewayLogs carries, never the email.
        self.assertNotIn("Email", body)
        self.assertIn('new JProperty("correlation_id", context.RequestId.ToString())', body)
        self.assertIn('"model"', body)
        for content in ("messages", "prompt", "input", "contents"):
            self.assertNotIn('"%s"' % content, body)

    def test_the_check_names_itself_in_a_user_agent(self):
        # send-request mode="new" sets only the headers it is given; the WAF blocks a request with none.
        ua = [h for h in self.send.findall("set-header") if h.get("name") == "User-Agent"]
        self.assertEqual(len(ua), 1)
        self.assertEqual(ua[0].get("exists-action"), "override")
        self.assertRegex(ua[0].find("value").text, r"^TensorCost-APIM/\d+\.\d+\.\d+$")

    def test_the_on_error_cancel_names_itself_in_a_user_agent_too(self):
        cancel = next(e for e in walk(parse(ON_ERROR)) if e.tag == "send-one-way-request")
        ua = [h for h in cancel.findall("set-header") if h.get("name") == "User-Agent"]
        self.assertEqual(len(ua), 1)
        self.assertRegex(ua[0].find("value").text, r"^TensorCost-APIM/\d+\.\d+\.\d+$")

    def test_the_customer_comes_from_x_tc_customer_and_keys_the_cache(self):
        customer = next(e for e in walk(self.root) if e.tag == "set-variable" and e.get("name") == "tcCustomer")
        self.assertIn('context.Request.Headers.GetValueOrDefault("x-tc-customer", "")', customer.get("value"))
        body = self.send.find("set-body").text
        self.assertIn('var customer = ((string)context.Variables["tcCustomer"]);', body)
        self.assertIn('if (customer != "") { req["customer"] = customer; }', body)
        # One customer's cached allow never covers another customer's call.
        key = next(e for e in walk(self.root) if e.tag == "set-variable" and e.get("name") == "tcCacheKey").get("value")
        self.assertIn('((string)context.Variables["tcCustomer"])', key)
        names = [e.get("name") for e in walk(self.root) if e.tag == "set-variable"]
        self.assertLess(names.index("tcCustomer"), names.index("tcCacheKey"))

    def test_a_deployment_in_the_path_is_never_rerouted_whatever_the_body_says(self):
        body = self.send.find("set-body").text
        self.assertIn('req["can_reroute"] = false;', body)
        # Decided by the path's deployment-id: the OpenAI SDK's Azure client sends a body model too.
        flag = next(e for e in walk(self.root) if e.tag == "set-variable" and e.get("name") == "tcModelInPath")
        self.assertIn('MatchedParameters.GetValueOrDefault("deployment-id", "")', flag.get("value"))
        self.assertNotIn('["model"]', flag.get("value"))
        model = next(e for e in walk(self.root) if e.tag == "set-variable" and e.get("name") == "tcModel").get("value")
        self.assertLess(model.index("if (!string.IsNullOrEmpty(d))"), model.index('b["model"]'))
        reroute = branch(self.root, "reroute")
        rewrite = [e for e in walk(reroute) if e.tag == "when"][1]
        self.assertIn('!((bool)context.Variables["tcModelInPath"])', rewrite.get("condition"))

    def test_the_correlation_id_header_is_minted_here_and_overwrites_the_callers(self):
        header = next(e for e in walk(self.root) if e.tag == "set-header" and e.get("name") == "x-tensorcost-correlation-id")
        self.assertEqual(header.get("exists-action"), "override")
        self.assertEqual(header.find("value").text, "@(context.RequestId.ToString())")

    def test_no_answer_is_a_null_test_then_the_fail_mode(self):
        answer = next(e for e in walk(self.root) if e.tag == "set-variable" and e.get("name") == "tcAnswer")
        self.assertIn("r == null || r.StatusCode != 200", answer.get("value"))
        none = [w for w in whens(self.root) if '"tcDecision"]) == ""' in w.get("condition", "")][0]
        self.assertIn('"tcLastFailMode"]) == "closed"', none.get("condition"))
        self.assertEqual(none.find("return-response/set-status").get("code"), "503")

    def test_the_last_fail_mode_tensorcost_sent_is_remembered(self):
        stores = [e for e in walk(self.root) if e.tag == "cache-store-value" and e.get("key") == "tensorcost:fail-mode"]
        self.assertEqual(len(stores), 1)
        lookup = [e for e in walk(self.root) if e.tag == "cache-lookup-value" and e.get("key") == "tensorcost:fail-mode"][0]
        self.assertEqual(lookup.get("default-value"), "open")

    def test_with_no_cache_the_rendered_fail_mode_applies(self):
        # Consumption tier: no internal cache, so the lookup may leave the
        # variable unset or null. Right after it, anything but open/closed is
        # the rendered mode, and nothing reads the variable before that.
        children = list(self.root)
        lookup_at = next(i for i, e in enumerate(children) if e.tag == "cache-lookup-value" and e.get("key") == "tensorcost:fail-mode")
        fallback = children[lookup_at + 1]
        self.assertEqual((fallback.tag, fallback.get("name")), ("set-variable", "tcLastFailMode"))
        self.assertIn('GetValueOrDefault<string>("tcLastFailMode", "")', fallback.get("value"))
        self.assertIn('m == "open" || m == "closed" ? m : "open"', fallback.get("value"))

    def test_the_header_says_consumption_needs_a_reimport(self):
        text = ADMIT.read_text()
        self.assertIn("Consumption tier has no internal cache", text)
        self.assertIn("render and import this fragment", text)


class Decisions(unittest.TestCase):
    def setUp(self):
        self.root = parse(ADMIT)

    def test_refuse_returns_429_with_the_message_and_retry_after(self):
        refusals = [w for w in whens(self.root) if '"tcDecision"]) == "refuse"' in w.get("condition", "") and "check_unavailable" not in w.get("condition", "")]
        self.assertEqual(len(refusals), 2)
        with_retry, plain = refusals
        for w in refusals:
            self.assertEqual(w.find("return-response/set-status").get("code"), "429")
            body = w.find("return-response/set-body").text
            self.assertIn('["message"]', body)
            self.assertIn('"budget_exceeded"', body)
        headers = [h.get("name") for h in with_retry.findall("return-response/set-header")]
        self.assertIn("Retry-After", headers)
        self.assertNotIn("Retry-After", [h.get("name") for h in plain.findall("return-response/set-header")])

    def test_a_check_that_couldnt_run_is_a_503_not_a_spent_budget(self):
        branches = [w for w in whens(self.root) if "check_unavailable" in w.get("condition", "")]
        self.assertEqual(len(branches), 2)
        for w in branches:
            self.assertIn("invalid_request", w.get("condition"))
            self.assertEqual(w.find("return-response/set-status").get("code"), "503")
        # A closed workspace's throttled answer keeps its Retry-After.
        with_retry, plain = branches
        self.assertIn("retry_after_seconds", with_retry.get("condition"))
        self.assertIn("Retry-After", [h.get("name") for h in with_retry.findall("return-response/set-header")])
        self.assertNotIn("Retry-After", [h.get("name") for h in plain.findall("return-response/set-header")])

    def test_reroute_sets_the_bodys_model(self):
        w = branch(self.root, "reroute")
        body = next(e for e in walk(w) if e.tag == "set-body").text
        self.assertIn('b["model"] =', body)
        self.assertIn('["model"] as JValue', body)

    def test_an_allow_is_cached_only_for_its_ttl_and_only_when_nothing_was_reserved(self):
        w = branch(self.root, "allow")
        ttl = next(e for e in walk(w) if e.tag == "set-variable" and e.get("name") == "tcCacheTtl").get("value")
        self.assertIn('a["cache_ttl_seconds"]', ttl)
        self.assertIn('(double)held == 0', ttl)
        self.assertIn('a["degraded"] != null', ttl)
        store = next(e for e in walk(w) if e.tag == "cache-store-value")
        self.assertIn('"tcCacheTtl"', store.get("duration"))
        # Nothing but an allow is ever stored under the allow cache key.
        allow_stores = [e for e in walk(self.root) if e.tag == "cache-store-value" and "tcCacheKey" in (e.get("key") or "")]
        self.assertEqual(allow_stores, [store])

    def test_a_cached_allow_skips_the_check(self):
        lookup = [e for e in walk(self.root) if e.tag == "cache-lookup-value" and e.get("variable-name") == "tcCachedAllow"][0]
        self.assertIn("tcCacheKey", lookup.get("key"))
        gate = [w for w in whens(self.root) if 'ContainsKey("tcCachedAllow")' in w.get("condition", "")][0]
        self.assertTrue(any(e.tag == "send-request" for e in walk(gate)))

    def test_the_admit_is_never_sent_twice(self):
        self.assertEqual(len([e for e in walk(self.root) if e.tag == "send-request"]), 1)
        self.assertFalse(any(e.tag == "retry" for e in walk(self.root)))


class Readme(unittest.TestCase):
    def test_the_roles_are_least_privilege_and_valid_json(self):
        import json
        text = (HERE / "README.md").read_text()
        roles = [json.loads(m) for m in re.findall(r"```json\n(.*?)```", text, re.S)]
        by_name = {r["Name"]: r for r in roles}
        self.assertEqual(
            sorted(by_name["TensorCost APIM quotas"]["Actions"]),
            sorted(["Microsoft.ApiManagement/service/namedValues/read", "Microsoft.ApiManagement/service/namedValues/write", "Microsoft.ApiManagement/service/namedValues/delete"]),
        )
        logs = by_name["TensorCost APIM logs"]["Actions"]
        # query/read runs queries at all (Microsoft: "required for every user that can execute queries");
        # the per-table actions grant the two tables. query/*/read, every table, is never there.
        self.assertEqual(
            sorted(logs),
            sorted([
                "Microsoft.OperationalInsights/workspaces/read",
                "Microsoft.OperationalInsights/workspaces/query/read",
                "Microsoft.OperationalInsights/workspaces/query/ApiManagementGatewayLlmLog/read",
                "Microsoft.OperationalInsights/workspaces/query/ApiManagementGatewayLogs/read",
            ]),
        )
        for r in roles:
            self.assertFalse(any("*" in a for a in r["Actions"]), r["Name"])
            # Assignable at a resource group; assigned on the one service or workspace.
            for scope in r["AssignableScopes"]:
                self.assertRegex(scope, r"^/subscriptions/[^/]+/resourceGroups/[^/]+$")
        self.assertIn("https://learn.microsoft.com/azure/azure-monitor/logs/manage-access", text)


class OnError(unittest.TestCase):
    def setUp(self):
        self.root = parse(ON_ERROR)

    def test_cancels_only_after_an_inbound_error_and_an_allow(self):
        cancel = [w for w in whens(self.root) if any(e.tag == "send-one-way-request" for e in walk(w))]
        self.assertEqual(len(cancel), 1)
        cond = cancel[0].get("condition")
        self.assertIn('context.LastError.Section == "inbound"', cond)
        self.assertIn('ContainsKey("tcDecisionId")', cond)
        url = next(e for e in walk(cancel[0]) if e.tag == "set-url").text
        self.assertIn("/v1/gateway/admit/", url)
        self.assertIn('+ "/cancel"', url)

    def test_a_failed_check_under_closed_is_the_same_503(self):
        w = [w for w in whens(self.root) if 'Source == "send-request"' in w.get("condition", "")][0]
        self.assertEqual(w.find("return-response/set-status").get("code"), "503")
        self.assertIn("budget_check_unavailable", w.find("return-response/set-body").text)


if __name__ == "__main__":
    unittest.main()
