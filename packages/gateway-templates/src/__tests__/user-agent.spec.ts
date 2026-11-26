import { describe, expect, it } from "vitest";
import { APIGEE_REFERENCE_INPUT, APIGEE_USER_AGENT, renderApigeeSharedFlowFiles } from "../apigee.js";
import { APIM_REFERENCE_INPUT, APIM_USER_AGENT, renderApimFragment, renderApimOnErrorFragment } from "../apim.js";
import { GATEWAY_TEMPLATE_VERSION } from "../version.js";

// Common web application firewall rule sets block a request with no
// User-Agent. A template call one blocked would fail open unchecked, so every
// request a rendered template sends names itself.
describe("the rendered gateway templates send a User-Agent", () => {
  const install = { baseUrl: "https://tensorcost.example.com/api/inference-proxy", connectionKey: "tc-key" };

  it("names the template and its version", () => {
    expect(APIM_USER_AGENT).toBe(`TensorCost-APIM/${GATEWAY_TEMPLATE_VERSION}`);
    expect(APIGEE_USER_AGENT).toBe(`TensorCost-Apigee/${GATEWAY_TEMPLATE_VERSION}`);
  });

  it("APIM: the admit send-request and the on-error cancel, under either fail mode", () => {
    for (const failMode of ["open", "closed"] as const) {
      const admit = renderApimFragment({ ...APIM_REFERENCE_INPUT, ...install, failMode });
      expect(admit.match(/<send-request\b[\s\S]*?<\/send-request>/)![0]).toContain(`<set-header name="User-Agent" exists-action="override">\n\t\t\t\t\t<value>${APIM_USER_AGENT}</value>`);
    }
    const onError = renderApimOnErrorFragment(install);
    expect(onError.match(/<send-one-way-request\b[\s\S]*?<\/send-one-way-request>/)![0]).toContain(`<value>${APIM_USER_AGENT}</value>`);
  });

  it("Apigee: every ServiceCallout, admit, the usage row, the cancel and the streamed row", () => {
    const bundles = renderApigeeSharedFlowFiles({ ...APIGEE_REFERENCE_INPUT, ...install });
    const callouts = Object.values(bundles).flatMap((b) => Object.entries(b.files).filter(([, xml]) => xml.includes("<ServiceCallout")));
    expect(callouts.map(([p]) => p.split("/").pop()).sort()).toEqual(["TC-Admit.xml", "TC-Cancel.xml", "TC-StreamLog.xml", "TC-UsageLog.xml"]);
    for (const [p, xml] of callouts) expect(xml, p).toContain(`<Header name="User-Agent">${APIGEE_USER_AGENT}</Header>`);
  });
});
