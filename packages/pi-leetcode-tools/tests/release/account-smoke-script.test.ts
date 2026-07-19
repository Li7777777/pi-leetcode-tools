import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../scripts/smoke-account.mjs", import.meta.url)
);
const evidenceWrapperUrl = new URL(
  "../../../../release/scripts/tools-account-smoke-evidence.mjs",
  import.meta.url
);
const rootPackageJsonPath = fileURLToPath(
  new URL("../../../../package.json", import.meta.url)
);

const EXPECTED_TOOLS = [
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

async function loadSource(): Promise<string> {
  return readFile(scriptPath, "utf8");
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function createCandidate(bytes: Buffer) {
  const sha512Hex = createHash("sha512").update(bytes).digest("hex");
  const sha512Base64 = createHash("sha512").update(bytes).digest("base64");
  return {
    recordDigest: `sha256:${"b".repeat(64)}`,
    record: {
      recordId: `pi-leetcode-tools@0.1.1/sha256:${"a".repeat(64)}`,
      subject: {
        packageName: "pi-leetcode-tools",
        packageVersion: "0.1.1"
      },
      artifact: {
        file: "pi-leetcode-tools-0.1.1.tgz",
        bytes: bytes.length,
        sha256: sha256(bytes),
        sha512: `sha512:${sha512Hex}`,
        distIntegrity: `sha512-${sha512Base64}`,
        unpackedContentDigest: `sha256:${"c".repeat(64)}`
      }
    }
  };
}

function createRawEvidence(candidate: ReturnType<typeof createCandidate>) {
  return {
    schemaVersion: "2.0.0",
    evidenceType: "approved-account-smoke",
    subject: {
      name: candidate.record.subject.packageName,
      version: candidate.record.subject.packageVersion,
      file: candidate.record.artifact.file,
      bytes: candidate.record.artifact.bytes,
      sha512: candidate.record.artifact.sha512,
      distIntegrity: candidate.record.artifact.distIntegrity,
      packageContentDigest: candidate.record.artifact.unpackedContentDigest
    },
    authorization: {
      accountSmoke: true,
      permanentWritesSkipped: true
    },
    result: { ok: true }
  };
}

async function evidenceExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function extractProbe(source: string): string {
  const match = source.match(
    /  const probeSource = `(?<probe>[\s\S]*?)`;\r?\n  await writeFile/u
  );
  expect(match?.groups?.probe).toBeDefined();
  return (match?.groups?.probe ?? "")
    .replace(
      "${JSON.stringify(probeFixture)}",
      '{"region":"global","fullMatrix":true,"safeMatrixRun":{"titleSlug":"two-sum","language":"python3","code":"x","testcase":"x"}}'
    )
    .replace("${JSON.stringify(FULL_MATRIX_TOOL_NAMES)}", JSON.stringify(EXPECTED_TOOLS))
    .replace("${JSON.stringify(manifest.discoveryChannel)}", '"discover"')
    .replace("${JSON.stringify(manifest.rpcChannel)}", '"rpc"')
    .replace("${JSON.stringify(manifest.protocolVersion)}", '"1.0.0"');
}

describe("packed account smoke script", () => {
  it("publishes the exact 14-tool safe matrix through Gateway RPC", async () => {
    const source = await loadSource();
    const toolsMatch = source.match(
      /const FULL_MATRIX_TOOL_NAMES = (?<tools>\[[\s\S]*?\n\]);/u
    );
    expect(toolsMatch?.groups?.tools).toBeDefined();
    expect(JSON.parse(toolsMatch?.groups?.tools ?? "[]")).toEqual(EXPECTED_TOOLS);

    for (const method of [
      "user.status",
      "notes.capabilities",
      "notes.read",
      "notes.search",
      "notes.get",
      "diagnostics.getSnapshot"
    ]) {
      expect(source).toContain(`"${method}"`);
    }
    expect(source).toContain(
      '{ tool: "lc_history", input: { region, scope: "account", limit: 2, offset: 0 } }'
    );
    expect(source).toContain(
      '{ tool: "lc_operation_status", input: { operationId: run.operationId } }'
    );
  });

  it("keeps the full matrix non-permanent while retaining the legacy double gates", async () => {
    const source = await loadSource();
    expect(source).toContain(
      "fixture.submit !== true && fixture.notesWriteContent === undefined"
    );
    expect(source).toContain('process.env.PI_LEETCODE_ALLOW_ACCOUNT_SMOKE === "1"');
    expect(source).toContain('process.env.PI_LEETCODE_ALLOW_REAL_SUBMIT === "1"');
    expect(source).toContain('process.env.PI_LEETCODE_ALLOW_NOTES_WRITE === "1"');
    expect(
      source.match(/permanent-external-write-not-authorized-in-full-matrix/gu)
        ?.length
    ).toBe(4);
    expect(source).toContain('skip("lc_submit", region');
    expect(source).toContain('skip("notes.write", region');
    expect(source).toContain('skip("notes.create", region');
    expect(source).toContain('skip("notes.update", region');
  });

  it("persists only safe hashes, byte counts, counts, and states", async () => {
    const source = await loadSource();
    const evidenceSource = source.slice(source.indexOf("  const evidence = {"));

    expect(evidenceSource).toContain("titleSlugSha256");
    expect(evidenceSource).toContain("codeBytes");
    expect(evidenceSource).toContain("codeSha256");
    expect(evidenceSource).toContain("testcaseBytes");
    expect(evidenceSource).toContain("testcaseSha256");
    expect(evidenceSource).not.toContain("titleSlug: fixture.titleSlug");
    expect(evidenceSource).not.toContain("notesTarget: probeFixture.notesTarget");
    expect(evidenceSource).not.toContain("origin: registry.origin");
    expect(source).not.toContain("requestId: call.requestId");
    expect(source).not.toContain("operationId: result");
    expect(source).toContain("operationIdHash");
    expect(source).toContain("submissionIdHash");
    expect(source).toContain("usernameHash");
    expect(source).toContain("data?.code === undefined");
    expect(source).toContain(
      'typeof data?.code === "string" && data.code.length > 0'
    );
  });

  it("emits a syntactically valid generated Pi probe", async () => {
    const probe = extractProbe(await loadSource());
    const output = ts.transpileModule(probe, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        allowJs: true
      },
      reportDiagnostics: true
    });
    const errors = (output.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    );
    expect(errors).toEqual([]);
  });

  it("routes the root account smoke command through the CandidateRecord wrapper", async () => {
    const rootPackage = JSON.parse(await readFile(rootPackageJsonPath, "utf8"));
    expect(rootPackage.scripts["smoke:tools:account"]).toBe(
      "node ./release/scripts/tools-account-smoke-evidence.mjs .artifacts/tools release/candidates/tools"
    );
  });

  it("binds approved account evidence to the exact current record and artifact bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tools-account-binding-"));
    const artifactDirectory = join(directory, "artifacts");
    const recordDirectory = join(directory, "records");
    const artifactBytes = Buffer.from("exact-tools-candidate", "utf8");
    const candidate = createCandidate(artifactBytes);
    const artifactPath = join(
      artifactDirectory,
      candidate.record.artifact.file
    );
    const evidencePath = join(
      artifactDirectory,
      "pi-leetcode-tools-account-smoke-evidence-fixture.json"
    );

    try {
      await Promise.all([
        mkdir(artifactDirectory, { recursive: true }),
        mkdir(recordDirectory, { recursive: true })
      ]);
      await writeFile(artifactPath, artifactBytes);
      const { runAccountSmokeEvidence } = await import(evidenceWrapperUrl.href);
      let loadCount = 0;
      const result = await runAccountSmokeEvidence({
        artifactDirectory,
        recordDirectory,
        loadCurrentCandidateRecordImpl: async () => {
          loadCount += 1;
          return candidate;
        },
        runCommandImpl: async (_command: string, args: string[]) => {
          expect(args.at(-1)).toBe(artifactDirectory);
          await writeFile(
            evidencePath,
            `${JSON.stringify(createRawEvidence(candidate), null, 2)}\n`,
            "utf8"
          );
          return {
            stdout: `Approved account smoke verified; evidence: ${evidencePath}\n`,
            stderr: ""
          };
        }
      });

      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      expect(loadCount).toBe(2);
      expect(result).toMatchObject({
        evidencePath,
        recordId: candidate.record.recordId,
        recordDigest: candidate.recordDigest,
        artifactSha256: candidate.record.artifact.sha256
      });
      expect(evidence.candidate).toEqual({
        recordId: candidate.record.recordId,
        recordDigest: candidate.recordDigest,
        artifactSha256: candidate.record.artifact.sha256
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed and removes new evidence when the current record changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tools-account-drift-"));
    const artifactDirectory = join(directory, "artifacts");
    const recordDirectory = join(directory, "records");
    const artifactBytes = Buffer.from("exact-tools-candidate", "utf8");
    const candidate = createCandidate(artifactBytes);
    const changedCandidate = {
      ...candidate,
      recordDigest: `sha256:${"d".repeat(64)}`,
      record: {
        ...candidate.record,
        recordId: `pi-leetcode-tools@0.1.1/sha256:${"e".repeat(64)}`
      }
    };
    const artifactPath = join(
      artifactDirectory,
      candidate.record.artifact.file
    );
    const evidencePath = join(
      artifactDirectory,
      "pi-leetcode-tools-account-smoke-evidence-record-drift.json"
    );

    try {
      await Promise.all([
        mkdir(artifactDirectory, { recursive: true }),
        mkdir(recordDirectory, { recursive: true })
      ]);
      await writeFile(artifactPath, artifactBytes);
      const { runAccountSmokeEvidence } = await import(evidenceWrapperUrl.href);
      let loadCount = 0;
      await expect(
        runAccountSmokeEvidence({
          artifactDirectory,
          recordDirectory,
          loadCurrentCandidateRecordImpl: async () => {
            loadCount += 1;
            return loadCount === 1 ? candidate : changedCandidate;
          },
          runCommandImpl: async () => {
            await writeFile(
              evidencePath,
              `${JSON.stringify(createRawEvidence(candidate), null, 2)}\n`,
              "utf8"
            );
            return {
              stdout: `Approved account smoke verified; evidence: ${evidencePath}\n`,
              stderr: ""
            };
          }
        })
      ).rejects.toThrow("Tools candidate changed during account smoke");
      expect(await evidenceExists(evidencePath)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed and removes new evidence when candidate bytes change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tools-account-bytes-"));
    const artifactDirectory = join(directory, "artifacts");
    const recordDirectory = join(directory, "records");
    const artifactBytes = Buffer.from("exact-tools-candidate", "utf8");
    const candidate = createCandidate(artifactBytes);
    const artifactPath = join(
      artifactDirectory,
      candidate.record.artifact.file
    );
    const evidencePath = join(
      artifactDirectory,
      "pi-leetcode-tools-account-smoke-evidence-byte-drift.json"
    );

    try {
      await Promise.all([
        mkdir(artifactDirectory, { recursive: true }),
        mkdir(recordDirectory, { recursive: true })
      ]);
      await writeFile(artifactPath, artifactBytes);
      const { runAccountSmokeEvidence } = await import(evidenceWrapperUrl.href);
      await expect(
        runAccountSmokeEvidence({
          artifactDirectory,
          recordDirectory,
          loadCurrentCandidateRecordImpl: async () => candidate,
          runCommandImpl: async () => {
            await Promise.all([
              writeFile(
                evidencePath,
                `${JSON.stringify(createRawEvidence(candidate), null, 2)}\n`,
                "utf8"
              ),
              writeFile(artifactPath, Buffer.from("changed-tools-candidate"))
            ]);
            return {
              stdout: `Approved account smoke verified; evidence: ${evidencePath}\n`,
              stderr: ""
            };
          }
        })
      ).rejects.toThrow("Tools candidate artifact bytes changed during account smoke");
      expect(await evidenceExists(evidencePath)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
