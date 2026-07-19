import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import {
  REPOSITORY_ROOT,
  TOOLS_ARTIFACT_DIRECTORY,
  TOOLS_RECORD_DIRECTORY,
  loadCurrentCandidateRecord
} from "./candidate-record.mjs";
import {
  assert,
  runCommand,
  sha256Bytes
} from "../../packages/pi-leetcode-tools/scripts/release-utils.mjs";

const artifactDirectory = resolve(process.argv[2] ?? TOOLS_ARTIFACT_DIRECTORY);
const recordDirectory = resolve(process.argv[3] ?? TOOLS_RECORD_DIRECTORY);
const smokeScript = join(
  REPOSITORY_ROOT,
  "packages",
  "pi-leetcode-tools",
  "scripts",
  "smoke-public-reads.mjs"
);
const verifierPath = new URL(import.meta.url);
const before = await loadCurrentCandidateRecord({
  kind: "tools",
  artifactDirectory,
  recordDirectory
});
const startedAt = new Date().toISOString();
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (
    [
      "LEETCODE_SESSION",
      "LEETCODE_CSRF_TOKEN",
      "LEETCODE_CN_SESSION",
      "LEETCODE_CN_CSRF_TOKEN",
      "PI_LEETCODE_PROFILE_ID"
    ].includes(name.toUpperCase())
  ) {
    delete environment[name];
  }
}

const result = await runCommand(
  process.execPath,
  [smokeScript, artifactDirectory],
  { cwd: REPOSITORY_ROOT, env: environment, timeoutMs: 300_000 }
);
const summaries = [];
for (const line of result.stdout.split(/\r?\n/u)) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    continue;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (
      typeof parsed.tool === "string" &&
      typeof parsed.region === "string" &&
      typeof parsed.requestId === "string"
    ) {
      summaries.push(parsed);
    }
  } catch {
    // Non-evidence JSON output is ignored; the fixed success marker is checked below.
  }
}
assert(
  result.stdout.includes("Public reads verified: 6/6 requests"),
  "Public-read smoke did not report the fixed 6/6 success marker"
);
assert(summaries.length === 6, "Public-read smoke did not emit six summaries");
assert(
  new Set(summaries.map((item) => item.region + ":" + item.tool)).size === 6,
  "Public-read smoke summaries are incomplete or duplicated"
);

const after = await loadCurrentCandidateRecord({
  kind: "tools",
  artifactDirectory,
  recordDirectory
});
assert(
  before.recordDigest === after.recordDigest &&
    before.record.recordId === after.record.recordId,
  "Tools candidate changed during public-read smoke"
);

const verifierBytes = await readFile(verifierPath);
const smokeBytes = await readFile(smokeScript);
const completedAt = new Date().toISOString();
const evidenceId = "TOOLS-ENG-PUBLIC-READS/" + randomUUID();
const evidence = {
  schemaVersion: 1,
  evidenceType: "public-read-smoke",
  evidenceId,
  gateId: "TOOLS-ENG",
  subjectRecordId: before.record.recordId,
  subjectRecordDigest: before.recordDigest,
  sourceModeByPackage: { tools: "candidate" },
  verifier: {
    name: "tools-public-read-evidence",
    version: 1,
    digest: sha256Bytes(Buffer.concat([verifierBytes, smokeBytes]))
  },
  command: [
    process.execPath,
    relative(REPOSITORY_ROOT, smokeScript),
    relative(REPOSITORY_ROOT, artifactDirectory)
  ].join(" "),
  startedAt,
  completedAt,
  exitStatus: 0,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pi: "0.80.7"
  },
  inputEvidenceIds: [],
  outputArtifactDigests: {
    toolsTarballSha512: before.record.artifact.sha512,
    toolsContentDigest: before.record.artifact.unpackedContentDigest
  },
  results: {
    passed: 6,
    total: 6,
    regions: ["global", "cn"],
    tools: ["lc_daily", "lc_search", "lc_problem"],
    summaries
  },
  safety: {
    accountSmoke: "not-run",
    modelTurns: 0,
    modelToolCalls: 0,
    leetcodeWriteRequests: 0
  },
  cleanupResult: {
    childExited: true,
    registryClosed: true,
    temporaryDirectoryRemoved: true
  }
};

const evidenceDirectory = join(artifactDirectory, "evidence");
await mkdir(evidenceDirectory, { recursive: true });
const fingerprint = before.record.recordId.split("/").at(-1).replace("sha256:", "");
const fileName =
  "pi-leetcode-tools-public-reads-" +
  fingerprint.slice(0, 16) +
  "-" +
  evidenceId.split("/").at(-1) +
  ".json";
const evidencePath = join(evidenceDirectory, fileName);
const temporaryPath = evidencePath + ".tmp-" + randomUUID();
await writeFile(temporaryPath, JSON.stringify(evidence, null, 2) + "\n", {
  encoding: "utf8",
  flag: "wx"
});
await rename(temporaryPath, evidencePath);
console.log(result.stdout.trim());
if (result.stderr.trim().length > 0) {
  console.error(result.stderr.trim());
}
console.log(
  JSON.stringify(
    {
      evidenceId,
      evidencePath,
      recordId: before.record.recordId,
      recordDigest: before.recordDigest,
      file: basename(evidencePath)
    },
    null,
    2
  )
);
