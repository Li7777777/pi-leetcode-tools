# Changelog

All notable changes to this repository are documented here. Package versions
follow Semantic Versioning independently from the versioned Tool contract and
event protocol.

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
