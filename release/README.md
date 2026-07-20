# Tools release state

This repository is the sole source of truth for `pi-leetcode-tools` source,
release records, publication policy, provenance, and `TOOLS-*` gates.

The current release artifact is selected by
`release/candidates/tools/current.json`. The gate status is recorded in
`release/gate-matrix.json`.

The package must be released in this order:

1. Complete `TOOLS-ENG` against the independent repository lockfile.
2. Create an immutable Git commit and `pi-leetcode-tools-v<version>` tag.
3. Run the tagged workflow in `dry-run` mode and bind the exact CandidateRecord,
   tgz SHA-256, release policy, npm owner, trusted publisher, and pre-publish
   dist-tags into one approval bundle.
4. Run `publish-latest`. The minimal OIDC job publishes only the approved tgz
   to npm `latest`; it cannot bootstrap a missing package or overwrite a
   version.
5. Re-download and verify the exact registry bytes, integrity, provenance,
   signature audit, lifecycle-disabled `@latest` install, Pi activation, and
   supply-chain evidence. `latest` must resolve to the released version and
   every other dist-tag must remain unchanged.
6. Only after registry verification, create the matching GitHub Release from
   the immutable tag and the verified seven-asset evidence bundle. The GitHub
   Release is marked latest and must use the same semantic version as npm.

If the npm package does not yet exist, complete the separately documented
one-time bootstrap to `next` first. Bootstrap authority is never available to
the regular OIDC workflow.

Keep this repository limited to `pi-leetcode-tools` source, tests, and release
evidence. See `TOOLS-BOOTSTRAP.md` and `tools-release-policy.json` for the
fail-closed publication controls.
