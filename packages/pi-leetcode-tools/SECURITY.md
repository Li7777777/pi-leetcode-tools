# Security policy

`pi-leetcode-tools` handles authenticated LeetCode requests and remote code
execution. Security reports are welcome, including issues that do not expose a
traditional CVE but could cross an account, confirmation, credential, or
operation-recovery boundary.

## Supported versions

Security fixes target the latest released minor line. Older `0.x` versions may
require an upgrade rather than a backport.

## Report a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion,
prompt transcript, or log. Use the repository host's private vulnerability
reporting feature when available. If it is unavailable, contact the maintainers
through the private channel associated with the repository or package
ownership, and request a secure reporting route before sending sensitive
details.

Include the package version, Pi and Node versions, region, affected tool, a
minimal reproduction, and the security impact. Remove all cookies, CSRF values,
source code, note content, operation IDs, account identifiers, and response
bodies unless the maintainers explicitly provide a secure transfer method.
Use synthetic canaries wherever possible.

The maintainers should acknowledge a private report, reproduce and scope it,
coordinate a fix and release, then agree on public disclosure. No response-time
or bounty commitment is implied by this document.

## Assets and security properties

The design protects these assets:

- Global and CN session and CSRF cookie values.
- User source code, testcase input, judge output, and managed note content.
- The integrity and account binding of run/submit operation records.
- The user's ability to decide whether a formal submission or note write occurs.
- Tool schemas, capability evidence, and RPC routing identity used by package
  consumers.
- The integrity and reviewability of the published npm tarball and its actual
  production dependency closure.

The intended properties are fail-closed behavior at confirmation, contract,
provider, cursor, storage, and release boundaries; regional and profile
isolation; and no persistence of raw credentials or source code in the
operation journal.

## Trust boundaries

1. **User and Pi UI.** Only the active Tools extension may bridge Pi's current
   `ctx.ui.confirm` into a submission or note write. Model output and RPC input
   are untrusted and cannot stand in for user confirmation.
2. **Pi host process.** Pi, its extension loader, other installed extensions,
   the current OS user, and process environment are trusted to the extent that
   they can already read or modify this extension and its secrets. This package
   does not sandbox a malicious co-resident extension.
3. **Internal event/RPC bus.** Requests are untrusted until provider identity,
   instance, context revision, protocol version, method payload, and deadline
   checks pass. Multiple active providers cause a conflict instead of an
   arbitrary winner.
4. **Local filesystem.** `${PI_CODING_AGENT_DIR}/leetcode-tools` is trusted for
   durability but not confidentiality beyond OS permissions. Journal and lock
   files may be stale, corrupt, copied, rolled back, or concurrently accessed.
5. **LeetCode network boundary.** Requests leave the machine for fixed Global
   or CN HTTPS endpoints. LeetCode responses are untrusted, size-limited,
   normalized, and may change schema or report an ambiguous outcome.
6. **Package supply chain.** Repository sources, npm dependencies, CI actions,
   the final tarball, and release metadata are separate evidence surfaces. A
   workspace test does not by itself prove the contents or production tree of
   the tarball that will be published.

## Threats and mitigations

### Credential disclosure and cross-account confusion

- Credentials come from a complete region-specific environment bundle or the
  local OS credential store and are never valid tool-call parameters. A half
  environment bundle shadows the store and fails closed; values are never
  combined across sources. Environment variables take precedence, so CI can
  override a stored local profile without modifying it.
- `pi-leetcode auth login` uses an isolated temporary Edge/Chrome profile.
  Passwords, CAPTCHA, MFA, and federated-login material remain in the browser;
  the CLI extracts only the resulting regional session and CSRF cookies. The
  temporary profile is deleted on every exit path, and cookie values are never
  printed.
- `pi-leetcode auth import` opens the default browser but does not inspect its
  Cookie DB, password vault, history, debugging port, clipboard, extensions, or
  other domains. Both cookie values are accepted only from hidden prompts on a
  visible TTY; argv, piped stdin, and environment-variable transfer are not an
  import channel.
- Login/import sessions are checked with a bounded read-only status request
  to the fixed regional endpoint before keyring mutation. Credential, profile
  index, active pointer, and random epoch updates are recoverable as one local
  transaction, so a rejected probe or write failure preserves the prior bundle.
- Stored cookies inherit the confidentiality and access-control guarantees of
  the current operating system's credential service. A process running as the
  same OS user may still be able to request them; this is not a sandbox boundary.
- The native backend uses Windows Credential Manager, macOS Keychain, or Linux
  Secret Service. If it is unavailable, the package returns the stable
  `credential_store_unavailable` reason and never falls back to plaintext JSON,
  `.env`, or a project/home-directory credential file.
- Capability metadata reports only whether values are configured; it does not
  return the values.
- Redaction covers known cookie, authorization, CSRF, credential, code, and
  token fields. Logging uses a fixed metadata allowlist and is silent by
  default.
- Profile IDs are non-secret namespaces. Operation storage is partitioned by a
  SHA-256 namespace derived from profile and region, and authenticated history
  cursors are profile-bound.
- A non-secret profile index and random mutation epoch support list/use/logout
  and credential-rotation observation. The process-local revision fingerprint
  is HMAC-keyed with an ephemeral key and is never returned or persisted; only
  its monotonic counter is exposed to context invalidation logic.
- The package does not protect environment variables from the host process,
  debuggers, crash dumps, shell history, or another extension running with the
  same privileges. Use a dedicated OS account or stronger process isolation
  when that threat matters.

### Unauthorized or replayed writes

- Every `lc_submit` and NotesPort write requires a fresh confirmation callback
  owned by the active Tools session. Headless sessions fail with
  `INTERACTION_REQUIRED`.
- Confirmation displays region, provider instance/context, account profile
  when available, target, language, and a content/code hash rather than raw
  secrets.
- RPC callers cannot serialize or provide a confirmation function. Stale
  instances, context revisions, deadlines, and incompatible protocols are
  rejected.
- CN note updates use compare-before-write plus post-write verification, but
  LeetCode does not provide an atomic revision primitive. The result is
  explicitly best-effort compare-and-set and must not be used as a general
  transaction or secret store.

### Duplicate or ambiguous remote operations

- Run and submit intent is durably recorded before remote dispatch; the remote
  ID is persisted before polling.
- A timeout, abort, socket failure, or uncertain response after dispatch moves
  the record to `unknown` rather than claiming failure or cancellation.
- Identical unresolved submissions are blocked. Retrying an unknown submission
  requires the exact prior operation ID, matching content hash and target
  context, and another user confirmation.
- Deleting, rolling back, or copying the operation journal can defeat recovery
  and duplicate protection. Storage integrity is fail-closed on malformed
  records, but this version does not provide an authenticated or encrypted
  journal.

### Cursor tampering and confused pagination

- Opaque cursors are HMAC-SHA256 authenticated, expire after 15 minutes, and
  have a 1,000-character limit.
- They bind the tool, region, query fingerprint, offset, optional remote cursor,
  and authenticated profile where applicable.
- Signing keys are in-memory and instance-local. Cursors intentionally stop
  working after restart or in another instance; they are not durable bearer
  tokens.

### Upstream and content attacks

- Remote responses are treated as data and normalized into bounded DTOs.
  Unexpected shapes fail with `REMOTE_SCHEMA_CHANGED` rather than flowing
  unchecked into callers.
- Problem HTML is converted to text. Consumers must still treat all problem,
  judge, and note content as untrusted prompt/data input and must not follow
  instructions embedded in it as authority.
- Code and testcase input are intentionally transmitted to LeetCode by
  `lc_run`/`lc_submit`. Do not send proprietary or secret material.
- Rate limiting and timeouts reduce accidental abuse but do not guarantee
  service availability or compliance with third-party policy.

### Malicious or substituted release artifacts

- The packed-file verifier uses an allowlist, rejects links and traversal,
  bounds file count and size, and requires this `SECURITY.md` in the final
  tarball.
- The supply-chain verifier scans the extracted tarball for recognized secret
  formats using an in-repository scanner. It does not silently skip because an
  optional external scanner is absent.
- The final tarball is installed with lifecycle scripts disabled into an empty
  directory. The resulting production tree must be complete, non-extraneous,
  registry-spec based, and covered by the license policy.
- A CycloneDX SBOM and JSON release-evidence record are generated from that
  actual installed tree and bound to the tarball SHA-256.
- CI actions must use full commit SHAs. The verifier records those pins in the
  evidence file and fails on mutable action tags.

These controls reduce, but do not eliminate, registry compromise, malicious
dependency code, compromised maintainer credentials, or a compromised CI
runner. Release approval must still verify provenance and publish the same
tested tarball rather than rebuilding it.

## Out of scope and known limitations

- Vulnerabilities in LeetCode itself, account recovery, anti-bot systems, or
  policy enforcement, unless this package makes them materially worse.
- Protection from a compromised OS, Pi runtime, maintainer account, npm
  registry, or co-resident extension with equivalent privileges.
- Confidentiality of operation metadata on disk; the journal is not encrypted.
- Exactly-once semantics from LeetCode. `unknown` is a deliberate representation
  of uncertainty, not a transactional guarantee.
- Atomic CN NotesPort compare-and-set; the upstream API does not expose it.
- Long-lived pagination cursors or compatibility across runtime restarts.

## Operator checklist

- Use separate `PI_LEETCODE_PROFILE_ID` values for separate accounts.
- Keep `PI_CODING_AGENT_DIR` private, durable, and backed up as appropriate.
- Do not install multiple copies of the provider in the same Pi session.
- Rotate leaked cookies, then restart Pi so the credential context is
  rediscovered.
- Resolve `unknown` operations before deleting storage or changing profiles.
- Pin internal consumers to a verified package/contract/protocol tuple.
- Before publication, review the generated SBOM and evidence record and publish
  the exact tarball whose SHA-256 they contain.
