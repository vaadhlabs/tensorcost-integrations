#!/usr/bin/env node
/**
 * tensorcost-gateway-templates: renders the gateway templates for your own
 * TensorCost URL and fail mode, without a TensorCost console.
 *
 *   tensorcost-gateway-templates apim    --base-url <url> --out <dir> [options]
 *   tensorcost-gateway-templates apigee  --base-url <url> --out <dir> [--zip] [options]
 *   tensorcost-gateway-templates litellm [--fail-mode open|closed] [--instance <label>]
 *   tensorcost-gateway-templates reference --out <repo checkout> [--check]
 *
 * Options: --fail-mode open|closed (default open), --key-name <named value or
 * KVM entry holding the tcgw_ key>, --verify-api-key-policy <name> (Apigee),
 * --quota-product <id> and --deployment <name>=<model> (APIM, repeatable).
 *
 * `reference` writes (or with --check compares) the copies this repository
 * commits: azure-apim/*.policy-fragment.xml, the four Apigee bundles and
 * litellm/ci/tensorcost.yaml.
 */
import fs from "node:fs";
import path from "node:path";
import { APIM_KEY_NAMED_VALUE, APIM_REFERENCE_INPUT, renderApimFragment, renderApimOnErrorFragment, type ApimFragmentInput } from "./apim.js";
import { APIGEE_KEY_ENTRY, APIGEE_REFERENCE_INPUT, renderApigeeSharedFlowFiles, zipFiles, type ApigeeFlowInput } from "./apigee.js";
import { renderLiteLlmConfig, type LiteLlmFailMode } from "./litellm.js";

type Files = Record<string, string | Uint8Array>;

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "usage: tensorcost-gateway-templates apim|apigee --base-url <url> --out <dir> [--fail-mode open|closed] [--key-name <name>]\n" +
      "       tensorcost-gateway-templates litellm [--fail-mode open|closed] [--instance <label>]\n" +
      "       tensorcost-gateway-templates reference --out <repo checkout> [--check]\n",
  );
  process.exit(2);
}

function parse(argv: string[]): { cmd: string; flags: Map<string, string[]>; bools: Set<string> } {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") usage();
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) usage(`unexpected ${a}`);
    const name = a.slice(2);
    if (name === "zip" || name === "check") {
      bools.add(name);
      continue;
    }
    const v = rest[++i];
    if (v === undefined) usage(`${a} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), v]);
  }
  return { cmd, flags, bools };
}

const one = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.at(-1);

function failMode(flags: Map<string, string[]>): LiteLlmFailMode {
  const m = one(flags, "fail-mode") ?? "open";
  if (m !== "open" && m !== "closed") usage("--fail-mode is open or closed");
  return m;
}

function apimFiles(input: ApimFragmentInput): Files {
  return {
    "tensorcost-admit.policy-fragment.xml": renderApimFragment(input),
    "tensorcost-on-error.policy-fragment.xml": renderApimOnErrorFragment(input),
  };
}

function apigeeFiles(input: ApigeeFlowInput, zip: boolean): Files {
  const out: Files = {};
  for (const b of Object.values(renderApigeeSharedFlowFiles(input))) {
    if (zip) out[`${b.name}.zip`] = zipFiles(b.files);
    else for (const [p, text] of Object.entries(b.files)) out[`${b.name}/${p}`] = text;
  }
  return out;
}

function write(dir: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** The files under `dir` that differ from `files`, or are missing. */
function differences(dir: string, files: Files): string[] {
  const out: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    if (!fs.existsSync(target)) out.push(`${rel}: missing`);
    else if (fs.readFileSync(target, "utf8") !== content) out.push(`${rel}: differs`);
  }
  return out;
}

function listed(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
}

function reference(root: string, check: boolean): number {
  const apigee = apigeeFiles(APIGEE_REFERENCE_INPUT, false);
  const sets: Array<[string, Files]> = [
    ["azure-apim", apimFiles(APIM_REFERENCE_INPUT)],
    ["apigee", apigee],
    ["litellm/ci", { "tensorcost.yaml": renderLiteLlmConfig({ failMode: "open" }) }],
  ];
  if (!check) {
    for (const [dir, files] of sets) write(path.join(root, dir), files);
    return 0;
  }
  const problems = sets.flatMap(([dir, files]) => differences(path.join(root, dir), files).map((p) => `${dir}/${p}`));
  // A file in a rendered bundle that the renderer doesn't produce is stale.
  const bundles = new Set(Object.keys(apigee).map((p) => p.split("/")[0]!));
  for (const b of bundles) {
    for (const f of listed(path.join(root, "apigee", b))) if (!(`${b}/${f}` in apigee)) problems.push(`apigee/${b}/${f}: not rendered`);
  }
  for (const p of problems) process.stderr.write(`${p}\n`);
  if (problems.length) process.stderr.write("The committed templates are not the renderer's output. Run: tensorcost-gateway-templates reference --out .\n");
  return problems.length ? 1 : 0;
}

function main(argv: string[]): number {
  const { cmd, flags, bools } = parse(argv);
  if (cmd === "litellm") {
    process.stdout.write(renderLiteLlmConfig({ failMode: failMode(flags), instance: one(flags, "instance") ?? null }));
    return 0;
  }
  const out = one(flags, "out");
  if (cmd === "reference") {
    if (!out) usage("reference needs --out <repo checkout>");
    return reference(out, bools.has("check"));
  }
  const baseUrl = one(flags, "base-url");
  if (!baseUrl) usage(`${cmd} needs --base-url`);
  if (!out) usage(`${cmd} needs --out <dir>`);
  if (cmd === "apim") {
    const deploymentModels = Object.fromEntries(
      (flags.get("deployment") ?? []).map((d) => {
        const at = d.indexOf("=");
        if (at < 1) usage("--deployment is <name>=<model>");
        return [d.slice(0, at), d.slice(at + 1)];
      }),
    );
    write(out, apimFiles({
      baseUrl,
      failMode: failMode(flags),
      connectionKey: one(flags, "key-name") ?? APIM_KEY_NAMED_VALUE,
      callerExpr: { subscription: true, user: true, product: true },
      quotaProducts: flags.get("quota-product") ?? [],
      deploymentModels,
    }));
    return 0;
  }
  if (cmd === "apigee") {
    const verify = one(flags, "verify-api-key-policy");
    write(out, apigeeFiles({ baseUrl, failMode: failMode(flags), connectionKey: one(flags, "key-name") ?? APIGEE_KEY_ENTRY, ...(verify ? { verifyApiKeyPolicy: verify } : {}) }, bools.has("zip")));
    return 0;
  }
  usage(`unknown command ${cmd}`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`tensorcost-gateway-templates: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
