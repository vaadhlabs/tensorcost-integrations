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

This repository is a published copy. The source of truth is a private monorepo,
and the maintainers port accepted pull requests back into it by hand. Expect the
change to reach this repository again on the next release export, with your
authorship kept in the commit. We don't merge directly here, so the pull
request may be closed once it has been ported.

## Before you open a pull request

Run the tests for the package you changed. Keep one change per pull request.
For anything larger than a bug fix, open an issue first so we can agree on the
direction.

## Security

Don't file security problems as issues. See SECURITY.md.
