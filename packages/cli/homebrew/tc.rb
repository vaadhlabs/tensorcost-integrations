# TensorCost CLI — Homebrew formula
#
# This file is a DRAFT template. The three placeholder strings below are
# replaced by the release-cli.yml workflow before being pushed to the tap:
#
#   TENSORCOST_VERSION_PLACEHOLDER  → semver (e.g. 0.2.0)
#   TENSORCOST_SHA256_PLACEHOLDER   → sha256 of the npm tarball
#   TENSORCOST_URL_PLACEHOLDER      → full npm registry tarball URL
#
# To update manually:
#   1. Download the tarball:
#        curl -LO https://registry.npmjs.org/@tensorcost/cli/-/cli-<version>.tgz
#   2. Compute sha256:
#        sha256sum cli-<version>.tgz
#   3. Replace the three placeholders with the real values.
#
# The formula installs @tensorcost/cli from the npm tarball (no npm/Node
# runtime required on the user's machine — Node is declared as a dependency
# and Homebrew resolves it).  Two binary shims are written:
#   tensorcost  — the canonical binary (maps to bin.tensorcost in package.json)
#   tc          — short alias (symlinked by the formula, not in package.json)
#
# Tap location: vaadhlabs/homebrew-tap  (or tensorcost/homebrew-tap once the
# dedicated org is live — see docs/features/cli.md for the naming discussion).
# Install command: brew install vaadhlabs/tap/tc

class Tc < Formula
  desc "Estimate and compare LLM prompt costs from the command line"
  homepage "https://tensorcost.com/cli"
  url "TENSORCOST_URL_PLACEHOLDER"
  sha256 "TENSORCOST_SHA256_PLACEHOLDER"
  version "TENSORCOST_VERSION_PLACEHOLDER"
  license "Apache-2.0"

  # Node >=18 is required per the package.json engines field.
  # Homebrew's `node` formula tracks the current LTS (20+), which satisfies
  # the constraint. We don't pin to a specific major so the formula keeps
  # working as LTS advances.
  depends_on "node"

  def install
    # The tarball is a standard npm pack output: a single `package/`
    # directory at the root. Everything is already built (dist/).
    # We install the whole package directory into libexec so node can
    # resolve the ESM entry point, then write shims in bin/.

    libexec.install Dir["package/*"]

    # Primary shim — matches the `tensorcost` bin entry in package.json.
    (bin/"tensorcost").write_env_script(
      libexec/"dist/index.js",
      PATH: "#{Formula["node"].opt_bin}:$PATH",
    )

    # Short alias. The formula name is `tc` so `brew install vaadhlabs/tap/tc`
    # works. This symlink means users can type either `tensorcost` or `tc`.
    bin.install_symlink bin/"tensorcost" => "tc"
  end

  test do
    # Smoke test: --version must exit 0 and print the version string.
    # This proves the binary is executable, Node is on PATH, and the
    # dist/index.js entry point is present inside libexec.
    output = shell_output("#{bin}/tc --version")
    assert_match version.to_s, output

    # Functional test: estimate a tiny inline prompt without network access.
    # The bundled pricing table ships in dist/pricing/models.json so this
    # works fully offline. If the command exits non-zero, test fails.
    output = shell_output(
      "#{bin}/tc estimate --prompt 'Hello world' --model anthropic/claude-3-haiku --json",
    )
    assert_match "totalCostUsd", output
  end
end
