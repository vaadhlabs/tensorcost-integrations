import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APIGEE_REFERENCE_INPUT,
  ApigeeSnippetError,
  base64,
  crc32,
  renderApigeeSharedFlowFiles,
  renderApigeeSharedFlows,
  zipFiles,
  type ApigeeFlowInput,
} from "../apigee.js";

const input = (over: Partial<ApigeeFlowInput> = {}): ApigeeFlowInput => ({ ...APIGEE_REFERENCE_INPUT, baseUrl: "https://tensorcost.example.com/api/inference-proxy/", ...over });

/** The entries of a stored zip, read back by hand: name, CRC and content. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const localName = view.getUint16(local + 26, true);
    const data = bytes.subarray(local + 30 + localName, local + 30 + localName + size);
    expect(crc32(data)).toBe(crc);
    out[name] = dec.decode(data);
    at += 46 + nameLen;
  }
  return out;
}

describe("renderApigeeSharedFlows", () => {
  it("gives each bundle as a zip, base64, holding exactly its files under sharedflowbundle/", () => {
    const zips = renderApigeeSharedFlows(input());
    const files = renderApigeeSharedFlowFiles(input());
    for (const k of ["admit", "usage", "final", "proxy"] as const) {
      const bytes = Uint8Array.from(Buffer.from(zips[k], "base64"));
      expect(base64(bytes)).toBe(zips[k]);
      expect(unzip(bytes)).toEqual(files[k].files);
      expect(Object.keys(files[k].files).every((p) => p.startsWith(k === "proxy" ? "apiproxy/" : "sharedflowbundle/"))).toBe(true);
    }
    expect(Object.keys(files.admit.files)).toContain("sharedflowbundle/tensorcost-admit.xml");
    expect(Object.keys(files.usage.files)).toContain("sharedflowbundle/tensorcost-usage.xml");
  });

  it("gives the same bytes for the same input", () => {
    expect(renderApigeeSharedFlows(input())).toEqual(renderApigeeSharedFlows(input()));
  });

  it("is a zip python's zipfile reads, when python3 is here", () => {
    const py = spawnSync("python3", ["-c", "import zipfile"]);
    if (py.error || py.status !== 0) return;
    const dir = mkdtempSync(path.join(tmpdir(), "apigee-zip-"));
    const file = path.join(dir, "admit.zip");
    writeFileSync(file, Buffer.from(renderApigeeSharedFlows(input()).admit, "base64"));
    const run = spawnSync("python3", ["-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))", file], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(Number(run.stdout.trim())).toBe(Object.keys(renderApigeeSharedFlowFiles(input()).admit.files).length);
  });

  it("sets continueOnError on the admit callout by fail mode: true under open, false under closed", () => {
    const open = renderApigeeSharedFlowFiles(input({ failMode: "open" })).admit.files["sharedflowbundle/policies/TC-Admit.xml"]!;
    const closed = renderApigeeSharedFlowFiles(input({ failMode: "closed" })).admit.files["sharedflowbundle/policies/TC-Admit.xml"]!;
    expect(open).toContain('<ServiceCallout name="TC-Admit" continueOnError="true"');
    expect(closed).toContain('<ServiceCallout name="TC-Admit" continueOnError="false"');
    expect(open).toContain("<Timeout>1000</Timeout>");
    expect(open).toContain("<Response>tcAdmit</Response>");
    expect(open).toContain("<URL>https://tensorcost.example.com/api/inference-proxy/v1/gateway/admit</URL>");
  });

  it("puts the VerifyAPIKey policy name in the quota's countRef and the scripts' properties", () => {
    const f = renderApigeeSharedFlowFiles(input({ verifyApiKeyPolicy: "Verify-API-Key-1" }));
    expect(f.admit.files["sharedflowbundle/policies/TC-TokenQuota.xml"]).toContain('countRef="verifyapikey.Verify-API-Key-1.apiproduct.tensorcost_llm_quota"');
    expect(f.usage.files["sharedflowbundle/policies/TC-TokenCount.xml"]).toContain('countRef="verifyapikey.Verify-API-Key-1.apiproduct.tensorcost_llm_quota"');
    expect(f.usage.files["sharedflowbundle/policies/TC-UsageRow.xml"]).toContain('<Property name="verifyApiKeyPolicy">Verify-API-Key-1</Property>');
  });

  it("refuses a key in place of the KVM entry name, a URL that isn't https, and a policy name Apigee wouldn't take", () => {
    expect(() => renderApigeeSharedFlows(input({ connectionKey: "tcgw_" + "a".repeat(64) }))).toThrow(ApigeeSnippetError);
    expect(() => renderApigeeSharedFlows(input({ connectionKey: "has space" }))).toThrow(ApigeeSnippetError);
    expect(() => renderApigeeSharedFlows(input({ baseUrl: "http://tensorcost.example.com" }))).toThrow(ApigeeSnippetError);
    expect(() => renderApigeeSharedFlows(input({ baseUrl: "https://tensorcost.example.com/?x=1" }))).toThrow(ApigeeSnippetError);
    expect(() => renderApigeeSharedFlows(input({ verifyApiKeyPolicy: "<x>" }))).toThrow(ApigeeSnippetError);
    expect(() => renderApigeeSharedFlows(input({ failMode: "maybe" as never }))).toThrow(ApigeeSnippetError);
  });

  it("escapes what it puts in the XML", () => {
    const f = renderApigeeSharedFlowFiles(input({ baseUrl: "https://tensorcost.example.com/a&b" }));
    expect(f.admit.files["sharedflowbundle/policies/TC-Admit.xml"]).toContain("<URL>https://tensorcost.example.com/a&amp;b/v1/gateway/admit</URL>");
  });
});
