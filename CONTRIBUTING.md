# Contributing

Thanks for taking the time. Bug reports and pull requests are welcome.

## Sign your commits (DCO)

We use the Developer Certificate of Origin rather than a CLA. Add a sign-off to
every commit:

    git commit -s -m "fix: describe the change"

That adds a `Signed-off-by: Your Name <you@example.com>` line, which states that
you wrote the change or have the right to submit it under the project's licence
(https://developercertificate.org). Pull requests with unsigned commits can't be
merged.

## How pull requests land

This repository is the source of everything in it. Pull requests are reviewed
and merged here, and the packages are published from here. TensorCost's own
product uses the published packages like any other user, so a change reaches
it through a release.

## Before you open a pull request

Run the tests for the package you changed (`pnpm install`, then `pnpm test`
for the Node packages, or the commands in that directory's README). Keep one
change per pull request. For anything larger than a bug fix, open an issue
first so we can agree on the direction.

A change to the admit protocol (`spec/admit/`) is a change to a public
contract: say in the pull request what an existing client sees differently.

If you change a renderer in `packages/gateway-templates`, regenerate the
committed templates with `pnpm --filter @tensorcost/gateway-templates build &&
pnpm --filter @tensorcost/gateway-templates reference`. CI fails when
`azure-apim/`, `apigee/` or `litellm/ci/tensorcost.yaml` differ from the
renderer's output.

CI also runs `tools/guard.mjs` over every change and every package before it
is published. It refuses secrets, cloud account ids and internal host names;
if it flags your change, it names the file and line but not the value.

## Security

Don't file security problems as issues. See SECURITY.md.
