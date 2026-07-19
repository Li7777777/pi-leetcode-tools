import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const ACCOUNT_EVIDENCE_PREFIX =
  "pi-leetcode-tools-account-smoke-evidence-";
const ACCOUNT_EVIDENCE_SUFFIX = ".json";
const DEFAULT_SMOKE_SCRIPT = join(
  REPOSITORY_ROOT,
  "packages",
  "pi-leetcode-tools",
  "scripts",
  "smoke-account.mjs"
);

function candidateArtifactPath(artifactDirectory, candidate) {
  const file = candidate.record.artifact?.file;
  assert(
    typeof file === "string" &&
      file.length > 0 &&
      basename(file) === file &&
      file.toLowerCase().endsWith(".tgz"),
    "Tools CandidateRecord has an unsafe artifact path"
  );
  return join(artifactDirectory, file);
}

function assertCandidateIdentityStable(before, after) {
  assert(
    before.record.recordId === after.record.recordId &&
      before.recordDigest === after.recordDigest,
    "Tools candidate changed during account smoke"
  );
  assert(
    before.record.artifact.file === after.record.artifact.file &&
      before.record.artifact.bytes === after.record.artifact.bytes &&
      before.record.artifact.sha256 === after.record.artifact.sha256,
    "Tools candidate artifact identity changed during account smoke"
  );
}

function parseEvidencePath(stdout, artifactDirectory, existingEvidenceFiles) {
  const matches = [
    ...stdout.matchAll(
      /^Approved account smoke verified; evidence: (?<path>.+)$/gmu
    )
  ];
  assert(
    matches.length === 1 && typeof matches[0].groups?.path === "string",
    "Account smoke did not report exactly one evidence path"
  );
  const evidencePath = resolve(matches[0].groups.path.trim());
  const evidenceFile = basename(evidencePath);
  assert(
    relative(artifactDirectory, evidencePath) === evidenceFile &&
      evidenceFile.startsWith(ACCOUNT_EVIDENCE_PREFIX) &&
      evidenceFile.endsWith(ACCOUNT_EVIDENCE_SUFFIX),
    "Account smoke reported an evidence path outside the Tools artifact directory"
  );
  assert(
    !existingEvidenceFiles.has(evidenceFile),
    "Account smoke reused a pre-existing evidence path"
  );
  return evidencePath;
}

async function findNewEvidencePath(
  artifactDirectory,
  existingEvidenceFiles,
  readdirImpl
) {
  const newEvidenceFiles = (await readdirImpl(artifactDirectory)).filter(
    (file) =>
      file.startsWith(ACCOUNT_EVIDENCE_PREFIX) &&
      file.endsWith(ACCOUNT_EVIDENCE_SUFFIX) &&
      !existingEvidenceFiles.has(file)
  );
  assert(
    newEvidenceFiles.length === 1,
    `Interactive account smoke produced ${newEvidenceFiles.length} new evidence files instead of one`
  );
  return resolve(artifactDirectory, newEvidenceFiles[0]);
}

async function bindEvidence({
  evidencePath,
  candidate,
  artifactSha256,
  readFileImpl,
  writeFileImpl,
  renameImpl,
  rmImpl
}) {
  const evidence = JSON.parse(await readFileImpl(evidencePath, "utf8"));
  assert(
    evidence.schemaVersion === "2.0.0" &&
      evidence.evidenceType === "approved-account-smoke",
    "Account smoke emitted an unsupported evidence document"
  );
  assert(
    evidence.subject?.name === candidate.record.subject.packageName &&
      evidence.subject?.version === candidate.record.subject.packageVersion &&
      evidence.subject?.file === candidate.record.artifact.file &&
      evidence.subject?.bytes === candidate.record.artifact.bytes &&
      evidence.subject?.sha512 === candidate.record.artifact.sha512 &&
      evidence.subject?.distIntegrity ===
        candidate.record.artifact.distIntegrity &&
      evidence.subject?.packageContentDigest ===
        candidate.record.artifact.unpackedContentDigest,
    "Account smoke evidence subject does not match the locked Tools candidate"
  );
  assert(
    evidence.candidate === undefined,
    "Raw account smoke evidence unexpectedly contains a candidate binding"
  );

  const boundEvidence = {
    ...evidence,
    candidate: {
      recordId: candidate.record.recordId,
      recordDigest: candidate.recordDigest,
      artifactSha256
    }
  };
  const temporaryPath = `${evidencePath}.binding-${randomUUID()}`;
  try {
    await writeFileImpl(
      temporaryPath,
      `${JSON.stringify(boundEvidence, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await renameImpl(temporaryPath, evidencePath);
  } finally {
    await rmImpl(temporaryPath, { force: true }).catch(() => undefined);
  }
  return boundEvidence;
}

export async function runAccountSmokeEvidence(options = {}) {
  const artifactDirectory = resolve(
    options.artifactDirectory ?? TOOLS_ARTIFACT_DIRECTORY
  );
  const recordDirectory = resolve(
    options.recordDirectory ?? TOOLS_RECORD_DIRECTORY
  );
  const smokeScript = resolve(options.smokeScript ?? DEFAULT_SMOKE_SCRIPT);
  const loadCandidate =
    options.loadCurrentCandidateRecordImpl ?? loadCurrentCandidateRecord;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const readFileImpl = options.readFileImpl ?? readFile;
  const readdirImpl = options.readdirImpl ?? readdir;
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const renameImpl = options.renameImpl ?? rename;
  const rmImpl = options.rmImpl ?? rm;
  const interactive =
    options.interactive ??
    process.env.PI_LEETCODE_ACCOUNT_SMOKE_INTERACTIVE === "1";

  const before = await loadCandidate({
    kind: "tools",
    artifactDirectory,
    recordDirectory
  });
  const artifactPath = candidateArtifactPath(artifactDirectory, before);
  const artifactBytesBefore = await readFileImpl(artifactPath);
  const artifactSha256 = sha256Bytes(artifactBytesBefore);
  assert(
    artifactBytesBefore.length === before.record.artifact.bytes &&
      artifactSha256 === before.record.artifact.sha256,
    "Tools candidate artifact bytes do not match CandidateRecord before account smoke"
  );
  const existingEvidenceFiles = new Set(
    (await readdirImpl(artifactDirectory)).filter(
      (file) =>
        file.startsWith(ACCOUNT_EVIDENCE_PREFIX) &&
        file.endsWith(ACCOUNT_EVIDENCE_SUFFIX)
    )
  );

  const result = await runCommandImpl(
    process.execPath,
    [smokeScript, artifactDirectory],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env },
      ...(interactive ? { stdio: "inherit" } : {}),
      timeoutMs: 30 * 60_000
    }
  );
  let evidencePath;
  try {
    evidencePath = interactive
      ? await findNewEvidencePath(
          artifactDirectory,
          existingEvidenceFiles,
          readdirImpl
        )
      : parseEvidencePath(
          result.stdout,
          artifactDirectory,
          existingEvidenceFiles
        );
    const after = await loadCandidate({
      kind: "tools",
      artifactDirectory,
      recordDirectory
    });
    assertCandidateIdentityStable(before, after);
    const artifactPathAfter = candidateArtifactPath(artifactDirectory, after);
    assert(
      artifactPathAfter === artifactPath,
      "Tools candidate artifact path changed during account smoke"
    );
    const artifactBytesAfter = await readFileImpl(artifactPathAfter);
    assert(
      Buffer.compare(artifactBytesBefore, artifactBytesAfter) === 0 &&
        sha256Bytes(artifactBytesAfter) === artifactSha256,
      "Tools candidate artifact bytes changed during account smoke"
    );

    await bindEvidence({
      evidencePath,
      candidate: before,
      artifactSha256,
      readFileImpl,
      writeFileImpl,
      renameImpl,
      rmImpl
    });

    return {
      evidencePath,
      recordId: before.record.recordId,
      recordDigest: before.recordDigest,
      artifactSha256,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    if (
      evidencePath !== undefined &&
      !existingEvidenceFiles.has(basename(evidencePath))
    ) {
      await rmImpl(evidencePath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function main() {
  const result = await runAccountSmokeEvidence({
    artifactDirectory: process.argv[2],
    recordDirectory: process.argv[3]
  });
  if (result.stdout.trim().length > 0) {
    console.log(result.stdout.trim());
  }
  if (result.stderr.trim().length > 0) {
    console.error(result.stderr.trim());
  }
  console.log(
    JSON.stringify(
      {
        evidencePath: result.evidencePath,
        recordId: result.recordId,
        recordDigest: result.recordDigest,
        artifactSha256: result.artifactSha256,
        file: basename(result.evidencePath)
      },
      null,
      2
    )
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
