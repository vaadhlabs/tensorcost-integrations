// The copies this repository commits (azure-apim/, apigee/, the LiteLLM CI
// config) are the renderer's output for the reference inputs, file for file.
// CI also runs `tensorcost-gateway-templates reference --check`; this keeps
// the same promise inside `pnpm test`.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APIM_REFERENCE_INPUT, renderApimFragment, renderApimOnErrorFragment } from "../apim.js";
import { APIGEE_REFERENCE_INPUT, renderApigeeSharedFlowFiles, type ApigeeFlowInput } from "../apigee.js";
import { renderLiteLlmConfig } from "../litellm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function onDisk(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("the committed templates", () => {
  it("azure-apim/ holds the two fragments as rendered", () => {
    expect(readFileSync(path.join(ROOT, "azure-apim/tensorcost-admit.policy-fragment.xml"), "utf8")).toBe(renderApimFragment(APIM_REFERENCE_INPUT));
    expect(readFileSync(path.join(ROOT, "azure-apim/tensorcost-on-error.policy-fragment.xml"), "utf8")).toBe(renderApimOnErrorFragment(APIM_REFERENCE_INPUT));
  });

  it("apigee/ holds every bundle as rendered, file for file", () => {
    for (const b of Object.values(renderApigeeSharedFlowFiles(APIGEE_REFERENCE_INPUT))) {
      expect(onDisk(path.join(ROOT, "apigee", b.name)), b.name).toEqual(b.files);
    }
  });

  it("litellm/ci/tensorcost.yaml is the open LiteLLM snippet the end-to-end job loads", () => {
    expect(readFileSync(path.join(ROOT, "litellm/ci/tensorcost.yaml"), "utf8")).toBe(renderLiteLlmConfig({ failMode: "open" }));
  });

  it("a closed Apigee render differs from the open one only where the fail mode is written", () => {
    // apigee/tests/lib/flow.mjs closedVariant runs the open bundle as closed
    // with exactly these changes; this keeps the two in step.
    const input = (over: Partial<ApigeeFlowInput>): ApigeeFlowInput => ({ ...APIGEE_REFERENCE_INPUT, ...over });
    const open = renderApigeeSharedFlowFiles(input({ failMode: "open" })).admit.files;
    const closed = renderApigeeSharedFlowFiles(input({ failMode: "closed" })).admit.files;
    const changed = Object.keys(open).filter((p) => open[p] !== closed[p]).sort();
    expect(changed).toEqual([
      "sharedflowbundle/policies/TC-Admit.xml",
      "sharedflowbundle/policies/TC-Decide.xml",
      "sharedflowbundle/policies/TC-Prepare.xml",
      "sharedflowbundle/sharedflows/default.xml",
      "sharedflowbundle/tensorcost-admit.xml",
    ]);
    const asClosed = (p: string, s: string) => {
      let t = s;
      if (p.endsWith("/TC-Admit.xml")) {
        t = t
          .replace('continueOnError="true"', 'continueOnError="false"')
          .replace(/<!-- Fail open:[^>]*-->/, "<!-- Fail closed: a timeout or error faults the proxy here, and the target is never called. -->");
      }
      return t
        .replace('<Property name="failMode">open</Property>', '<Property name="failMode">closed</Property>')
        .replace("Fail mode when TensorCost can't answer: open.", "Fail mode when TensorCost can't answer: closed.");
    };
    for (const p of changed) expect(asClosed(p, open[p]!), p).toBe(closed[p]);
  });
});

describe("the LiteLLM snippet", () => {
  it("runs the guardrail on every call with the given fail mode, and names the logger", () => {
    const yaml = renderLiteLlmConfig({ failMode: "closed" });
    expect(yaml).toContain("guardrail: tensorcost_litellm.TensorCostAdmit");
    expect(yaml).toContain("mode: pre_call");
    expect(yaml).toContain("default_on: true");
    expect(yaml).toContain("api_base: os.environ/TENSORCOST_URL");
    expect(yaml).toContain("api_key: os.environ/TENSORCOST_GATEWAY_KEY");
    expect(yaml).toContain("fail_mode: closed");
    expect(yaml).toContain('callbacks: ["tensorcost_litellm.spend_logger"]');
    expect(yaml).not.toContain("instance:");
  });

  it("carries the connection's instance when it has one, quoted", () => {
    expect(renderLiteLlmConfig({ failMode: "open", instance: "prod-eu" })).toContain('instance: "prod-eu"');
  });

  it("refuses a fail mode it doesn't know", () => {
    expect(() => renderLiteLlmConfig({ failMode: "sideways" as never })).toThrow(/open or closed/);
  });
});
