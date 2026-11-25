/**
 * Post-build tasks:
 *   1. Bundle src/index.ts into dist/index.js. The Homebrew formula installs
 *      from the tarball with no dependency step, so the published CLI is one
 *      file with no runtime dependencies.
 *   2. Prepend #!/usr/bin/env node shebang to dist/index.js and chmod +x it.
 *   3. Copy src/pricing/models.json → dist/pricing/models.json so the
 *      createRequire call in the bundle can resolve it at runtime.
 */
import { readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";

const root = join(fileURLToPath(import.meta.url), "../../");
const entry = join(root, "dist/index.js");

// 1. Bundle
await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: entry,
  allowOverwrite: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  logLevel: "warning",
});
console.log("postbuild: bundled src/index.ts → dist/index.js");

// 2. Shebang
const src = readFileSync(entry, "utf8");
if (!src.startsWith("#!/usr/bin/env node")) {
  writeFileSync(entry, "#!/usr/bin/env node\n" + src, "utf8");
}
chmodSync(entry, 0o755);
console.log("postbuild: shebang stamped on dist/index.js");

// 3. Copy pricing JSON
const srcJson = join(root, "src/pricing/models.json");
const destDir = join(root, "dist/pricing");
const destJson = join(destDir, "models.json");
mkdirSync(destDir, { recursive: true });
copyFileSync(srcJson, destJson);
console.log("postbuild: copied src/pricing/models.json → dist/pricing/models.json");
