# pi-leetcode-tools

[![npm version](https://img.shields.io/npm/v/pi-leetcode-tools?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-leetcode-tools)
[![npm downloads](https://img.shields.io/npm/dm/pi-leetcode-tools?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/pi-leetcode-tools)
[![CI](https://img.shields.io/github/actions/workflow/status/Li7777777/pi-leetcode-tools/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/Li7777777/pi-leetcode-tools/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Tests](https://img.shields.io/badge/tests-283%20passing-2ea44f?style=flat-square)
[![MCP parity](https://img.shields.io/badge/MCP%20parity-24%2F24-7c3aed?style=flat-square)](#reference-mcp-interface-parity)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Li7777777/pi-leetcode-tools?style=flat-square&logo=github)](https://github.com/Li7777777/pi-leetcode-tools/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/Li7777777/pi-leetcode-tools?branch=main&style=flat-square&logo=git&logoColor=white)](https://github.com/Li7777777/pi-leetcode-tools/commits/main)
[![LINUX DO - Where possible begins](https://raw.githubusercontent.com/Li7777777/cpa-key-hub/main/.github/assets/linux-do-community-badge.svg)](https://linux.do)

[简体中文](./README.zh-CN.md)

Unofficial native Pi tool calls for LeetCode Global and LeetCode CN.

The package exposes fourteen Pi tools:

| Tool | Purpose | Authentication |
| --- | --- | --- |
| `lc_daily` | Read the daily challenge | No |
| `lc_search` | Search and page through problems by category/tag/difficulty/text | No |
| `lc_problem` | Read a problem and code snippets | No |
| `lc_solution_search` | List a bounded page of answer-bearing community solutions | No |
| `lc_solution` | Read one full answer-bearing community solution article | No |
| `lc_profile` | Read a public user's normalized profile | No |
| `lc_contest` | Read a public user's contest ranking and bounded history | No |
| `lc_progress` | Read account progress | Session |
| `lc_history` | Read account-wide or per-problem submission history | Session |
| `lc_user_submissions` | Read a public user's recent/accepted submissions | No |
| `lc_submission` | Read one submission; source code requires explicit `includeCode=true` | Session |
| `lc_run` | Execute code remotely without a formal submission | Session + CSRF |
| `lc_submit` | Submit code after Pi-owned UI confirmation | Session + CSRF |
| `lc_operation_status` | Recover or refresh a recorded run/submit operation | Session + CSRF |

## Quick start

Install the package through Pi and start a fresh interactive session:

```bash
pi install npm:pi-leetcode-tools
pi list
pi
```

The extension loads automatically. Ask Pi in natural language, or name a tool
when you want deterministic selection:

```text
Use lc_daily to show today's LeetCode CN challenge.
Use lc_search to find medium array problems on LeetCode Global.
Use lc_problem to read two-sum on CN and show the C++ snippet.
Use lc_progress to summarize my CN account progress.
```

The first three examples are public reads. `lc_progress`, `lc_history`,
`lc_submission`, `lc_run`, `lc_submit`, and `lc_operation_status` require the
matching regional account credentials. Sign in with the local authentication
CLI:

```bash
pi-leetcode auth login --region cn --profile personal-cn
```

Pi keeps package executables in its managed npm prefix, which is not always on
the shell `PATH`. If `pi-leetcode` is not found, run it through that prefix.

macOS/Linux:

```bash
npm exec --prefix "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm" -- \
  pi-leetcode auth login --region cn --profile personal-cn
```

Windows PowerShell:

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$HOME\.pi\agent" }
npm exec --prefix "$agentDir\npm" -- pi-leetcode auth login --region cn --profile personal-cn
```

Use `auth import` instead of `auth login` when the isolated browser cannot pass
the site challenge and you need the system default browser. After logging in or
switching profiles, start a new Pi session. `lc_submit` is available only in an
interactive session and always requires a fresh Pi-owned UI confirmation. See
[Credentials and profiles](#credentials-and-profiles) for the complete flow.

If an installed resource is disabled, run `pi config`, enable it, and start a
new Pi session.

## Verification

`pi-leetcode-tools@0.1.4` implements all 24 pinned reference interfaces as 16
native-tool mappings, 5 Gateway capabilities, and 3 static contract resources,
with no partial, missing, superseded, or explicitly unsupported mapping.

| Capability class | Current evidence |
| --- | --- |
| Contract and upstream parity | Source 344/344, packed 344/344, packed target resolution 24/24, and independent adapter/Gateway/resource fixtures 24/24 pass |
| Package verification | Typecheck, 29 test files / 283 tests, packed install, 14-tool Pi activation, and local supply-chain checks pass on Node 22.19.0 and 24.18.0 |
| Public-read smoke tests | Global/CN daily, search, and problem reads pass 6/6 |
| Authenticated safe matrix | Global passes 19 operations and CN passes 21 operations with zero failures; the matrix covers all region-supported safe reads plus `lc_run -> lc_operation_status` |
| Write safeguards | The safe matrix forcibly skips `lc_submit` and Notes create/update/write unless a separate, explicitly authorized interactive verification is running |

LeetCode is a third-party service. API behavior can change without notice,
and using this package does not exempt you from LeetCode's terms or rate
limits.

<a id="upstream-interface-parity"></a>

## Reference MCP interface parity

The package is checked against the pinned `@jinzcdev/leetcode-mcp-server@1.4.0`
surface: 19 MCP tools and 5 MCP resources. The package ships the immutable
inventory in `upstream/reference-surface.json` and the current semantic mapping
in `upstream/parity.json`. Verification does not trust that inventory alone: it
checks the pinned npm tgz receipt (size, SHA-256 and SHA-512 integrity), extracts
the registrations offline, and requires the extracted Tool/Resource names, URI
templates, and input fields to match the declared surface exactly.
Because the MCP implementation delegates most GraphQL behavior to
`leetcode-query`, the semantic surface independently pins
`leetcode-query@2.0.1` by tgz integrity, `lib/index.js` digest, and the digest
of its 19 embedded GraphQL queries. A compatible version range is not accepted
as semantic evidence.
The default archive path is
`.artifacts/upstream-reference/jinzcdev-leetcode-mcp-server-1.4.0.tgz` at the
workspace root; CI may pass `--reference-tarball <path>` after provisioning the
same receipt. A missing archive is a hard failure, and the verifier never
fetches or silently substitutes network state.

Use the report command while implementing gaps:

```bash
npm run verify:upstream-parity:report --workspace pi-leetcode-tools
```

The strict source precheck and final source-plus-packed completeness checks are:

```bash
npm run verify:tools:upstream-completeness:source
npm run verify:tools:upstream-completeness
```

The strict command fails unless every upstream interface is implemented as a
validated `native_tool`, `gateway_capability`, or `static_contract_resource`.
`missing`, `partial`, `superseded`, and `explicitly_unsupported` mappings all
block completion. Each implemented mapping must separately verify eight
semantic dimensions: input schema/field map, output schema, authentication and
subject scope, regional endpoint/operation, capability and side effect,
pagination/defaults, sensitive-data controls, and normalized error semantics.
Stable per-interface/per-variant case IDs, deterministic source/packed execution
receipts, packed JavaScript behavior probes, and exact README anchors are
mandatory evidence in addition to those eight dimensions. A test file that
merely contains some `test`/`it` call is not parity evidence. Missing receipts,
missing or duplicate cases, non-passed cases, stale runner/target/reference
digests, and packed JavaScript that cannot resolve all 24 targets fail closed.
Version `0.1.4` maps all 24 pinned interfaces and passes the strict source and
packed completeness gates: 344/344 conformance cases in each form, 24/24 packed
JavaScript target resolution, and 24/24 independent actual
adapter/Gateway/static-resource fixtures.

Ordinary `npm pack --dry-run --workspace pi-leetcode-tools` keeps the non-strict
report behavior. Release packaging and `npm publish` run the strict gate; an
incomplete package cannot be published.

<a id="upstream-search-problems"></a>
<a id="upstream-get-daily-challenge"></a>
<a id="upstream-get-problem"></a>
<a id="upstream-problem-detail"></a>
<a id="upstream-problem-categories"></a>
<a id="upstream-problem-tags"></a>
<a id="upstream-problem-langs"></a>

The generated `contract/catalogs.json` artifact is the versioned source for
the pinned upstream problem categories, problem tags, and language identifiers.
`lc_search` defaults to category `all-code-essentials`, accepts only cataloged
categories/tags, uses a 10-item default page, and maps canonical difficulty and
keyword fields to the regional query. Run/submit language conversion and the
published language resource use the same registry, including `cangjie`.

`lc_daily` returns the UTC invocation date plus a strict, region-specific copy
of the complete pinned daily payload. `lc_problem` returns the simplified MCP
projection, including all hints, the first three similar questions, and the
C++/Python3/Java snippets. Setting `includeResourcePayload=true` additionally
returns the complete pinned `problem://{titleSlug}` payload through an explicit
bounded schema with `additionalProperties:false`; unknown future fields are not
forwarded to the model.

<a id="upstream-run-code"></a>
<a id="upstream-submit-solution"></a>

## Run and submit parity

`lc_run` and `lc_submit` cover the pinned MCP's Global and CN
`interpret_solution -> check` and `submit -> check` flows. Their renamed input
fields are `lang -> language`, `typedCode -> code`, and (for runs)
`dataInput -> testcase`. All 20 upstream language slugs are accepted;
`golang` is normalized to the package's canonical `go` ID and mapped back to
`golang` on the wire. Omitting the operation controls uses the pinned upstream
defaults `timeoutMs=120000` and `pollIntervalMs=1500`. Positive sub-second
values are accepted; polling still applies the upstream 200 ms effective
minimum. The package keeps a 120-second total timeout and 5-second requested
poll ceiling as explicit resource-safety bounds.

The originating successful call returns `questionId`, the complete bounded
start JSON object, the fixed HTTPS `checkUrl`, and the complete bounded terminal
check JSON object in addition to the normalized operation/result fields. These
two upstream objects are transient (`persistence=never`): they are recursively
bounded, rejected if they contain source, credential, prototype-pollution, or
other forbidden fields, and never enter the operation journal, logs, or release
evidence. Later `lc_operation_status` and duplicate-result reads intentionally
return the durable minimal normalized result rather than replaying transient
judge output. This preserves recovery and deduplication without persisting code,
testcases, stdout, expected output, or diagnostics.

When `lc_run.testcase` is omitted, the adapter resolves and sends the problem's
exact public `sampleTestCase` bytes. This is the package's fail-closed equivalent
of the upstream empty `data_input` default: a problem with no public default is
rejected before dispatch instead of guessing or sending an ambiguous empty
testcase. `lc_submit` retains the per-call Pi UI confirmation, durable dispatch
intent, duplicate protection, explicit unknown retry, and explicit completed
resubmission rules described below.

<a id="upstream-get-user-profile"></a>
<a id="upstream-get-user-contest-ranking"></a>
<a id="upstream-get-problem-progress"></a>

## Public profile and contest reads

`lc_profile` and `lc_contest` accept an explicit public username and never use
the active account as an implicit subject. Both support Global and CN;
`lc_profile` includes the Global submission totals and the CN accepted, failed,
untouched, social-account, skill-topic, and topic-area-score facets from the
pinned query. `lc_contest` includes Global badge and regional trend fields,
defaults to attended contests, and provides exact 50-record offset pages so the
complete upstream history remains accessible without an unbounded model
response. The one upstream GraphQL response is still protected by the shared
2 MiB transport limit and a fail-closed 2,000-record normalization ceiling.

`lc_progress` uses the upstream defaults `offset=0` and `limit=100`, echoes the
normalized question-status and difficulty filters, and exposes the exact
progress-question facets. It deliberately does not invent a `questionId` or
`paidOnly` value that the upstream progress query did not return.

<a id="upstream-get-user-status"></a>

Authenticated session identity is available only through the non-model
`user.status` Gateway RPC. It defaults to Global, accepts an optional region,
and returns a canonical account slug plus a separate CN display name when
signed in. It is intentionally not registered as an `lc_*` model tool.

<a id="upstream-list-problem-solutions"></a>
<a id="upstream-get-problem-solution"></a>
<a id="upstream-problem-solution"></a>

## Answer-bearing solution reads

`lc_solution_search` lists a bounded page of community solution metadata for
one problem, and `lc_solution` reads exactly one article by Global `topicId` or
CN `slug`. Both are public reads but are classified as `answer_read` with
`disclosureRisk=solution`. They run only after an explicit caller request; the
package does not prefetch, bulk crawl, cache, log, persist, or place solution
summaries/content in evidence. Returned article text is untrusted third-party
content. Calling applications should expose these tools only after an explicit
user request to read solution material.

<a id="upstream-search-notes"></a>
<a id="upstream-get-note"></a>
<a id="upstream-create-note"></a>
<a id="upstream-update-note"></a>

## Personal Notes Gateway

The non-model `notes.search`, `notes.get`, `notes.create`, and `notes.update`
Gateway RPC methods expose the current authenticated CN account's arbitrary
personal notes separately from the revisioned state NotesPort.
Search/get default to bounded `limit=10` and `skip=0`; search also defaults to
`DESCENDING`. Create/update require a fresh Pi-owned UI confirmation for every
call, never automatically retry, and return `UNKNOWN_WRITE_OUTCOME` when a
remote write cannot be safely verified. Note content, titles, and keywords are
never logged or stored in evidence; confirmation displays only byte counts and
SHA-256 digests.

## Requirements and compatibility

- Node.js `>=22.19.0`.
- The currently verified Pi runtime is `@earendil-works/pi-coding-agent@0.80.7`.
- Package `0.1.4` publishes contract `1.1.0` and RPC protocol `1.0.0`.
- Public JavaScript imports are limited to `pi-leetcode-tools/embedded`,
  `pi-leetcode-tools/types`, and `pi-leetcode-tools/contract`. Package-root and
  `dist/` imports are intentionally blocked.

Consumers must discover the active provider and compare the package version,
contract version, protocol version, schema digest, and capability-manifest
digest before calling it. A mismatch must be treated as incompatible, not
guessed around. Loading more than one provider instance is also rejected with
`PROVIDER_CONFLICT` until only one remains.

## Install, update, and remove

Install the npm `latest` release for Pi:

```bash
pi install npm:pi-leetcode-tools@latest
pi list
```

Use `-l` with `pi install` or `pi remove` for project-local settings. Update
and removal use the same source recorded at installation:

```bash
pi update npm:pi-leetcode-tools
pi remove npm:pi-leetcode-tools
```

Release artifacts are validated through a closed temporary registry that binds
`dist.integrity` to the selected tgz, followed by a new Pi process activation
probe. A bare local tgz is useful for ordinary npm production-tree audits, but
Pi 0.80.7 does not treat it as authoritative Pi Package activation evidence.

Removing the extension does not promise to delete its durable operation
journal. Review the storage section before cleaning that data.

## Credentials and profiles

Public daily, search, and problem reads need no credentials. Authenticated
tools resolve credentials from environment variables first, then from the
operating-system credential store. Credentials are never accepted as tool
arguments.

The local authentication CLI has a fixed command surface:

```bash
pi-leetcode auth login --region global --profile personal-global
pi-leetcode auth status --profile personal-global
pi-leetcode auth list
pi-leetcode auth use --profile personal-global
pi-leetcode auth doctor --profile personal-global
```

Use `--region cn` for LeetCode China. The command launches an isolated local
Edge or Chrome profile and waits for the user to finish LeetCode's normal login
flow. Passwords, CAPTCHA, MFA, and third-party sign-in remain in the browser.
Only the resulting session and CSRF cookies are saved in the OS credential
store. The temporary browser profile is deleted after success, timeout, browser
closure, or failure.

If an isolated browser cannot pass a site challenge, use the explicit fallback:

```bash
pi-leetcode auth import --region cn --profile personal-cn
```

`auth import` opens the system default browser but never scans its Cookie DB,
password vault, history, extensions, debugging port, clipboard, or any other
domain. After sign-in, it reads `LEETCODE_SESSION` and `csrftoken` only from two
hidden prompts in the local visible terminal. Piped input and non-TTY execution
fail with `auth_tty_required`; secrets are not accepted in argv or printed.

Both login paths run a bounded, read-only status probe against the fixed region
endpoint before changing the keyring. Existing credentials are not overwritten
unless `--force` is supplied. A replacement updates the credential record,
non-secret profile index, active pointer, and credential epoch as one recoverable
transaction; a probe or keyring failure preserves the old bundle. A successful
login/import selects the profile. Profile IDs use 1–128 characters from
`A-Z a-z 0-9 . _ : -`, matching the capability/RPC identifier grammar.

To remove a saved login:

```bash
pi-leetcode auth logout --region global --profile personal-global
```

`auth logout` removes exactly one profile/region bundle. If this removes the
active profile's final bundle, the CLI selects `default` when it exists,
otherwise the lexicographically first remaining profile, or clears the stored
pointer so runtime selection returns to the unconfigured `default` namespace.
It never leaves an active pointer to a deleted profile.

`auth status` and `auth list` emit only `profile`, `region`, `source`,
`configured`, `operationReady`, `active`, and safe verification/expiry state.
They never display cookie content, length, digest, keyring account names, or a
remote username. `auth use` changes only the non-secret stored active pointer.
An explicit `PI_LEETCODE_PROFILE_ID` remains the effective runtime selection and
is reported as `auth_profile_overridden_by_environment`. `auth doctor` performs
a new read-only probe and returns stable reason codes for missing, partial,
expired, rejected, region-mismatched, unavailable, or malformed authentication;
its exit code is `0` only when every inspected region is healthy and `2` when a
diagnostic issue was found.

Environment variables remain supported for CI and headless deployments. Source
priority is a complete environment bundle, then the same profile/region bundle
in the OS credential store, then unconfigured. A half environment bundle
shadows the keyring and fails closed with `auth_environment_bundle_partial`; it
is never combined with a stored value.

| Region | Session cookie value | CSRF cookie value |
| --- | --- | --- |
| Global (`global`) | `LEETCODE_SESSION` | `LEETCODE_CSRF_TOKEN` |
| China (`cn`) | `LEETCODE_CN_SESSION` | `LEETCODE_CN_CSRF_TOKEN` |

Set values before starting Pi. Use your shell's secret-management facilities;
the placeholders below are not literal values:

```bash
export LEETCODE_SESSION='<session-cookie-value>'
export LEETCODE_CSRF_TOKEN='<csrf-cookie-value>'
export PI_LEETCODE_PROFILE_ID='personal-global'
```

PowerShell equivalent:

```powershell
$env:LEETCODE_CN_SESSION = '<session-cookie-value>'
$env:LEETCODE_CN_CSRF_TOKEN = '<csrf-cookie-value>'
$env:PI_LEETCODE_PROFILE_ID = 'personal-cn'
```

`PI_LEETCODE_PROFILE_ID` is a non-secret local namespace, defaulting to
`default`. Give different LeetCode accounts different stable profile IDs. The
profile ID partitions operation journals and locks, binds authenticated
cursors, and appears in non-secret capability metadata. Reusing one profile ID
for different accounts can make operation recovery ambiguous; changing it can
make old operations and cursors unavailable from the new profile.

Runtime credential providers observe active-profile changes and expose a
process-local monotonic credential revision. The revision advances when the
profile, presence, or secret bytes change without exposing or persisting a
token-derived digest. Consumers use it to invalidate old context, cursors,
confirmations, and undispatched write intents after rotation.

After `auth use`, login replacement, import, or logout changes the effective
profile, start a new Pi session (or perform an explicit provider rediscovery)
before continuing authenticated work. The current runtime increments
`contextRevision` immediately, so stale cursors and confirmations fail closed;
the revisioned NotesPort also keeps its original account binding and rejects a
hot-switched profile until the runtime is recreated. This prevents note
writes from crossing account boundaries.

The native keyring backend maps to Windows Credential Manager, macOS Keychain,
and Linux Secret Service. If the platform service is absent or locked, commands
fail deterministically with `credential_store_unavailable`. There is no fallback
to plaintext JSON, `.env`, the project directory, or a home-directory secret
file. Keyring index and epoch entries contain only profile IDs, regions, boolean
readiness, safe timestamps, and a random mutation revision—not Cookie material.

Treat session and CSRF values like passwords. Do not paste them into prompts,
tool arguments, source files, logs, issue reports, or committed `.env` files.
Rotate them immediately if exposed. The package redacts known credential and
code fields from its safe logging path, but it cannot protect secrets disclosed
outside that path.

## Interactive and headless use

`lc_submit` always requires a confirmation created by the currently active
Tools extension through Pi's own interactive UI. An RPC caller cannot supply or
forge that confirmation callback. In `--print`, RPC-only, or any other session
without UI, submission fails closed with `INTERACTION_REQUIRED`.

Read tools, `lc_run`, and `lc_operation_status` can operate without UI when
their credential requirements are met. `lc_run` still sends code to LeetCode
for remote execution, so call it only for code the user intends to execute.

The internal NotesPort follows the same boundary: CN note writes require
Tools-owned UI confirmation; Global notes are unsupported. CN notes are limited
to 16 KiB and use best-effort compare-and-set rather than a server-native atomic
revision primitive.

## Durable operations and `unknown` recovery

Runs and submissions are journaled before dispatch. A returned state of
`unknown` means the remote outcome could not be proven. It does **not** mean the
request failed, and blindly sending the same submission can create a duplicate.

For an `unknown` operation:

1. Keep its `operationId` and call `lc_operation_status` with that ID.
2. If LeetCode can now answer, the record advances to `polling`, `completed`, or `failed`.
3. If a submission remains `unknown`, retry only after the user accepts the
   duplicate-submission risk. Send the exact same region, problem, language,
   and code to `lc_submit` with `retryUnknownOperationId` set to the old ID.
4. Approve the new interactive confirmation. The new record links the old one
   through `supersedesOperationId`.

A mismatched retry reference is rejected with `STALE_OPERATION`. Identical
pending or unresolved submissions are blocked. A normal `lc_submit` matching a
retained completed operation returns the previous result; deliberately sending
the same code again requires `resubmitCompletedOperationId`, another explicit
confirmation, and creates a new record linked by `repeatsOperationId`.
Cancellation after remote dispatch may still produce `unknown`; local
cancellation is not proof that LeetCode cancelled the request.

## Storage

Durable state is stored below:

```text
<resolved-pi-agent-directory>/leetcode-tools/
  operations/<sha256(profile-id + region)>/operations.json
  locks/
```

Run/submit durability uses Pi's resolved agent directory: `~/.pi/agent` by
default, or the directory selected by `PI_CODING_AGENT_DIR` when that optional
override is set. Deployments that override it must preserve the same directory
across restarts. Embedded SDK hosts with a custom agent directory can pass the
matching `storageDirectory` option to `createLeetCodeToolsRuntime`.

The operation journal stores IDs, state transitions, remote IDs, timestamps,
problem/language metadata, results, and a SHA-256 code hash. Its persistence
policy rejects source code, testcase content, credentials, cookies, CSRF
tokens, and confirmation tokens. The journal is not encrypted, so protect the
agent directory with normal OS account permissions and backups appropriate for
the metadata it contains.

Do not delete the journal while operations are pending or `unknown`; doing so
removes the evidence used for recovery and duplicate-submit protection. Before
manual cleanup, resolve or explicitly abandon those operations and stop every
Pi process using the same profile directory.

<a id="upstream-get-all-submissions"></a>

## Submission history and detail

`lc_history` reads the authenticated account. Use `scope: "account"` without a
`titleSlug` for account-wide history, or `scope: "problem"` with a
`titleSlug` for one problem. LeetCode CN additionally supports canonical
`language` and `status: "accepted" | "wrong_answer"` filters. Global rejects
those CN-only filters instead of filtering a single remote page locally.

<a id="upstream-get-recent-submissions"></a>
<a id="upstream-get-recent-ac-submissions"></a>

`lc_user_submissions` is public and requires an explicit `username`. Global
supports `mode: "recent"` and `mode: "accepted"`; CN supports accepted-only
public history. Results are a bounded recent window, not a complete account
history.

<a id="upstream-get-problem-submission-report"></a>

`lc_submission` is an authenticated sensitive read. It returns bounded judge
metadata for one numeric `submissionId`. Source code is omitted by default and
is requested from LeetCode only when the caller explicitly sets
`includeCode: true`. Returned code and judge output are untrusted sensitive
content and are never written to the operation journal, Notes, diagnostics, or
release evidence.

## Pagination cursors

`lc_search` and `lc_history` return opaque HMAC-SHA256 cursors. A cursor is at
most 1,000 characters, expires after 15 minutes, and is bound to its tool,
region, query fingerprint, and pagination position. History cursors are also
bound to the credential profile.

The signing key is runtime-local. Cursors are therefore intentionally not
portable across Pi restarts, provider instances, profile changes, or package
upgrades. Never parse, edit, persist long-term, or share a cursor. On
`STALE_CURSOR`, restart pagination without the old cursor.

## Authentication CLI reason codes

CLI failures are printed as `pi-leetcode [reason_code]: safe message`. Scripts
should use the bracketed code and must not parse browser/keyring native text.

| Code | Meaning / operator action |
| --- | --- |
| `credentials_already_exist` | The exact profile/region already exists; choose a new profile or explicitly use `--force`. |
| `auth_environment_bundle_partial` | Only one environment credential is present or a value is malformed; supply both or clear both. |
| `auth_tty_required` / `auth_import_cancelled` | Import needs a visible hidden-input terminal, or the local prompt was cancelled. |
| `auth_browser_unavailable` / `auth_browser_closed` / `auth_login_timeout` | The isolated browser could not start, was closed, or did not finish in time. |
| `auth_probe_rejected` / `auth_expired` | LeetCode did not accept the session; sign in again without overwriting the old bundle until probe succeeds. |
| `auth_region_mismatch` | The imported session redirected away from the selected Global/CN origin; verify the region and copied cookies. |
| `auth_probe_timeout` / `auth_probe_unavailable` | The bounded read-only verification could not complete; retry later. |
| `credential_store_unavailable` | The OS keyring/secret service is absent, locked, or denied; enable it. No plaintext fallback is used. |
| `credential_store_corrupt` | The non-secret profile index, active pointer, or epoch is malformed; inspect/repair the local keyring entries. |
| `credential_store_rollback_failed` | A keyring write failed and recovery also failed; stop and inspect with `auth doctor` before further replacement. |

## Result and error handling

Every tool returns a structured success or failure envelope. On failure, use
`error.code`, honor `retryable`, wait for `retryAfterMs` when present, and retain
`operationId` when supplied. Do not retry solely from the human-readable
message.

| Code | Meaning / caller action |
| --- | --- |
| `VALIDATION_ERROR` | Input violates the published schema; fix the request. |
| `AUTH_REQUIRED` | Required regional credentials are absent. |
| `AUTH_EXPIRED` | The configured session is no longer accepted; rotate it. |
| `PERMISSION_DENIED` | The account or upstream policy refused the action. |
| `INTERACTION_REQUIRED` | A trusted Pi UI confirmation is required. |
| `NOT_FOUND` | The problem or locally journaled operation was not found. |
| `RATE_LIMITED` | Back off and honor `retryAfterMs` when provided. |
| `REMOTE_UNAVAILABLE` | LeetCode or the network is temporarily unavailable. |
| `EXECUTION_FAILED` | The tool/runtime could not complete the operation safely; inspect `retryable` and the operation state. Judge verdicts such as WA/TLE remain successful business results. |
| `UNSUPPORTED_REGION` | The requested region is not supported. |
| `STALE_OPERATION` | The operation is duplicate, terminal, mismatched, or needs an explicit unknown retry reference. |
| `STALE_CURSOR` | The opaque cursor is expired, invalid, or bound to another context. |
| `UNKNOWN_WRITE_OUTCOME` | A Notes write may have succeeded but could not be verified; read before deciding whether to retry, and never auto-replay it. |
| `CANCELLED` | Local work was cancelled; dispatched remote work may still be `unknown`. |
| `CAPABILITY_UNAVAILABLE` | The runtime, storage, credentials, or regional capability is unavailable. |
| `REMOTE_SCHEMA_CHANGED` | LeetCode's response no longer matches the adapter; upgrade or report it. |
| `PROVIDER_CONFLICT` | More than one Tools provider is active; remove the duplicate. |
| `CONTRACT_MISMATCH` | Package/consumer contract evidence does not match; do not call across it. |
| `PROTOCOL_TIMEOUT` | An internal RPC request missed its deadline; rediscover context before retrying. |

## Security and release evidence

See [SECURITY.md](./SECURITY.md) for the threat model and private reporting
guidance. Published artifacts are checked from the final `.tgz`, including its
file allowlist, required security notice, built-in secret scan, actual isolated
production dependency tree, license policy, and generated CycloneDX SBOM and
release-evidence record.

## Local development

```bash
npm ci
npm run typecheck
npm test
npm run build
pi -e ./packages/pi-leetcode-tools
```
