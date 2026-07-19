import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startClosedRegistry } from "./closed-registry.mjs";
import {
  assert,
  digestPackageFiles,
  JCS_DIGEST_ALGORITHM,
  pathExists,
  readJson,
  resolveTarball,
  runCommand,
  sha256Bytes,
  sha256Jcs,
  terminateProcessTree,
  withExtractedPackage
} from "./release-utils.mjs";

// Existing fixtures remain valid. Safe fixtures now default to the complete
// non-permanent matrix; set fullMatrix:false to retain the legacy focused run.
// {
//   "region": "global" | "cn",
//   "titleSlug": "two-sum",
//   "language": "typescript",
//   "code": "...",
//   "testcase": "optional",
//   "run": true,
//   "submit": false,
//   "fullMatrix": true,
//   "notesTarget": "optional-title-slug",
//   "notesWriteContent": "legacy focused mode only; separately authorized"
// }

const FULL_MATRIX_TOOL_NAMES = [
  "lc_daily",
  "lc_search",
  "lc_problem",
  "lc_solution_search",
  "lc_solution",
  "lc_profile",
  "lc_contest",
  "lc_progress",
  "lc_history",
  "lc_user_submissions",
  "lc_submission",
  "lc_run",
  "lc_submit",
  "lc_operation_status"
];

const SAFE_MATRIX_RUN = {
  titleSlug: "two-sum",
  language: "python3",
  code:
    "class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for index, value in enumerate(nums):\n            complement = target - value\n            if complement in seen:\n                return [seen[complement], index]\n            seen[value] = index\n        return []",
  testcase: "[2,7,11,15]\n9"
};

assert(
  process.env.PI_LEETCODE_ALLOW_ACCOUNT_SMOKE === "1",
  "Account smoke is disabled. Set PI_LEETCODE_ALLOW_ACCOUNT_SMOKE=1 only for an approved manual run."
);

const fixturePath = process.env.PI_LEETCODE_ACCOUNT_SMOKE_FIXTURE;
assert(
  typeof fixturePath === "string" && fixturePath.length > 0,
  "PI_LEETCODE_ACCOUNT_SMOKE_FIXTURE must point to an approved JSON fixture"
);
const fixture = await readJson(resolve(fixturePath));
assert(
  fixture.region === "global" || fixture.region === "cn",
  "Account smoke fixture region must be global or cn"
);
assert(
  typeof fixture.titleSlug === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fixture.titleSlug),
  "Account smoke fixture has an invalid titleSlug"
);
assert(
  typeof fixture.language === "string" && /^[a-z0-9]+$/u.test(fixture.language),
  "Account smoke fixture has an invalid canonical language"
);
assert(
  typeof fixture.code === "string" && fixture.code.length > 0 && fixture.code.length <= 100_000,
  "Account smoke fixture code must contain 1..100000 characters"
);
assert(
  fixture.testcase === undefined || typeof fixture.testcase === "string",
  "Account smoke fixture testcase must be a string"
);
assert(
  fixture.submit === undefined || typeof fixture.submit === "boolean",
  "Account smoke fixture submit must be boolean"
);
assert(
  fixture.run === undefined || typeof fixture.run === "boolean",
  "Account smoke fixture run must be boolean"
);
assert(
  fixture.fullMatrix === undefined || typeof fixture.fullMatrix === "boolean",
  "Account smoke fixture fullMatrix must be boolean"
);
assert(
  fixture.notesWriteContent === undefined ||
    (typeof fixture.notesWriteContent === "string" &&
      Buffer.byteLength(fixture.notesWriteContent, "utf8") <= 16_384),
  "Account smoke fixture notesWriteContent exceeds 16384 UTF-8 bytes"
);
assert(
  fixture.notesTarget === undefined ||
    (typeof fixture.notesTarget === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(fixture.notesTarget)),
  "Account smoke fixture notesTarget must be a safe title slug"
);

const fullMatrix =
  fixture.fullMatrix ??
  (fixture.run !== false && fixture.submit !== true && fixture.notesWriteContent === undefined);

if (fullMatrix) {
  assert(
    fixture.submit !== true && fixture.notesWriteContent === undefined,
    "fullMatrix is permanently non-submit/non-notes-write; use fullMatrix:false for a separately authorized legacy write smoke"
  );
  assert(
    fixture.titleSlug === SAFE_MATRIX_RUN.titleSlug,
    "fullMatrix uses the fixed two-sum dependency chain"
  );
}

if (fixture.submit === true) {
  assert(
    process.env.PI_LEETCODE_ALLOW_REAL_SUBMIT === "1",
    "Real submit is disabled. PI_LEETCODE_ALLOW_REAL_SUBMIT=1 is required in addition to the account-smoke gate."
  );
}
if (fixture.notesWriteContent !== undefined) {
  assert(
    process.env.PI_LEETCODE_ALLOW_NOTES_WRITE === "1",
    "Notes write is disabled. PI_LEETCODE_ALLOW_NOTES_WRITE=1 is required in addition to the account-smoke gate."
  );
}

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = resolve(dirname(piEntry), "cli.js");
const piPackageJson = await readJson(resolve(dirname(piEntry), "..", "package.json"));
const tarball = await resolveTarball();
const { manifest, packedPackageJson, candidateContent } = await withExtractedPackage(
  tarball,
  async ({ packageDirectory }) => ({
    manifest: await readJson(join(packageDirectory, "contract", "manifest.json")),
    packedPackageJson: await readJson(join(packageDirectory, "package.json")),
    candidateContent: await digestPackageFiles(packageDirectory)
  })
);
const tarballBytes = await readFile(tarball);

assert(
  Array.isArray(manifest.tools) &&
    manifest.tools.length === FULL_MATRIX_TOOL_NAMES.length &&
    FULL_MATRIX_TOOL_NAMES.every((tool) => manifest.tools.includes(tool)),
  "Packed contract does not expose the exact 14-tool account matrix"
);
assert(
  manifest.behaviorDigestAlgorithm === JCS_DIGEST_ALGORITHM &&
    sha256Jcs(manifest.behaviorManifest) === manifest.behaviorManifestDigest,
  "Packed behavior manifest is invalid"
);
for (const language of new Set([
  fixture.language,
  ...(fullMatrix ? [SAFE_MATRIX_RUN.language] : [])
])) {
  assert(
    manifest.behaviorManifest.language?.canonicalIds?.includes(language),
    `Account smoke language ${language} is not a published canonical language ID`
  );
}
const maximumTestcaseBytes = manifest.behaviorManifest.testcase?.maximumUtf8Bytes;
assert(
  Number.isSafeInteger(maximumTestcaseBytes) && maximumTestcaseBytes > 0,
  "Packed behavior manifest has no valid testcase byte limit"
);
for (const testcase of [
  fixture.testcase,
  ...(fullMatrix ? [SAFE_MATRIX_RUN.testcase] : [])
]) {
  assert(
    testcase === undefined || Buffer.byteLength(testcase, "utf8") <= maximumTestcaseBytes,
    `Account smoke testcase exceeds ${maximumTestcaseBytes} UTF-8 bytes`
  );
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-tools-account-smoke-"));
const agentDirectory = join(temporaryDirectory, "agent");
const npmCache = join(temporaryDirectory, "npm-cache");
const npmUserConfig = join(temporaryDirectory, "npmrc");
const workingDirectory = join(temporaryDirectory, "workspace");
const probeExtension = join(temporaryDirectory, "account-smoke-probe.mjs");
const probeResult = join(temporaryDirectory, "account-smoke-result.json");
const evidenceGeneratedAt = new Date().toISOString();
const evidenceId = `${evidenceGeneratedAt.replace(/[:.]/gu, "-")}-${randomUUID()}`;
const evidencePath = join(
  dirname(tarball),
  `pi-leetcode-tools-account-smoke-evidence-${evidenceId}.json`
);
let registry;
let child;
let childExit;

try {
  await Promise.all([
    mkdir(agentDirectory, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(workingDirectory, { recursive: true }),
    writeFile(npmUserConfig, "audit=false\nfund=false\n", "utf8")
  ]);

  const probeFixture = {
    region: fixture.region,
    fullMatrix,
    titleSlug: fixture.titleSlug,
    language: fixture.language,
    code: fixture.code,
    ...(fixture.testcase === undefined ? {} : { testcase: fixture.testcase }),
    run: fixture.run !== false,
    submit: fixture.submit === true,
    notesTarget: fixture.notesTarget ?? fixture.titleSlug,
    ...(fixture.notesWriteContent === undefined
      ? {}
      : { notesWriteContent: fixture.notesWriteContent }),
    safeMatrixRun: SAFE_MATRIX_RUN
  };

  const probeSource = `
import { createHash, randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

const FIXTURE = ${JSON.stringify(probeFixture)};
const TOOL_NAMES = ${JSON.stringify(FULL_MATRIX_TOOL_NAMES)};
const ALLOWED_TOOLS = new Set(TOOL_NAMES);
const DISCOVERY_CHANNEL = ${JSON.stringify(manifest.discoveryChannel)};
const RPC_CHANNEL = ${JSON.stringify(manifest.rpcChannel)};
const READY_CHANNEL = "pi-leetcode-tools:ready:v1";
const PROTOCOL_VERSION = ${JSON.stringify(manifest.protocolVersion)};
const RESULT_PATH = process.env.PI_LEETCODE_ACCOUNT_SMOKE_RESULT;
const RPC_TIMEOUT_MS = 300_000;

function sha256(value) {
  return "sha256:" + createHash("sha256").update(String(value), "utf8").digest("hex");
}

function textEvidence(value) {
  if (typeof value !== "string") return { present: false, bytes: 0 };
  return {
    present: true,
    bytes: Buffer.byteLength(value, "utf8"),
    sha256: sha256(value)
  };
}

function optionalHash(value) {
  return typeof value === "string" && value.length > 0 ? sha256(value) : undefined;
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function safePage(data) {
  return compact({
    itemCount: Array.isArray(data?.items) ? data.items.length : undefined,
    total: Number.isSafeInteger(data?.page?.total) ? data.page.total : undefined,
    totalKind: data?.page?.totalKind,
    hasMore: typeof data?.page?.hasMore === "boolean" ? data.page.hasMore : undefined
  });
}

function safeNote(note) {
  return compact({
    noteIdHash: optionalHash(note?.id),
    questionIdHash: optionalHash(note?.noteQuestion?.questionId),
    summary: textEvidence(note?.summary),
    content: textEvidence(note?.content)
  });
}

export default function accountSmokeProbe(pi) {
  let settled = false;
  let running = false;
  let readyUnsubscribe;

  async function finish(payload) {
    if (settled) return;
    settled = true;
    readyUnsubscribe?.();
    const temporaryPath = RESULT_PATH + ".tmp-" + randomUUID();
    await writeFile(temporaryPath, JSON.stringify(payload), "utf8");
    await rename(temporaryPath, RESULT_PATH);
  }

  function discover() {
    return new Promise((resolve, reject) => {
      const requestId = "account-smoke-discover-" + randomUUID();
      let completed = false;
      function attempt() {
        if (completed) return;
        pi.events.emit(DISCOVERY_CHANNEL, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          respond(response) {
            if (completed || response?.requestId !== requestId) return;
            completed = true;
            clearInterval(retry);
            clearTimeout(timeout);
            resolve(response);
          }
        });
      }
      const retry = setInterval(attempt, 100);
      const timeout = setTimeout(() => {
        completed = true;
        clearInterval(retry);
        reject(new Error("DISCOVERY_TIMEOUT"));
      }, 20_000);
      attempt();
    });
  }

  function rpc(descriptor, method, params, label) {
    if (method === "tool.execute" && !ALLOWED_TOOLS.has(params?.tool)) {
      throw new Error("UNEXPECTED_TOOL");
    }
    const requestId = "account-smoke-" + label + "-" + randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("RPC_TIMEOUT")),
        RPC_TIMEOUT_MS + 5_000
      );
      pi.events.emit(RPC_CHANNEL, {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        providerId: descriptor.providerId,
        instanceId: descriptor.instanceId,
        contextRevision: descriptor.contextRevision,
        method,
        params,
        deadlineAt: Date.now() + RPC_TIMEOUT_MS,
        respond(response) {
          if (response?.requestId !== requestId) return;
          clearTimeout(timeout);
          resolve(response?.result);
        }
      });
    });
  }

  function safeDescriptor(descriptor) {
    return {
      toolCount: Array.isArray(descriptor?.tools) ? descriptor.tools.length : 0,
      tools: Array.isArray(descriptor?.tools)
        ? descriptor.tools.map((tool) => compact({
            name: tool?.name,
            supported: tool?.supported === true,
            configured: tool?.configured === true,
            currentlyAvailable: tool?.currentlyAvailable === true,
            requiresAuth: tool?.requiresAuth === true,
            consequence: tool?.consequence,
            reason: tool?.reason
          }))
        : [],
      activeAccountProfileIdHash: optionalHash(descriptor?.activeAccountProfileId),
      interactiveUI: descriptor?.interactiveUI === true,
      regionReadiness: descriptor?.regionReadiness,
      notesPort: descriptor?.notesPort
    };
  }

  async function runMatrix(descriptor) {
    const operations = [];
    const region = FIXTURE.region;

    function add(status, operation, operationRegion, details = {}) {
      const item = compact({
        operation,
        region: operationRegion,
        status,
        ok: status === "passed",
        ...details
      });
      operations.push(item);
      return item;
    }
    const pass = (operation, operationRegion, details) =>
      add("passed", operation, operationRegion, details);
    const fail = (operation, operationRegion, details) =>
      add("failed", operation, operationRegion, details);
    const skip = (operation, operationRegion, reason) =>
      add("skipped", operation, operationRegion, { skipped: true, reason });
    const block = (operation, operationRegion, reason) =>
      add("blocked", operation, operationRegion, { reason });

    async function call(method, params, operation, operationRegion, summarize, validate) {
      let result;
      try {
        result = await rpc(descriptor, method, params, operation.replaceAll(".", "-"));
      } catch {
        fail(operation, operationRegion, { errorCode: "PROTOCOL_TIMEOUT", retryable: true });
        return undefined;
      }
      if (result?.ok !== true) {
        fail(operation, operationRegion, {
          errorCode: result?.error?.code ?? "MALFORMED_RESULT",
          retryable: result?.error?.retryable === true
        });
        return undefined;
      }
      let details;
      try {
        details = summarize === undefined ? {} : summarize(result.data);
        if (validate !== undefined && !validate(result.data)) {
          fail(operation, operationRegion, {
            ...details,
            errorCode: "ACCOUNT_MATRIX_ASSERTION_FAILED",
            retryable: false
          });
          return undefined;
        }
      } catch {
        fail(operation, operationRegion, {
          errorCode: "MALFORMED_RESULT",
          retryable: false
        });
        return undefined;
      }
      pass(operation, operationRegion, details);
      return result.data;
    }

    pass("gateway.discovery", "both", {
      toolCount: descriptor.tools.length,
      activeAccountProfileIdHash: optionalHash(descriptor.activeAccountProfileId)
    });

    const notesCapabilities = await call(
      "notes.capabilities",
      {},
      "notes.capabilities",
      "both",
      (data) => ({
        global: data?.global,
        cn: data?.cn
      }),
      (data) => typeof data?.global === "object" && typeof data?.cn === "object"
    );

    const userStatus = await call(
      "user.status",
      { region },
      "user.status",
      region,
      (data) => ({
        signedIn: data?.isSignedIn === true,
        usernameHash: data?.isSignedIn === true ? optionalHash(data.username) : undefined
      }),
      (data) => data?.isSignedIn === true && typeof data?.username === "string"
    );
    const username = userStatus?.isSignedIn === true ? userStatus.username : undefined;

    if (username === undefined) {
      for (const operation of ["lc_profile", "lc_contest", "lc_user_submissions"]) {
        block(operation, region, "user.status-did-not-yield-username");
      }
    } else {
      await call(
        "tool.execute",
        { tool: "lc_profile", input: { region, username } },
        "lc_profile",
        region,
        (data) => ({
          usernameHash: optionalHash(data?.username),
          returnedFieldCount:
            data !== null && typeof data === "object" ? Object.keys(data).length : undefined
        }),
        (data) => typeof data?.username === "string"
      );
      await call(
        "tool.execute",
        {
          tool: "lc_contest",
          input: { region, username, attendedOnly: true, limit: 2, offset: 0 }
        },
        "lc_contest",
        region,
        (data) => ({
          usernameHash: optionalHash(data?.username),
          historyCount: Array.isArray(data?.history) ? data.history.length : undefined,
          rankingPresent: data?.ranking !== undefined
        }),
        (data) => Array.isArray(data?.history)
      );

      const modes = region === "global" ? ["recent", "accepted"] : ["accepted"];
      if (region === "cn") {
        skip("lc_user_submissions.recent", region, "contract-unsupported-on-cn");
      }
      for (const mode of modes) {
        await call(
          "tool.execute",
          { tool: "lc_user_submissions", input: { region, username, mode, limit: 2 } },
          "lc_user_submissions." + mode,
          region,
          (data) => ({
            usernameHash: optionalHash(data?.username),
            mode: data?.mode,
            ...safePage(data),
            firstSubmissionIdHash: optionalHash(data?.items?.[0]?.id)
          }),
          (data) => Array.isArray(data?.items)
        );
      }
    }

    await call(
      "tool.execute",
      { tool: "lc_daily", input: { region } },
      "lc_daily",
      region,
      (data) => ({
        problemTitleSlugHash: optionalHash(data?.problem?.titleSlug),
        datePresent: typeof data?.date === "string"
      }),
      (data) => typeof data?.problem?.titleSlug === "string"
    );

    const search = await call(
      "tool.execute",
      { tool: "lc_search", input: { region, query: "two sum", limit: 1, offset: 0 } },
      "lc_search",
      region,
      (data) => ({
        ...safePage(data),
        firstTitleSlugHash: optionalHash(data?.items?.[0]?.titleSlug)
      }),
      (data) => Array.isArray(data?.items)
    );
    const searchedProblem = search?.items?.find(
      (item) => item?.titleSlug === FIXTURE.safeMatrixRun.titleSlug
    ) ?? search?.items?.[0];
    let problem;
    if (searchedProblem?.titleSlug === undefined) {
      block("lc_problem", region, "lc_search-returned-no-problem");
    } else {
      problem = await call(
        "tool.execute",
        {
          tool: "lc_problem",
          input: { region, titleSlug: searchedProblem.titleSlug, includeResourcePayload: false }
        },
        "lc_problem",
        region,
        (data) => ({
          titleSlugHash: optionalHash(data?.titleSlug),
          questionIdHash: optionalHash(data?.questionId),
          snippetCount: Array.isArray(data?.codeSnippets) ? data.codeSnippets.length : undefined,
          defaultTestcase: textEvidence(data?.defaultTestcase)
        }),
        (data) =>
          typeof data?.titleSlug === "string" && typeof data?.questionId === "string"
      );
    }

    const solutionSearch = await call(
      "tool.execute",
      {
        tool: "lc_solution_search",
        input: {
          region,
          titleSlug: FIXTURE.safeMatrixRun.titleSlug,
          limit: 2,
          offset: 0,
          orderBy: "HOT",
          tags: []
        }
      },
      "lc_solution_search",
      region,
      (data) => ({
        ...safePage(data),
        visibleCount: Array.isArray(data?.items)
          ? data.items.filter((item) => item?.canSee === true).length
          : undefined
      }),
      (data) => Array.isArray(data?.items)
    );
    const visibleSolution = solutionSearch?.items?.find((item) =>
      item?.canSee === true &&
      (region === "global"
        ? typeof item?.topicId === "string" && item.topicId.length > 0
        : typeof item?.slug === "string" && item.slug.length > 0)
    );
    if (visibleSolution === undefined) {
      block("lc_solution", region, "lc_solution_search-returned-no-visible-identifier");
    } else {
      await call(
        "tool.execute",
        {
          tool: "lc_solution",
          input:
            region === "global"
              ? { region, topicId: visibleSolution.topicId }
              : { region, slug: visibleSolution.slug }
        },
        "lc_solution",
        region,
        (data) => ({
          topicIdHash: optionalHash(data?.topicId),
          slugHash: optionalHash(data?.slug),
          content: textEvidence(data?.content),
          tagCount: Array.isArray(data?.tags) ? data.tags.length : undefined
        }),
        (data) => typeof data?.content === "string"
      );
    }

    await call(
      "tool.execute",
      { tool: "lc_progress", input: { region, limit: 2, offset: 0 } },
      "lc_progress",
      region,
      (data) => safePage(data),
      (data) => Array.isArray(data?.items)
    );

    const history = await call(
      "tool.execute",
      { tool: "lc_history", input: { region, scope: "account", limit: 2, offset: 0 } },
      "lc_history",
      region,
      (data) => ({
        ...safePage(data),
        firstSubmissionIdHash: optionalHash(data?.items?.[0]?.id)
      }),
      (data) => Array.isArray(data?.items)
    );
    const submissionId = history?.items?.find(
      (item) => typeof item?.id === "string" && /^[0-9]+$/.test(item.id)
    )?.id;
    if (submissionId === undefined) {
      block("lc_submission.no-code", region, "lc_history-returned-no-submission-id");
      block("lc_submission.include-code", region, "lc_history-returned-no-submission-id");
    } else {
      await call(
        "tool.execute",
        {
          tool: "lc_submission",
          input: { region, submissionId, includeCode: false }
        },
        "lc_submission.no-code",
        region,
        (data) => ({
          submissionIdHash: optionalHash(data?.id),
          codePresent: typeof data?.code === "string",
          state: data?.status
        }),
        (data) => typeof data?.id === "string" && data?.code === undefined
      );
      await call(
        "tool.execute",
        {
          tool: "lc_submission",
          input: { region, submissionId, includeCode: true }
        },
        "lc_submission.include-code",
        region,
        (data) => ({
          submissionIdHash: optionalHash(data?.id),
          codePresent: typeof data?.code === "string",
          code: textEvidence(data?.code),
          state: data?.status
        }),
        (data) => typeof data?.id === "string" && typeof data?.code === "string" && data.code.length > 0
      );
    }

    const run = await call(
      "tool.execute",
      {
        tool: "lc_run",
        input: {
          region,
          titleSlug: FIXTURE.safeMatrixRun.titleSlug,
          language: FIXTURE.safeMatrixRun.language,
          code: FIXTURE.safeMatrixRun.code,
          testcase: FIXTURE.safeMatrixRun.testcase,
          timeoutMs: 120_000,
          pollIntervalMs: 1_000
        }
      },
      "lc_run",
      region,
      (data) => ({
        operationIdHash: optionalHash(data?.operationId),
        state: data?.state,
        verdict: data?.result?.verdict,
        errorCode: data?.errorCode
      }),
      (data) => typeof data?.operationId === "string" && data?.state === "completed"
    );
    if (run?.operationId === undefined) {
      block("lc_operation_status", region, "lc_run-did-not-yield-operation-id");
    } else {
      await call(
        "tool.execute",
        { tool: "lc_operation_status", input: { operationId: run.operationId } },
        "lc_operation_status",
        region,
        (data) => ({
          operationIdHash: optionalHash(data?.operationId),
          state: data?.state,
          verdict: data?.result?.verdict,
          errorCode: data?.errorCode
        }),
        (data) =>
          typeof data?.operationId === "string" &&
          sha256(data.operationId) === sha256(run.operationId) &&
          data?.state === "completed"
      );
    }

    skip("lc_submit", region, "permanent-external-write-not-authorized-in-full-matrix");

    if (region === "global") {
      for (const operation of ["notes.read", "notes.search", "notes.get"]) {
        skip(operation, region, "contract-unsupported-on-global");
      }
    } else {
      const cnNotes = notesCapabilities?.cn;
      if (cnNotes?.supported !== true || cnNotes?.configured !== true) {
        block("notes.read", region, "notes-capability-not-configured");
        block("notes.search", region, "notes-capability-not-configured");
        block("notes.get", region, "notes-capability-not-configured");
      } else {
        await call(
          "notes.read",
          { region: "cn", target: FIXTURE.safeMatrixRun.titleSlug },
          "notes.read",
          region,
          (data) => ({
            targetHash: optionalHash(data?.target),
            content: textEvidence(data?.content),
            revisionPresent: data?.revision !== null && data?.revision !== undefined,
            revisionMode: data?.revisionMode
          }),
          (data) => typeof data?.content === "string"
        );

        const noteSearch = await call(
          "notes.search",
          { region: "cn", limit: 1, skip: 0, orderBy: "DESCENDING" },
          "notes.search",
          region,
          (data) => ({
            noteCount: Array.isArray(data?.notes) ? data.notes.length : undefined,
            totalCount: data?.pagination?.totalCount,
            firstNote: Array.isArray(data?.notes) && data.notes.length > 0
              ? safeNote(data.notes[0])
              : undefined
          }),
          (data) => Array.isArray(data?.notes)
        );
        const questionId =
          noteSearch?.notes?.find((note) => typeof note?.noteQuestion?.questionId === "string")
            ?.noteQuestion?.questionId ?? problem?.questionId;
        if (typeof questionId !== "string" || !/^[0-9]+$/.test(questionId)) {
          block("notes.get", region, "no-note-or-problem-question-id");
        } else {
          await call(
            "notes.get",
            { region: "cn", questionId, limit: 1, skip: 0 },
            "notes.get",
            region,
            (data) => ({
              questionIdHash: optionalHash(data?.questionId),
              noteCount: Array.isArray(data?.notes) ? data.notes.length : undefined,
              firstNote: Array.isArray(data?.notes) && data.notes.length > 0
                ? safeNote(data.notes[0])
                : undefined
            }),
            (data) => Array.isArray(data?.notes)
          );
        }
      }
    }
    skip("notes.write", region, "permanent-external-write-not-authorized-in-full-matrix");
    skip("notes.create", region, "permanent-external-write-not-authorized-in-full-matrix");
    skip("notes.update", region, "permanent-external-write-not-authorized-in-full-matrix");

    await call(
      "diagnostics.getSnapshot",
      {},
      "diagnostics.getSnapshot",
      "both",
      (data) => ({
        providerConflict: data?.providerConflict === true,
        storageWritable: data?.storageWritable === true,
        activeAccountProfileIdHash: optionalHash(data?.activeAccountProfileId),
        snapshotRevision: data?.snapshotRevision,
        regions: data?.regions
      }),
      (data) =>
        data?.providerConflict === false &&
        typeof data?.regions?.global === "object" &&
        typeof data?.regions?.cn === "object"
    );

    return {
      operations,
      summary: {
        passed: operations.filter((item) => item.status === "passed").length,
        failed: operations.filter((item) => item.status === "failed").length,
        blocked: operations.filter((item) => item.status === "blocked").length,
        skipped: operations.filter((item) => item.status === "skipped").length
      }
    };
  }

  async function runLegacy(descriptor) {
    const operations = [];
    const region = FIXTURE.region;

    async function call(method, params, operation, summarize) {
      let result;
      try {
        result = await rpc(descriptor, method, params, operation.replaceAll(".", "-"));
      } catch {
        operations.push({ operation, region, status: "failed", ok: false, errorCode: "PROTOCOL_TIMEOUT", retryable: true });
        return undefined;
      }
      if (result?.ok !== true) {
        operations.push({
          operation,
          region,
          status: "failed",
          ok: false,
          errorCode: result?.error?.code ?? "MALFORMED_RESULT",
          retryable: result?.error?.retryable === true
        });
        return undefined;
      }
      const details = summarize === undefined ? {} : summarize(result.data);
      operations.push({ operation, region, status: "passed", ok: true, ...details });
      return result.data;
    }

    await call(
      "tool.execute",
      { tool: "lc_progress", input: { region, titleSlug: FIXTURE.titleSlug, limit: 1 } },
      "lc_progress",
      safePage
    );
    await call(
      "tool.execute",
      { tool: "lc_history", input: { region, scope: "problem", titleSlug: FIXTURE.titleSlug, limit: 1 } },
      "lc_history",
      safePage
    );

    if (FIXTURE.run) {
      const run = await call(
        "tool.execute",
        {
          tool: "lc_run",
          input: compact({
            region,
            titleSlug: FIXTURE.titleSlug,
            language: FIXTURE.language,
            code: FIXTURE.code,
            testcase: FIXTURE.testcase,
            timeoutMs: 120_000,
            pollIntervalMs: 1_000
          })
        },
        "lc_run",
        (data) => ({
          operationIdHash: optionalHash(data?.operationId),
          state: data?.state,
          verdict: data?.result?.verdict,
          errorCode: data?.errorCode
        })
      );
      if (run?.operationId !== undefined) {
        await call(
          "tool.execute",
          { tool: "lc_operation_status", input: { operationId: run.operationId } },
          "lc_operation_status",
          (data) => ({
            operationIdHash: optionalHash(data?.operationId),
            state: data?.state,
            verdict: data?.result?.verdict,
            errorCode: data?.errorCode
          })
        );
      }
    } else {
      operations.push({ operation: "lc_run", region, status: "skipped", ok: false, skipped: true, reason: "disabled-by-fixture" });
    }

    const noteCapabilities = await call(
      "notes.capabilities",
      {},
      "notes.capabilities",
      (data) => ({ global: data?.global, cn: data?.cn })
    );
    const regionalNotes = noteCapabilities?.[region];
    let noteRead;
    if (regionalNotes?.supported === true && regionalNotes?.configured === true) {
      noteRead = await call(
        "notes.read",
        { region, target: FIXTURE.notesTarget },
        "notes.read",
        (data) => ({
          targetHash: optionalHash(data?.target),
          content: textEvidence(data?.content),
          revisionPresent: data?.revision !== null && data?.revision !== undefined,
          revisionMode: data?.revisionMode
        })
      );
      if (FIXTURE.notesWriteContent !== undefined && noteRead !== undefined) {
        await call(
          "notes.write",
          {
            region,
            target: FIXTURE.notesTarget,
            content: FIXTURE.notesWriteContent,
            expectedRevision: noteRead.revision
          },
          "notes.write",
          (data) => ({
            targetHash: optionalHash(data?.target),
            content: textEvidence(data?.content),
            revisionPresent: data?.revision !== null && data?.revision !== undefined
          })
        );
      }
    } else {
      operations.push({ operation: "notes.read", region, status: "skipped", ok: false, skipped: true, reason: regionalNotes?.reason ?? "not-supported-or-configured" });
    }

    if (FIXTURE.submit) {
      await call(
        "tool.execute",
        {
          tool: "lc_submit",
          input: {
            region,
            titleSlug: FIXTURE.titleSlug,
            language: FIXTURE.language,
            code: FIXTURE.code,
            timeoutMs: 120_000,
            pollIntervalMs: 1_000
          }
        },
        "lc_submit",
        (data) => ({
          operationIdHash: optionalHash(data?.operationId),
          state: data?.state,
          verdict: data?.result?.verdict,
          errorCode: data?.errorCode
        })
      );
    } else {
      operations.push({ operation: "lc_submit", region, status: "skipped", ok: false, skipped: true, reason: "not-authorized-by-fixture" });
    }

    return {
      operations,
      summary: {
        passed: operations.filter((item) => item.status === "passed").length,
        failed: operations.filter((item) => item.status === "failed").length,
        blocked: 0,
        skipped: operations.filter((item) => item.status === "skipped").length
      }
    };
  }

  async function execute() {
    if (running || settled) return;
    running = true;
    try {
      const discovery = await discover();
      const descriptor = discovery?.descriptor;
      if (
        discovery?.protocolVersion !== PROTOCOL_VERSION ||
        descriptor?.protocolVersion !== PROTOCOL_VERSION ||
        typeof descriptor?.providerId !== "string" ||
        typeof descriptor?.instanceId !== "string" ||
        !Number.isSafeInteger(descriptor?.contextRevision) ||
        !Array.isArray(descriptor?.tools) ||
        descriptor.tools.length !== TOOL_NAMES.length ||
        !TOOL_NAMES.every((name) => descriptor.tools.some((tool) => tool?.name === name))
      ) {
        throw new Error("PROVIDER_CONTRACT_MISMATCH");
      }

      const matrix = FIXTURE.fullMatrix
        ? await runMatrix(descriptor)
        : await runLegacy(descriptor);
      const ok = matrix.summary.failed === 0 && matrix.summary.blocked === 0;
      await finish({
        ok,
        mode: FIXTURE.fullMatrix ? "full-safe-matrix" : "legacy-focused",
        region: FIXTURE.region,
        capabilities: safeDescriptor(descriptor),
        operations: matrix.operations,
        summary: matrix.summary,
        ...(ok
          ? {}
          : {
              failure: {
                operation: "account-matrix",
                errorCode: "ACCOUNT_MATRIX_INCOMPLETE"
              }
            })
      });
    } catch {
      await finish({
        ok: false,
        mode: FIXTURE.fullMatrix ? "full-safe-matrix" : "legacy-focused",
        region: FIXTURE.region,
        capabilities: { toolCount: 0, tools: [] },
        operations: [],
        summary: { passed: 0, failed: 1, blocked: 0, skipped: 0 },
        failure: { operation: "harness", errorCode: "LOCAL_PROBE_ERROR" }
      });
    }
  }

  readyUnsubscribe = pi.events.on(READY_CHANNEL, () => void execute());
  pi.on("session_start", () => void execute());
  pi.on("session_shutdown", () => readyUnsubscribe?.());
}
`;
  await writeFile(probeExtension, probeSource, "utf8");

  registry = await startClosedRegistry({
    candidateTarball: tarball,
    candidatePackageJson: packedPackageJson,
    candidateBytes: tarballBytes,
    directory: temporaryDirectory
  });
  await writeFile(
    npmUserConfig,
    `registry=${registry.origin}\naudit=false\nfund=false\nupdate-notifier=false\n`,
    "utf8"
  );

  const baseEnvironment = {
    ...process.env,
    NODE_PATH: "",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_REGISTRY: registry.origin,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_TELEMETRY: "0"
  };

  const packageSpec = `npm:${manifest.packageName}@${manifest.packageVersion}`;
  await runCommand(process.execPath, [piCli, "install", packageSpec], {
    cwd: workingDirectory,
    env: baseEnvironment,
    stdio: "inherit"
  });
  registry.assertNoUnexpectedRequests();

  const installedPackageDirectory = join(
    agentDirectory,
    "npm",
    "node_modules",
    ...manifest.packageName.split("/")
  );
  const installedPackageJson = await readJson(join(installedPackageDirectory, "package.json"));
  assert(
    installedPackageJson.name === manifest.packageName &&
      installedPackageJson.version === manifest.packageVersion,
    "Account smoke installed a package other than the candidate"
  );
  const installedContent = await digestPackageFiles(
    installedPackageDirectory,
    candidateContent.files.map((file) => file.path)
  );
  assert(
    installedContent.digest === candidateContent.digest,
    "Account smoke installed files do not match the candidate tarball"
  );

  child = spawn(
    process.execPath,
    [
      piCli,
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-builtin-tools",
      "--tools",
      FULL_MATRIX_TOOL_NAMES.join(","),
      "--extension",
      probeExtension,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve"
    ],
    {
      cwd: workingDirectory,
      env: {
        ...baseEnvironment,
        PI_OFFLINE: "1",
        PI_LEETCODE_ACCOUNT_SMOKE_RESULT: probeResult
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  childExit = new Promise((resolvePromise) => child.once("exit", resolvePromise));

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-32_768);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-32_768);
  });

  const deadline = Date.now() + 20 * 60_000;
  while (!(await pathExists(probeResult)) && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Pi exited before account-smoke evidence (code ${child.exitCode}); stderr=${JSON.stringify(stderr.trim())}; stdout=${JSON.stringify(stdout.trim())}`
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  assert(await pathExists(probeResult), "Account smoke timed out without evidence");

  const result = JSON.parse(await readFile(probeResult, "utf8"));
  assert(Array.isArray(result.operations), "Account smoke returned no operation evidence");
  const executedRun = fullMatrix ? SAFE_MATRIX_RUN : probeFixture;
  const evidence = {
    schemaVersion: "2.0.0",
    evidenceType: "approved-account-smoke",
    generatedAt: evidenceGeneratedAt,
    subject: {
      name: manifest.packageName,
      version: manifest.packageVersion,
      file: basename(tarball),
      bytes: tarballBytes.length,
      sha512: registry.candidateSha512,
      distIntegrity: registry.candidateIntegrity,
      packageContentDigest: installedContent.digest
    },
    authorization: {
      accountSmoke: true,
      mode: fullMatrix ? "full-safe-matrix" : "legacy-focused",
      realSubmit: !fullMatrix && fixture.submit === true,
      notesWrite: !fullMatrix && fixture.notesWriteContent !== undefined,
      permanentWritesSkipped: fullMatrix
    },
    fixture: {
      region: fixture.region,
      titleSlugSha256: sha256Bytes(Buffer.from(executedRun.titleSlug, "utf8")),
      language: executedRun.language,
      codeBytes: Buffer.byteLength(executedRun.code, "utf8"),
      codeSha256: sha256Bytes(Buffer.from(executedRun.code, "utf8")),
      ...(executedRun.testcase === undefined
        ? {}
        : {
            testcaseBytes: Buffer.byteLength(executedRun.testcase, "utf8"),
            testcaseSha256: sha256Bytes(Buffer.from(executedRun.testcase, "utf8"))
          }),
      ...(!fullMatrix && fixture.notesTarget !== undefined
        ? {
            notesTargetSha256: sha256Bytes(Buffer.from(probeFixture.notesTarget, "utf8"))
          }
        : {}),
      ...(!fullMatrix && fixture.notesWriteContent !== undefined
        ? {
            notesContentBytes: Buffer.byteLength(fixture.notesWriteContent, "utf8"),
            notesContentSha256: sha256Bytes(
              Buffer.from(fixture.notesWriteContent, "utf8")
            )
          }
        : {})
    },
    environment: {
      piVersion: piPackageJson.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    registry: {
      mode: "closed-allowlist",
      upstreamFallbackAllowed: false,
      prefetchedPackages: registry.prefetchedPackages,
      requests: registry.requests.length,
      unexpectedRequests: 0
    },
    capabilities: result.capabilities,
    contract: {
      contractVersion: manifest.contractVersion,
      protocolVersion: manifest.protocolVersion,
      schemaDigest: manifest.schemaDigest,
      behaviorDigestAlgorithm: manifest.behaviorDigestAlgorithm,
      behaviorManifestDigest: manifest.behaviorManifestDigest,
      capabilityManifestDigest: manifest.capabilityManifestDigest
    },
    result: {
      ok: result.ok === true,
      mode: result.mode,
      region: result.region,
      summary: result.summary,
      operations: result.operations,
      ...(result.failure === undefined ? {} : { failure: result.failure })
    }
  };
  const temporaryEvidence = `${evidencePath}.tmp-${randomUUID()}`;
  await writeFile(temporaryEvidence, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rename(temporaryEvidence, evidencePath);
  registry.assertNoUnexpectedRequests();
  assert(result.ok === true, `Account smoke failed; evidence: ${evidencePath}`);
  console.log(`Approved account smoke verified; evidence: ${evidencePath}`);
} finally {
  try {
    await terminateProcessTree(child);
    await Promise.race([
      childExit ?? Promise.resolve(),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
    ]);
  } finally {
    try {
      await registry?.close();
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      });
    }
  }
}
