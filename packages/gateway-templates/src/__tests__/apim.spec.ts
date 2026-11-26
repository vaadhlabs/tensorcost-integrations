import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { APIM_REFERENCE_INPUT, renderApimFragment, renderApimOnErrorFragment, type ApimFragmentInput } from "../apim.js";

const input = (over: Partial<ApimFragmentInput> = {}): ApimFragmentInput => ({
  ...APIM_REFERENCE_INPUT,
  baseUrl: "https://tensorcost.example.com/api/inference-proxy/",
  ...over,
});

/**
 * Well-formedness, strictly: every tag closes in order, attributes are
 * quoted and hold no `<`, and `&` is only ever an entity. xmllint, when this
 * machine has it, checks the same output again.
 */
function wellFormed(xml: string): void {
  const stack: string[] = [];
  const body = xml.replace(/<!--[\s\S]*?-->/g, (c) => {
    expect(c.slice(4, -3)).not.toContain("--");
    return "";
  });
  const token = /<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  let roots = 0;
  while ((m = token.exec(body))) {
    const [, close, name, attrs, selfClose, text, stray] = m;
    if (stray) throw new Error(`stray < at ${m.index}: ${body.slice(m.index, m.index + 60)}`);
    const chunk = text ?? attrs ?? "";
    for (const amp of chunk.matchAll(/&/g)) {
      expect(chunk.slice(amp.index).match(/^&(amp|lt|gt|quot|apos);/), `bare & near ${chunk.slice(amp.index, amp.index + 20)}`).not.toBeNull();
    }
    if (text !== undefined) {
      if (stack.length === 0) expect(text.trim()).toBe("");
      continue;
    }
    if (close) {
      expect(stack.pop(), `</${name}>`).toBe(name);
    } else if (!selfClose) {
      if (stack.length === 0) roots++;
      stack.push(name!);
    } else if (stack.length === 0) roots++;
  }
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
  const lint = spawnSync("xmllint", ["--noout", "-"], { input: xml, encoding: "utf8" });
  if (!lint.error) expect(lint.status, lint.stderr).toBe(0);
}

const whenFor = (xml: string, decision: string, also = "") => {
  const at = xml.indexOf(`"tcDecision"]) == "${decision}"${also}`);
  expect(at).toBeGreaterThan(0);
  return xml.slice(at, xml.indexOf("</when>", at));
};

describe("renderApimFragment", () => {
  it("is well-formed XML, open and closed, with and without quotas", () => {
    for (const failMode of ["open", "closed"] as const) {
      wellFormed(renderApimFragment(input({ failMode })));
      wellFormed(renderApimFragment(input({ failMode, quotaProducts: ["starter", "search-team"] })));
      wellFormed(renderApimOnErrorFragment(input({ failMode })));
    }
  });

  it("open renders ignore-error true and a null test that lets the call through", () => {
    const xml = renderApimFragment(input({ failMode: "open" }));
    expect(xml).toContain('timeout="1" ignore-error="true"');
    expect(xml).toContain("if (r == null || r.StatusCode != 200) { return new JObject(); }");
    expect(xml).toContain('variable-name="tcLastFailMode" default-value="open"');
  });

  it("closed renders ignore-error false and refuses a call it couldn't check with a 503", () => {
    const xml = renderApimFragment(input({ failMode: "closed" }));
    expect(xml).toContain('timeout="1" ignore-error="false"');
    expect(xml).not.toContain('ignore-error="true"');
    expect(xml).toContain('variable-name="tcLastFailMode" default-value="closed"');
    const noAnswer = xml.slice(xml.indexOf('"tcDecision"]) == "" &amp;&amp;'));
    expect(noAnswer.slice(0, 600)).toContain('<set-status code="503"');
  });

  it("with no cache to read (Consumption tier) the rendered fail mode decides, both ways", () => {
    for (const failMode of ["open", "closed"] as const) {
      const xml = renderApimFragment(input({ failMode }));
      const lookup = xml.indexOf('variable-name="tcLastFailMode"');
      const fallback = xml.indexOf('<set-variable name="tcLastFailMode"');
      // Right after the lookup, before anything reads the variable.
      expect(fallback).toBeGreaterThan(lookup);
      expect(xml.indexOf('context.Variables["tcLastFailMode"]')).toBeGreaterThan(fallback);
      expect(xml.slice(fallback, fallback + 300)).toContain(`m == "open" || m == "closed" ? m : "${failMode}"`);
      expect(xml).toContain("Consumption tier has no internal cache");
    }
  });

  it("refuse returns 429 with TensorCost's message, and Retry-After when the answer gives one", () => {
    const xml = renderApimFragment(input());
    const refuse = whenFor(xml, "refuse", " &amp;&amp; (string)(((JObject)context.Variables[\"tcAnswer\"])[\"retry_after_seconds\"]");
    expect(refuse).toContain('retry_after_seconds"] as JValue) != null');
    const plain = whenFor(xml, "refuse", ")'>");
    expect(plain).toContain('<set-status code="429"');
    expect(plain).not.toContain("Retry-After");
    const unavailable = whenFor(xml, "refuse", " &amp;&amp; ((string)");
    expect(unavailable).toContain('<set-status code="503"');
    expect(refuse).toContain('<set-status code="429"');
    expect(refuse).toContain('<set-header name="Retry-After"');
    expect(refuse).toContain('["message"] as JValue)');
    expect(refuse).toContain('"budget_exceeded"');
  });

  it("reroute sets the body's model to the answer's model", () => {
    const reroute = whenFor(renderApimFragment(input()), "reroute");
    expect(reroute).toContain('b["model"] = (string)(((JObject)context.Variables["tcAnswer"])["model"] as JValue)');
  });

  it("caches an allow only for cache_ttl_seconds, and only when nothing was reserved", () => {
    const xml = renderApimFragment(input());
    const allow = xml.slice(xml.indexOf('"tcDecision"]) == "allow"'));
    expect(allow).toContain('a["cache_ttl_seconds"] as JValue');
    expect(allow).toContain("(double)held == 0 ? t : 0");
    expect(allow).toContain(`duration='@(((int)context.Variables["tcCacheTtl"]))'`);
    expect(xml.match(/<cache-store-value key='@\(\(\(string\)context.Variables\["tcCacheKey"\]\)\)'/g)).toHaveLength(1);
  });

  it("sends the callers, the model and APIM's own request id, and no prompt", () => {
    const xml = renderApimFragment(input());
    const body = xml.slice(xml.indexOf("<set-body>@{\n    var callers"), xml.indexOf("</send-request>"));
    expect(body).toContain("context.Subscription.Id");
    // The user's APIM id, the one the gateway log carries, never the email.
    expect(body).toContain('new JProperty("kind", "user"), new JProperty("id", context.User.Id)');
    expect(body).not.toContain("Email");
    expect(body).toContain("context.Product.Id");
    expect(body).toContain('new JProperty("correlation_id", context.RequestId.ToString())');
    expect(body).not.toMatch(/messages|"prompt"|"input"/);
    expect(xml).toContain('<set-header name="x-tensorcost-correlation-id" exists-action="override">');
  });

  it("a deployment in the path decides the model and sends can_reroute false, whatever the body says", () => {
    const xml = renderApimFragment(input({ deploymentModels: { "gpt-4o-prod": "gpt-4o" } }));
    wellFormed(xml);
    // "In the path" is the deployment-id parameter, not a missing body model:
    // the OpenAI SDK's Azure client sends /deployments/gpt-4o-prod/... with model in the body too.
    expect(xml).toContain(`<set-variable name="tcModelInPath" value='@(!string.IsNullOrEmpty(context.Request.MatchedParameters.GetValueOrDefault("deployment-id", "")))' />`);
    const model = xml.slice(xml.indexOf('<set-variable name="tcModel"'), xml.indexOf("/>", xml.indexOf('<set-variable name="tcModel"')));
    // With a deployment, the mapped deployment is the model and the body's model is never read.
    expect(model).toContain(`if (!string.IsNullOrEmpty(d)) { switch (d) { case "gpt-4o-prod": m = "gpt-4o"; break; default: m = d; break; } } else { m = (string)(b["model"] as JValue); }`);
    expect(xml).toContain(`if (((bool)context.Variables["tcModelInPath"])) { req["can_reroute"] = false; }`);
    // And a reroute answer (which admit won't give for it) never rewrites the body of a deployment-path call.
    expect(whenFor(xml, "reroute")).toContain(`<when condition='@(!((bool)context.Variables["tcModelInPath"]) &amp;&amp; ((JObject)context.Variables["tcBody"])["model"] != null`);
    // Unmapped, the deployment goes by its own name.
    expect(renderApimFragment(input())).toContain(`if (!string.IsNullOrEmpty(d)) { m = d; } else { m = (string)(b["model"] as JValue); }`);
    expect(() => renderApimFragment(input({ deploymentModels: { 'a"; m = "x': "gpt-4o" } }))).toThrow(/deployment name/);
    expect(() => renderApimFragment(input({ deploymentModels: { ok: 'gpt"' } }))).toThrow(/model id/);
  });

  it("names the given URL, without a trailing slash, and the key by its named value", () => {
    const xml = renderApimFragment(input());
    expect(xml).toContain("<set-url>https://tensorcost.example.com/api/inference-proxy/v1/gateway/admit</set-url>");
    expect(xml).toContain("<value>Bearer {{tensorcost-gateway-key}}</value>");
  });

  it("reads each pushed product's quota from its named value, before the check", () => {
    const xml = renderApimFragment(input({ quotaProducts: ["Starter"] }));
    expect(xml).toContain(`<when condition='@(context.Product?.Id == "Starter")'>`);
    // The value is "{tokens}|{push id}": the count is read before the "|".
    expect(xml).toContain(`token-quota='@(int.Parse("{{tensorcost-quota-starter}}".Split(&apos;|&apos;)[0]))'`);
    expect(xml).toContain(':{{tensorcost-quota-starter}}")');
    expect(xml.indexOf("llm-token-limit")).toBeLessThan(xml.indexOf("<send-request"));
  });

  it("refuses inputs that would make a broken or unsafe policy", () => {
    expect(() => renderApimFragment(input({ baseUrl: "http://tensorcost.example.com" }))).toThrow(/https/);
    expect(() => renderApimFragment(input({ baseUrl: "https://x.example.com/?a=1" }))).toThrow(/query/);
    expect(() => renderApimFragment(input({ connectionKey: "tcgw_abc" }))).toThrow(/not the key itself/);
    expect(() => renderApimFragment(input({ connectionKey: "bad name" }))).toThrow(/named value/);
    expect(() => renderApimFragment(input({ quotaProducts: ['x" || true || "'] }))).toThrow(/named value/);
    expect(() => renderApimFragment(input({ failMode: "sideways" as never }))).toThrow(/open or closed/);
  });
});

describe("renderApimOnErrorFragment", () => {
  it("cancels only after an inbound error that followed an allow", () => {
    const xml = renderApimOnErrorFragment(input());
    expect(xml).toContain('context.LastError.Section == "inbound"');
    expect(xml).toContain('context.Variables.ContainsKey("tcDecisionId")');
    expect(xml).toContain('@("https://tensorcost.example.com/api/inference-proxy/v1/gateway/admit/" + Uri.EscapeDataString(');
    expect(xml.match(/send-one-way-request mode/g)).toHaveLength(1);
  });
});

