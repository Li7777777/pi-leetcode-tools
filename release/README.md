# Tools release state

This repository is the sole source of truth for `pi-leetcode-tools` source,
release records, publication policy, provenance, and `TOOLS-*` gates.

The current release artifact is selected by
`release/candidates/tools/current.json`. The gate status is recorded in
`release/gate-matrix.json`.

The package must be released in this order:

1. Complete `TOOLS-ENG` against the independent repository lockfile.
2. Create an immutable Git commit and `pi-leetcode-tools-v<version>` tag.
3. Complete the documented one-time npm bootstrap to `next` if the package
   does not yet exist.
4. Re-download and verify the exact registry tarball, integrity, provenance,
   clean install, Pi activation, public reads, and approved account matrix.
5. Configure the reviewed npm owner and trusted publisher, revoke bootstrap
   credentials, and verify the initial dist-tags. npm can initialize `latest`
   to the same audited version on first package creation even when the publish
   command explicitly targets `next`; any divergent value remains a failure.

Keep this repository limited to `pi-leetcode-tools` source, tests, and release
evidence. See `TOOLS-BOOTSTRAP.md` and `tools-release-policy.json` for the
fail-closed publication controls.
