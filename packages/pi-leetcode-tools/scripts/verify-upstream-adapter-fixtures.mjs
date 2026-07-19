import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const artifactsDirectory = resolve(process.argv[2] ?? join(workspaceDirectory, ".artifacts/tools"));
const recordsDirectory = resolve(process.argv[3] ?? join(workspaceDirectory, "release/candidates/tools"));
const ADAPTER_BUILD_FILES = [
  "dist/src/leetcode/read-adapter.js",
  "dist/src/leetcode/write-adapter.js",
  "dist/src/leetcode/notes-port.js",
  "dist/src/tool-calls/gateway.js"
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Jcs(value) {
  return sha256Bytes(Buffer.from(canonical(value), "utf8"));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceDirectory,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed (${result.status ?? "signal"}): ${command} ${args.join(" ")}`,
      result.error?.stack ?? result.error?.message,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function jsonPointer(value, pointer) {
  assert(pointer.startsWith("#/"), `Unsupported resource pointer: ${pointer}`);
  return pointer.slice(2).split("/").reduce((current, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    assert(current !== null && typeof current === "object" && key in current, `Packed resource pointer is missing: ${pointer}`);
    return current[key];
  }, value);
}

async function digestFiles(paths) {
  const files = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    files.push({ path: relative(packageDirectory, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256Bytes(bytes) });
  }
  return { files, digest: sha256Jcs(files) };
}

function collectAssertions(report) {
  assert(report?.success === true, "Adapter fixture test report did not pass");
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults ?? []);
  const byTitle = new Map();
  for (const item of assertions) {
    assert(typeof item.title === "string", "Adapter fixture assertion is missing a title");
    assert(!byTitle.has(item.title), `Duplicate adapter fixture sourceId: ${item.title}`);
    byTitle.set(item.title, item);
  }
  return byTitle;
}

function validateReceipt(receipt, parity, candidate) {
  assert(receipt.schemaVersion === 1, "Unsupported adapter fixture receipt schema");
  assert(receipt.receiptType === "upstream-adapter-fixture-execution", "Invalid adapter fixture receipt type");
  assert(receipt.gateId === "TOOLS-ENG-UPSTREAM-ADAPTER-FIXTURES", "Invalid adapter fixture Gate ID");
  assert(receipt.candidate.recordId === candidate.recordId, "Adapter fixture receipt recordId drifted");
  assert(receipt.candidate.artifactSha256 === candidate.artifact.sha256, "Adapter fixture receipt artifact SHA-256 drifted");
  assert(receipt.candidate.artifactFile === candidate.artifact.file, "Adapter fixture receipt artifact file drifted");
  assert(typeof receipt.adapterBuild?.digest === "string", "Adapter build digest is missing");
  assert(typeof receipt.fixtureCatalog?.digest === "string", "Fixture catalog digest is missing");
  assert(Array.isArray(receipt.results) && receipt.results.length === 24, "Adapter fixture receipt must contain exactly 24 results");
  const expected = new Map(parity.mappings.map((mapping) => [mapping.sourceId, mapping]));
  const actualIds = new Set();
  for (const result of receipt.results) {
    assert(expected.has(result.sourceId), `Unexpected adapter fixture sourceId: ${result.sourceId}`);
    assert(!actualIds.has(result.sourceId), `Duplicate adapter fixture result: ${result.sourceId}`);
    actualIds.add(result.sourceId);
    const mapping = expected.get(result.sourceId);
    assert(result.status === "passed", `Adapter fixture did not pass: ${result.sourceId}`);
    assert(result.mappingStatus === mapping.status, `Adapter fixture mapping status drifted: ${result.sourceId}`);
    assert(canonical(result.targets) === canonical(mapping.targets), `Adapter fixture targets drifted: ${result.sourceId}`);
    const expectedKind = mapping.status === "static_contract_resource" ? "packed_resource_read" : mapping.status === "gateway_capability" ? "gateway_public_entry" : "adapter_transport";
    assert(result.proofKind === expectedKind, `Adapter fixture proof kind drifted: ${result.sourceId}`);
    assert(typeof result.invocationId === "string" && result.invocationId.length > 0, `Adapter fixture invocation proof is missing: ${result.sourceId}`);
    assert(typeof result.resultDigest === "string", `Adapter fixture result digest is missing: ${result.sourceId}`);
  }
  assert(actualIds.size === expected.size, "Adapter fixture result set is incomplete");
  const withoutDigest = { ...receipt };
  delete withoutDigest.receiptDigest;
  assert(receipt.receiptDigest === sha256Jcs(withoutDigest), "Adapter fixture receipt digest mismatch");
  return receipt;
}

async function main() {
  const parity = await readJson(join(packageDirectory, "upstream/parity.json"));
  const current = await readJson(join(recordsDirectory, "current.json"));
  const candidate = await readJson(join(recordsDirectory, current.recordFile));
  assert(current.recordId === candidate.recordId, "Current Tools candidate selector does not match its record");
  const artifactPath = join(artifactsDirectory, candidate.artifact.file);
  const artifactBytes = await readFile(artifactPath);
  assert(sha256Bytes(artifactBytes) === candidate.artifact.sha256, "Exact Tools candidate artifact SHA-256 does not match CandidateRecord");

  const adapterBuild = await digestFiles(
    ADAPTER_BUILD_FILES.map((path) => join(packageDirectory, path))
  );
  const fixtureCatalog = await digestFiles([
    join(packageDirectory, "tests/release/upstream-adapter-fixtures.test.ts"),
    join(packageDirectory, "upstream/parity.json")
  ]);
  const runnerBytes = await readFile(fileURLToPath(import.meta.url));

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-adapter-gate-"));
  try {
    const vitestReportPath = join(temporaryDirectory, "vitest.json");
    run(process.execPath, [
      join(workspaceDirectory, "node_modules/vitest/vitest.mjs"), "run",
      "tests/release/upstream-adapter-fixtures.test.ts",
      "--reporter=json",
      `--outputFile=${vitestReportPath}`
    ], { cwd: packageDirectory });
    const assertions = collectAssertions(await readJson(vitestReportPath));

    const unpackDirectory = join(temporaryDirectory, "unpacked");
    await mkdir(unpackDirectory, { recursive: true });
    run("tar", ["-xzf", artifactPath, "-C", unpackDirectory]);
    for (const path of ADAPTER_BUILD_FILES) {
      const [sourceBytes, packedBytes] = await Promise.all([
        readFile(join(packageDirectory, path)),
        readFile(join(unpackDirectory, "package", path))
      ]);
      assert(
        sourceBytes.equals(packedBytes),
        `Built adapter entry differs from the exact candidate artifact: ${path}`
      );
    }
    const packedCatalogPath = join(unpackDirectory, "package/contract/catalogs.json");
    const packedCatalogBytes = await readFile(packedCatalogPath);
    const workspaceCatalogBytes = await readFile(join(packageDirectory, "contract/catalogs.json"));
    assert(packedCatalogBytes.equals(workspaceCatalogBytes), "Packed catalogs.json bytes differ from the source contract artifact");
    const packedCatalog = JSON.parse(packedCatalogBytes.toString("utf8"));

    const results = parity.mappings.map((mapping) => {
      if (mapping.status === "static_contract_resource") {
        const [file, pointer] = mapping.targets[0].split("#");
        assert(file === "contract/catalogs.json", `Unexpected packed resource file: ${mapping.sourceId}`);
        const value = jsonPointer(packedCatalog, `#${pointer}`);
        const proof = {
          packedFile: file,
          packedFileBytes: packedCatalogBytes.length,
          packedFileSha256: sha256Bytes(packedCatalogBytes),
          pointer: `#${pointer}`,
          valueDigest: sha256Jcs(value),
          valueCount: Array.isArray(value) ? value.length : undefined
        };
        return {
          sourceId: mapping.sourceId,
          mappingStatus: mapping.status,
          targets: mapping.targets,
          status: "passed",
          proofKind: "packed_resource_read",
          invocationId: `packed-resource:${mapping.sourceId}`,
          proof,
          resultDigest: sha256Jcs(proof)
        };
      }
      const assertion = assertions.get(mapping.sourceId);
      assert(assertion?.status === "passed", `Actual adapter/Gateway fixture is missing or failed: ${mapping.sourceId}`);
      const proofKind = mapping.status === "gateway_capability" ? "gateway_public_entry" : "adapter_transport";
      const proof = {
        testFile: "tests/release/upstream-adapter-fixtures.test.ts",
        testTitle: mapping.sourceId,
        suite: assertion.ancestorTitles,
        executed: true
      };
      return {
        sourceId: mapping.sourceId,
        mappingStatus: mapping.status,
        targets: mapping.targets,
        status: "passed",
        proofKind,
        invocationId: `${proofKind}:${mapping.sourceId}`,
        proof,
        resultDigest: sha256Jcs(proof)
      };
    });

    assert(assertions.size === 21, `Expected 21 actual adapter/Gateway invocations, got ${assertions.size}`);
    const receiptBase = {
      schemaVersion: 1,
      receiptType: "upstream-adapter-fixture-execution",
      gateId: "TOOLS-ENG-UPSTREAM-ADAPTER-FIXTURES",
      candidate: {
        recordId: candidate.recordId,
        artifactFile: candidate.artifact.file,
        artifactBytes: candidate.artifact.bytes,
        artifactSha256: candidate.artifact.sha256,
        unpackedContentDigest: candidate.artifact.unpackedContentDigest
      },
      upstream: {
        referencePackage: parity.reference.package,
        referenceVersion: parity.reference.version,
        inventoryDigest: parity.reference.inventoryDigest,
        semanticSurfaceDigest: parity.reference.semanticSurfaceDigest,
        parityDefinitionDigest: sha256Jcs(parity)
      },
      adapterBuild,
      fixtureCatalog,
      runner: {
        path: "scripts/verify-upstream-adapter-fixtures.mjs",
        digest: sha256Bytes(runnerBytes),
        policy: "actual_adapter_and_gateway_invocation_plus_exact_packed_resource_read"
      },
      summary: {
        total: results.length,
        nativeTool: results.filter((item) => item.mappingStatus === "native_tool").length,
        gatewayCapability: results.filter((item) => item.mappingStatus === "gateway_capability").length,
        staticContractResource: results.filter((item) => item.mappingStatus === "static_contract_resource").length,
        passed: results.filter((item) => item.status === "passed").length
      },
      results
    };
    const receipt = { ...receiptBase, receiptDigest: sha256Jcs(receiptBase) };
    validateReceipt(receipt, parity, candidate);
    const outputPath = join(artifactsDirectory, `${candidate.subject.packageName}-${candidate.subject.packageVersion}-upstream-adapter-fixtures.json`);
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "w" });
    console.log(JSON.stringify({ gateId: receipt.gateId, receipt: outputPath, receiptDigest: receipt.receiptDigest, summary: receipt.summary }, null, 2));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
