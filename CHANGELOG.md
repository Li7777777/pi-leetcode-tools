# Changelog

All notable changes to this repository are documented here. Package versions
follow Semantic Versioning independently from the versioned Tool contract and
event protocol.

## Unreleased

- Changed regular trusted publishing from the staged npm `next` channel to a
  stable-only, monotonic npm `latest` release with verification that every
  non-target dist-tag remains unchanged.
- Added post-registry automation for a matching latest GitHub Release built
  from the exact verified tgz, formal registry evidence, dist-tag transition,
  Pi activation evidence, supply-chain evidence, CycloneDX SBOM, and checksums.
- Added release-infrastructure tests and fail-closed checks for version
  rollback, prerelease promotion, default `@latest` installation, workflow
  permissions, release ordering, and immutable asset identity.

## 0.1.4 - 2026-07-20

- Fixed installed-package Gateway activation when `PI_CODING_AGENT_DIR` is not
  explicitly set by resolving durable state through Pi's standard agent
  directory fallback.
- Added a provider-compatible model-tool schema projection that removes root
  JSON Schema combinators while preserving the strict versioned Gateway
  contract and runtime cross-field validation.
- Strengthened packed-install and real-Pi activation gates to require a Gateway
  ready event, validate every registered model parameter root, and exercise an
  isolated default agent directory without the environment override.

## 0.1.3 - 2026-07-20

- Reissued the first public npm release from the immutable
  `pi-leetcode-tools-v0.1.3` tag after the `v0.1.2` one-time bootstrap stopped
  before publication. Version `0.1.2` remains an immutable source tag and
  CandidateRecord audit trail; it was not published to npm.
- Corrected the protected bootstrap and regular OIDC publish commands so npm
  receives the exact verified local tarball instead of interpreting its
  relative path as a Git locator, and added static plus real npm dry-run
  regression coverage for both downloaded bundle layouts.
- Preserved the `1.1.0` Tool contract, `1.0.0` RPC protocol, fourteen Pi tools,
  and complete 24/24 pinned reference-interface coverage from `0.1.2`.

## 0.1.2 - 2026-07-19

- Added fourteen model-facing `lc_*` Pi tools for LeetCode Global and CN,
  including public reads, authenticated progress/history/submission reads,
  answer-bearing solution reads, and recoverable run/submit operations.
- Completed semantic coverage of the pinned
  `@jinzcdev/leetcode-mcp-server@1.4.0` surface: 24/24 interfaces implemented as
  16 native-tool mappings, 5 Gateway capabilities, and 3 static contract
  resources, with source/packed conformance and independent adapter fixtures.
- Added the versioned discovery/RPC Gateway, canonical contract artifacts, and
  stable error/result envelopes for internal consumers.
- Added authenticated progress/history, run/submit operation recovery,
  confirmation, duplicate protection, and cross-process leases.
- Added opaque HMAC cursors and the CN NotesPort best-effort compare-and-set
  protocol.
- Added the local `pi-leetcode auth` login/import/status/list/use/doctor/logout
  workflow, verified regional credential import, OS credential-store
  persistence, recoverable profile replacement, active profiles, and
  environment-variable override support without exposing secrets as tool
  arguments.
- Hardened regional response normalization for observed production schema
  drift, including CN profile/solution fields, nullable Global daily topic-tag
  translations, and Global judge-output arrays. Global operation recovery now
  accepts both the current underscore-prefixed operation IDs and legacy
  hyphen-prefixed IDs.
- Added isolated package, Pi activation, supply-chain, SBOM, license, secret,
  and production dependency verification.
- Closed the independent-repository engineering matrix on Node 22.19.0 and
  24.18.0 with 27 test files / 275 tests, exact-artifact public reads, and full safe Global/CN
  account capability runs. The account matrix permanently skips real submit
  and Notes writes unless a separate write-specific flow is authorized.
- Hardened the npm release path into an unprivileged validation/build job, a
  minimal protected publish job, and an unprivileged registry verifier.
