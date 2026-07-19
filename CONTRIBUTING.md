# Contributing

Before submitting changes:

1. Use Node.js `>=22.19.0` and run `npm ci` from the repository root.
2. Run `npm run verify:tools:release`. This builds reproducibly, tests, packs,
   installs, activates, audits, and verifies the exact release artifact.
3. Review the generated SBOM and release evidence in `.artifacts/`.
4. Do not add real credentials, complete LeetCode problem archives, hidden test
   cases, or real user submission fixtures.

Changes to the public tool contract require a compatibility assessment and an
update to the contract version described in the implementation plan.
