import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  JCS_DIGEST_ALGORITHM,
  assert,
  digestPackageFiles,
  pathExists,
  portablePath,
  readJson,
  sha256Bytes,
  sha256Jcs,
  withExtractedPackage
} from "../../packages/pi-leetcode-tools/scripts/release-utils.mjs";
import { probePackedUpstreamBehavior } from "../../packages/pi-leetcode-tools/scripts/probe-packed-upstream-behavior.mjs";
import {
  generateExecutionReceipt,
  validateExecutionReceipt
} from "../../packages/pi-leetcode-tools/scripts/upstream-execution-receipt.mjs";
import { verifyUpstreamParity } from "../../packages/pi-leetcode-tools/scripts/verify-upstream-parity.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
export const CANDIDATE_RECORD_SCHEMA_VERSION = 2;
export const TOOLS_ARTIFACT_DIRECTORY = join(REPOSITORY_ROOT, ".artifacts", "tools");
export const TOOLS_RECORD_DIRECTORY = join(REPOSITORY_ROOT, "release", "candidates", "tools");

const PACKAGE_CONFIG = {
  tools: {
    packageName: "pi-leetcode-tools",
    packageDirectory: join(REPOSITORY_ROOT, "packages", "pi-leetcode-tools"),
    artifactDirectory: TOOLS_ARTIFACT_DIRECTORY,
    recordDirectory: TOOLS_RECORD_DIRECTORY
  }
};

const WORKSPACE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];
const INSTALLED_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies"
];
const IMPLEMENTED_UPSTREAM_TARGET_KINDS = new Set([
  "native_tool",
  "gateway_capability",
  "static_contract_resource"
]);

function assertExactUniqueStringSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(
    actual.every((value) => typeof value === "string" && value.length > 0),
    `${label} must contain non-empty strings`
  );
  assert(new Set(actual).size === actual.length, `${label} contains duplicates`);
  assert(
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    `${label} does not match the pinned reference interface set`
  );
}

function isMain(importMetaUrl) {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === importMetaUrl;
}

function parseCli(argv, definitions = {}) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const name = item.slice(2);
    if (definitions[name] === "boolean") {
      result[name] = true;
      continue;
    }
    const value = argv[index + 1];
    assert(value !== undefined && !value.startsWith("--"), `--${name} requires a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function candidateConfig(kind) {
  const config = PACKAGE_CONFIG[kind];
  assert(config !== undefined, `Unknown candidate kind: ${kind}`);
  return config;
}

function sha512Hex(bytes) {
  return `sha512:${createHash("sha512").update(bytes).digest("hex")}`;
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function resolveCandidate(input, packageName, artifactDirectory) {
  if (input !== undefined) {
    const candidate = resolve(input);
    assert((await stat(candidate)).isFile(), `Candidate is not a file: ${candidate}`);
    assert(candidate.toLowerCase().endsWith(".tgz"), `Candidate is not a .tgz: ${candidate}`);
    return candidate;
  }
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const matches = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(`${packageName}-`) &&
        entry.name.toLowerCase().endsWith(".tgz")
    )
    .map((entry) => join(artifactDirectory, entry.name))
    .sort();
  assert(matches.length === 1, `Expected exactly one ${packageName} candidate, found ${matches.length}`);
  return matches[0];
}

async function inspectToolsContract(packageDirectory, packageJson) {
  const [
    manifest,
    schema,
    capabilities,
    catalogs,
    upstreamSurface,
    upstreamSemantics,
    upstreamParity
  ] = await Promise.all([
    readJson(join(packageDirectory, "contract", "manifest.json")),
    readJson(join(packageDirectory, "contract", "schema.json")),
    readJson(join(packageDirectory, "contract", "capabilities.json")),
    readJson(join(packageDirectory, "contract", "catalogs.json")),
    readJson(join(packageDirectory, "upstream", "reference-surface.json")),
    readJson(join(packageDirectory, "upstream", "reference-semantics.json")),
    readJson(join(packageDirectory, "upstream", "parity.json"))
  ]);
  assert(packageJson.name === "pi-leetcode-tools", "Candidate is not pi-leetcode-tools");
  assert(packageJson.version === manifest.packageVersion, "Tools package/manifest version mismatch");
  assert(manifest.packageName === packageJson.name, "Tools manifest package name mismatch");
  assert(
    manifest.behaviorDigestAlgorithm === JCS_DIGEST_ALGORITHM,
    "Tools behavior digest algorithm is not RFC8785/JCS"
  );
  const schemaDigest = sha256Jcs(schema);
  const behaviorManifestDigest = sha256Jcs(manifest.behaviorManifest);
  const capabilityManifestDigest = sha256Jcs({
    packageName: capabilities.packageName,
    supportedRegions: capabilities.supportedRegions,
    tools: capabilities.tools,
    notesPort: capabilities.notesPort
  });
  const resourceCatalogDigest = sha256Jcs(catalogs);
  assert(schemaDigest === manifest.schemaDigest, "Tools schemaDigest does not match schema.json");
  assert(
    behaviorManifestDigest === manifest.behaviorManifestDigest,
    "Tools behaviorManifestDigest does not match the packed behavior manifest"
  );
  assert(
    capabilityManifestDigest === manifest.capabilityManifestDigest,
    "Tools capabilityManifestDigest does not match capabilities.json"
  );
  assert(
    resourceCatalogDigest === manifest.resourceCatalogDigest,
    "Tools resourceCatalogDigest does not match catalogs.json"
  );
  for (const field of [
    "packageName",
    "packageVersion",
    "contractVersion",
    "protocolVersion",
    "schemaDigest",
    "behaviorManifestDigest",
    "capabilityManifestDigest"
  ]) {
    assert(capabilities[field] === manifest[field], `Tools capabilities artifact ${field} does not match manifest`);
  }
  assert(schema.packageName === manifest.packageName, "Tools schema package name mismatch");
  assert(schema.contractVersion === manifest.contractVersion, "Tools schema contract version mismatch");
  assert(schema.protocolVersion === manifest.protocolVersion, "Tools schema protocol version mismatch");
  assert(
    upstreamSurface.expectedCounts?.tools === 19 &&
      upstreamSurface.expectedCounts?.resources === 5 &&
      upstreamSurface.expectedCounts?.total === 24,
    "Tools upstream surface must pin exactly 19 Tools and 5 Resources"
  );
  assert(
    Array.isArray(upstreamSurface.interfaces) && upstreamSurface.interfaces.length === 24,
    "Tools upstream surface must contain exactly 24 interfaces"
  );
  const upstreamInterfaceIds = upstreamSurface.interfaces.map((entry) => entry?.id);
  assertExactUniqueStringSet(
    upstreamInterfaceIds,
    upstreamSemantics.interfaces?.map((entry) => entry?.sourceId) ?? [],
    "Tools upstream semantic interface IDs"
  );
  assert(
    Array.isArray(upstreamParity.mappings) && upstreamParity.mappings.length === 24,
    "Tools upstream parity must contain exactly 24 mappings"
  );
  assertExactUniqueStringSet(
    upstreamParity.mappings.map((entry) => entry?.sourceId),
    upstreamInterfaceIds,
    "Tools upstream parity mapping IDs"
  );
  for (const mapping of upstreamParity.mappings) {
    assert(
      IMPLEMENTED_UPSTREAM_TARGET_KINDS.has(mapping?.status),
      `Tools candidate cannot be recorded until all upstream interfaces are implemented: ${mapping?.sourceId ?? "unknown"} is ${mapping?.status ?? "missing"}`
    );
    assert(
      Array.isArray(mapping.targets) && mapping.targets.length > 0,
      `Implemented upstream mapping has no target: ${mapping.sourceId}`
    );
  }
  assert(
    upstreamParity.target?.package === manifest.packageName &&
      upstreamParity.target?.packageVersion === manifest.packageVersion &&
      upstreamParity.target?.contractVersion === manifest.contractVersion &&
      upstreamParity.target?.protocolVersion === manifest.protocolVersion &&
      upstreamParity.target?.schemaDigest === manifest.schemaDigest &&
      upstreamParity.target?.behaviorManifestDigest ===
        manifest.behaviorManifestDigest &&
      upstreamParity.target?.capabilityManifestDigest ===
        manifest.capabilityManifestDigest &&
      upstreamParity.target?.resourceCatalogDigest ===
        manifest.resourceCatalogDigest,
    "Tools upstream parity target does not match the packed contract tuple"
  );
  assert(
    upstreamParity.reference?.inventoryDigest === upstreamSurface.inventoryDigest &&
      upstreamParity.reference?.semanticSurfaceDigest ===
        upstreamSemantics.semanticSurfaceDigest,
    "Tools upstream parity reference does not match the packed reference surfaces"
  );
  return {
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    contractVersion: manifest.contractVersion,
    protocolVersion: manifest.protocolVersion,
    schemaDigest: manifest.schemaDigest,
    behaviorManifestDigest: manifest.behaviorManifestDigest,
    capabilityManifestDigest: manifest.capabilityManifestDigest,
    resourceCatalogDigest: manifest.resourceCatalogDigest,
    upstreamReferenceId: `${upstreamSurface.source.package}@${upstreamSurface.source.version}`,
    upstreamSurfaceDigest: upstreamSurface.inventoryDigest,
    upstreamSemanticSurfaceDigest: upstreamSemantics.semanticSurfaceDigest,
    upstreamQueryDependency: upstreamParity.reference.queryDependency,
    upstreamParityDefinitionDigest: sha256Jcs(upstreamParity)
  };
}

async function inspectPackedUpstreamCompleteness(packageDirectory) {
  const report = await verifyUpstreamParity({
    packageDirectory,
    requireTestFiles: false
  });
  assert(
    report.complete &&
      report.totalUpstream === 24 &&
      report.implemented === 24 &&
      report.partial === 0 &&
      report.missing === 0 &&
      report.superseded === 0 &&
      report.approvedUnsupported === 0 &&
      report.strictBlockers.length === 0,
    "Tools candidate packed upstream completeness is not 24/24"
  );
  const generated = await generateExecutionReceipt({
    mode: "packed",
    packageDirectory,
    parityReport: report
  });
  const execution = validateExecutionReceipt(generated.receipt, {
    mode: "packed",
    surface: generated.surface,
    parityReport: report
  });
  const jsProbe = await probePackedUpstreamBehavior(packageDirectory, report);
  return {
    policy: "all_interfaces_implemented_with_execution_receipts",
    totalUpstream: report.totalUpstream,
    implemented: report.implemented,
    semanticSurfaceDigest: report.semanticSurfaceDigest,
    receiptDigest: execution.receiptDigest,
    runnerDigest: execution.runnerDigest,
    bindingDigest: execution.bindingDigest,
    passedCases: execution.passedCases,
    packedJsProbeDigest: jsProbe.receiptDigest,
    packedJsProbeChecks: jsProbe.checks.length
  };
}

async function readPackedPackage(tarball, kind) {
  const bytes = await readFile(tarball);
  const artifactSha256 = sha256Bytes(bytes);
  return withExtractedPackage(tarball, async ({ packageDirectory }) => {
    const packageJson = await readJson(join(packageDirectory, "package.json"));
    assert(kind === "tools", `Unsupported package kind: ${kind}`);
    const content = await digestPackageFiles(packageDirectory);
    const contractTuple = await inspectToolsContract(packageDirectory, packageJson);
    const upstreamCompleteness = await inspectPackedUpstreamCompleteness(packageDirectory);
    return {
      tarball,
      bytes,
      integrity: sha512Integrity(bytes),
      sha512: sha512Hex(bytes),
      sha256: artifactSha256,
      packageJson,
      content,
      contractTuple: {
        ...contractTuple,
        upstreamCompleteness: {
          ...upstreamCompleteness,
          artifactSha256,
          unpackedContentDigest: content.digest
        }
      }
    };
  });
}

function resolveLockDependency(packages, parentPath, dependencyName) {
  let directory = parentPath;
  while (true) {
    const candidate = `${directory.length > 0 ? `${directory}/` : ""}node_modules/${dependencyName}`;
    if (packages[candidate] !== undefined) return candidate;
    if (directory.length === 0) return undefined;
    const nestedMarker = directory.lastIndexOf("/node_modules/");
    if (nestedMarker >= 0) {
      directory = directory.slice(0, nestedMarker);
      continue;
    }
    const separator = directory.lastIndexOf("/");
    directory = separator >= 0 ? directory.slice(0, separator) : "";
  }
}

export function computePackageLockClosure(lockfile, workspacePath) {
  assert(lockfile?.lockfileVersion === 3, "Candidate records require npm lockfileVersion 3");
  const packages = lockfile.packages;
  assert(packages !== null && typeof packages === "object", "package-lock.json has no packages map");
  assert(packages[workspacePath] !== undefined, `package-lock.json is missing ${workspacePath}`);
  const selected = new Set();
  const queue = [workspacePath];
  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (selected.has(packagePath)) continue;
    selected.add(packagePath);
    const entry = packages[packagePath];
    const fields = packagePath === workspacePath ? WORKSPACE_DEPENDENCY_FIELDS : INSTALLED_DEPENDENCY_FIELDS;
    for (const field of fields) {
      const dependencies = entry[field];
      if (dependencies === undefined) continue;
      for (const dependencyName of Object.keys(dependencies).sort()) {
        const resolvedPath = resolveLockDependency(packages, packagePath, dependencyName);
        const optional =
          field === "optionalDependencies" ||
          (field === "peerDependencies" && entry.peerDependenciesMeta?.[dependencyName]?.optional === true);
        if (resolvedPath === undefined) {
          assert(optional, `Lock closure cannot resolve ${dependencyName} from ${packagePath}`);
          continue;
        }
        if (!selected.has(resolvedPath)) queue.push(resolvedPath);
      }
    }
  }
  const entries = [...selected]
    .sort()
    .map((path) => ({ path, metadata: packages[path] }));
  const closure = {
    lockfileVersion: lockfile.lockfileVersion,
    workspacePath,
    packages: entries
  };
  return {
    digest: sha256Jcs(closure),
    packageCount: entries.length,
    closure
  };
}

export async function sourceClosurePaths(packageDirectory) {
  const paths = [
    "tsconfig.base.json",
    "release/scripts/candidate-record.mjs",
    "release/scripts/prepare-artifact-dir.mjs",
    "packages/pi-leetcode-tools/scripts/release-utils.mjs"
  ];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (["dist", "node_modules", "coverage"].includes(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      const relativePath = portablePath(relative(REPOSITORY_ROOT, absolutePath));
      assert(!metadata.isSymbolicLink(), `Candidate source closure contains a symlink: ${relativePath}`);
      if (metadata.isDirectory()) await visit(absolutePath);
      else {
        assert(metadata.isFile(), `Candidate source closure contains an unsupported entry: ${relativePath}`);
        paths.push(relativePath);
      }
    }
  }
  await visit(packageDirectory);
  return [...new Set(paths)].sort();
}

function normalizeDriftPolicy(input = {}) {
  const reasons = [...new Set(input.reasons ?? [])].map(String).filter(Boolean).sort();
  const allowed = input.allowed === true;
  assert(!allowed || reasons.length > 0, "Workspace drift requires at least one explicit reason");
  return { allowed, reasons };
}

function normalizeDependencyRecords(subject, input) {
  assert(
    subject?.packageName === "pi-leetcode-tools",
    "Release record dependency policy has no package binding"
  );
  assert(
    input === undefined || input === null,
    "Tools release records must not declare dependency records"
  );
  return null;
}

export function createCandidateRecord(input) {
  const driftPolicy = normalizeDriftPolicy(input.driftPolicy);
  const dependencyRecords = normalizeDependencyRecords(
    input.subject,
    input.dependencyRecords
  );
  const identityInput = {
    subject: input.subject,
    artifact: input.artifact,
    lockfile: input.lockfile,
    compatibilityManifest: input.compatibilityManifest ?? null,
    dependencyRecords,
    sourceClosure: input.sourceClosure,
    workspacePublishedView: input.workspacePublishedView,
    contractTuple: input.contractTuple ?? null,
    driftPolicy
  };
  const identityDigest = sha256Jcs(identityInput);
  return {
    schemaVersion: CANDIDATE_RECORD_SCHEMA_VERSION,
    recordType: "release-candidate",
    recordId: `${input.subject.packageName}@${input.subject.packageVersion}/${identityDigest}`,
    evidenceClass: "engineering-candidate/non-release-evidence",
    sourceMode: "candidate",
    subject: input.subject,
    artifact: input.artifact,
    lockfile: input.lockfile,
    compatibilityManifest: input.compatibilityManifest ?? null,
    dependencyRecords,
    sourceClosure: input.sourceClosure,
    workspacePublishedView: input.workspacePublishedView,
    contractTuple: input.contractTuple ?? null,
    driftPolicy,
    algorithms: {
      jsonCanonicalization: "RFC8785/JCS",
      artifactHash: "SHA-512",
      fileHash: "SHA-256",
      fileSetDigest: "RFC8785/JCS+UTF-8+SHA-256"
    },
    formalReleaseEligible: false
  };
}

export function candidateRecordBytes(record) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function candidateRecordDigest(record) {
  return sha256Bytes(candidateRecordBytes(record));
}

export function validateCandidateRecord(record, current) {
  assert(record.schemaVersion === CANDIDATE_RECORD_SCHEMA_VERSION, "Unsupported candidate record schema");
  assert(record.recordType === "release-candidate", "Invalid candidate record type");
  for (const field of ["packageName", "packageVersion"]) {
    assert(record.subject?.[field] === current.subject[field], `Candidate record ${field} is stale`);
  }
  for (const field of [
    "file",
    "bytes",
    "sha256",
    "sha512",
    "distIntegrity",
    "unpackedContentDigest",
    "fileCount"
  ]) {
    assert(record.artifact?.[field] === current.artifact[field], `Candidate artifact ${field} is stale`);
  }
  assert(record.lockfile?.sha256 === current.lockfile.sha256, "Candidate record lockfile hash is stale");
  assert(
    record.lockfile?.workspacePath === current.lockfile.workspacePath &&
      record.lockfile?.packageCount === current.lockfile.packageCount,
    "Candidate record lockfile closure metadata is stale"
  );
  assert(
    JSON.stringify(record.compatibilityManifest ?? null) ===
      JSON.stringify(current.compatibilityManifest ?? null),
    "Candidate record compatibility manifest hash is stale"
  );
  assert(
    JSON.stringify(record.dependencyRecords) ===
      JSON.stringify(current.dependencyRecords),
    "Candidate record dependency records are stale"
  );
  assert(record.sourceClosure?.digest === current.sourceClosure.digest, "Candidate record source closure is stale");
  assert(
    record.workspacePublishedView?.digest === current.workspacePublishedView.digest,
    "Candidate record workspace published view is stale"
  );
  assert(
    record.workspacePublishedView?.matchesArtifact === current.workspacePublishedView.matchesArtifact,
    "Candidate record workspace/artifact relationship is stale"
  );
  assert(
    JSON.stringify(record.contractTuple ?? null) === JSON.stringify(current.contractTuple ?? null),
    "Candidate record contract tuple is stale"
  );
  const driftPolicy = normalizeDriftPolicy(record.driftPolicy);
  if (!current.workspacePublishedView.matchesArtifact) {
    assert(driftPolicy.allowed, "Candidate artifact differs from the current published workspace view");
  }
  const expected = createCandidateRecord({ ...current, driftPolicy });
  assert(expected.recordId === record.recordId, "Candidate record identity digest is stale");
  return { recordId: record.recordId, recordDigest: candidateRecordDigest(record) };
}

async function computeWorkspacePublishedView(kind, config, packed) {
  assert(kind === "tools", `Unsupported package kind: ${kind}`);
  return digestPackageFiles(
    config.packageDirectory,
    packed.content.files.map((file) => file.path)
  );
}

export async function computeCandidateState(options) {
  const config = candidateConfig(options.kind);
  const artifactDirectory = resolve(options.artifactDirectory ?? config.artifactDirectory);
  const tarball = await resolveCandidate(options.tarball, config.packageName, artifactDirectory);
  const packed = await readPackedPackage(tarball, options.kind);
  assert(packed.packageJson.name === config.packageName, "Candidate package identity mismatch");
  const lockfilePath = join(REPOSITORY_ROOT, "package-lock.json");
  const [lockfile, sourcePaths] = await Promise.all([
    readJson(lockfilePath),
    sourceClosurePaths(config.packageDirectory)
  ]);
  const workspacePath = portablePath(relative(REPOSITORY_ROOT, config.packageDirectory));
  const lockClosure = computePackageLockClosure(lockfile, workspacePath);
  const [sourceClosure, workspacePublishedView] = await Promise.all([
    digestPackageFiles(REPOSITORY_ROOT, sourcePaths),
    computeWorkspacePublishedView(options.kind, config, packed)
  ]);
  return {
    tarball,
    packed,
    recordDirectory: resolve(options.recordDirectory ?? config.recordDirectory),
    state: {
      subject: {
        packageName: packed.packageJson.name,
        packageVersion: packed.packageJson.version
      },
      artifact: {
        file: basename(tarball),
        bytes: packed.bytes.length,
        sha256: packed.sha256,
        sha512: packed.sha512,
        distIntegrity: packed.integrity,
        unpackedContentDigest: packed.content.digest,
        fileCount: packed.content.files.length
      },
      lockfile: {
        path: "package-lock.json",
        workspacePath,
        sha256: lockClosure.digest,
        packageCount: lockClosure.packageCount
      },
      compatibilityManifest: null,
      dependencyRecords: null,
      sourceClosure: {
        digest: sourceClosure.digest,
        fileCount: sourceClosure.files.length
      },
      workspacePublishedView: {
        digest: workspacePublishedView.digest,
        fileCount: workspacePublishedView.files.length,
        matchesArtifact: workspacePublishedView.digest === packed.content.digest
      },
      contractTuple: packed.contractTuple
    }
  };
}

async function writeAtomic(path, bytes) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

export async function generateCandidateRecord(options) {
  const computed = await computeCandidateState(options);
  const driftPolicy = normalizeDriftPolicy({
    allowed: options.allowWorkspaceDrift === true,
    reasons: options.driftReasons
  });
  if (!computed.state.workspacePublishedView.matchesArtifact) {
    assert(driftPolicy.allowed, "Workspace published view differs from candidate; rebuild or explicitly document drift");
  }
  const record = createCandidateRecord({ ...computed.state, driftPolicy });
  const digest = candidateRecordDigest(record);
  const fingerprint = record.recordId.split("/").at(-1).replace("sha256:", "").slice(0, 16);
  const fileName = `${record.subject.packageName}-${record.subject.packageVersion}-${fingerprint}.json`;
  const recordPath = join(computed.recordDirectory, fileName);
  const indexPath = join(computed.recordDirectory, "current.json");
  await mkdir(computed.recordDirectory, { recursive: true });
  const bytes = candidateRecordBytes(record);
  if (await pathExists(recordPath)) {
    assert(Buffer.compare(await readFile(recordPath), bytes) === 0, "Immutable candidate record path has different bytes");
  } else {
    await writeAtomic(recordPath, bytes);
  }
  const index = {
    schemaVersion: 1,
    packageName: record.subject.packageName,
    packageVersion: record.subject.packageVersion,
    recordId: record.recordId,
    recordFile: fileName,
    recordDigest: digest
  };
  await writeAtomic(indexPath, Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8"));
  return { record, recordPath, indexPath, recordDigest: digest };
}

export async function loadCurrentCandidateRecord(options) {
  const config = candidateConfig(options.kind);
  const recordDirectory = resolve(options.recordDirectory ?? config.recordDirectory);
  const index = await readJson(join(recordDirectory, "current.json"));
  assert(index.schemaVersion === 1, "Unsupported candidate index schema");
  assert(index.packageName === config.packageName, "Candidate index package mismatch");
  assert(
    typeof index.recordFile === "string" &&
      basename(index.recordFile) === index.recordFile &&
      index.recordFile.endsWith(".json") &&
      index.recordFile !== "current.json",
    "Unsafe candidate index path"
  );
  const recordPath = join(recordDirectory, index.recordFile);
  const recordBytes = await readFile(recordPath);
  assert(sha256Bytes(recordBytes) === index.recordDigest, "Candidate index record digest mismatch");
  const record = JSON.parse(recordBytes.toString("utf8"));
  assert(record.subject?.packageName === config.packageName, "Candidate record package mismatch");
  assert(record.recordId === index.recordId, "Candidate index recordId mismatch");
  const computed = await computeCandidateState(options);
  const validated = validateCandidateRecord(record, computed.state);
  assert(validated.recordDigest === index.recordDigest, "Candidate record canonical bytes changed");
  return { index, record, recordPath, ...validated, computed };
}

async function main() {
  const args = parseCli(process.argv.slice(2), {
    "allow-workspace-drift": "boolean",
    "verify-current": "boolean"
  });
  const kind = args.package ?? args._[0];
  const common = {
    kind,
    tarball: args.tarball,
    artifactDirectory: args.artifacts,
    recordDirectory: args.records
  };
  const result =
    args["verify-current"] === true
      ? await loadCurrentCandidateRecord(common)
      : await generateCandidateRecord({
          ...common,
          allowWorkspaceDrift: args["allow-workspace-drift"] === true,
          driftReasons: args["drift-reason"] === undefined ? [] : [args["drift-reason"]]
        });
  console.log(
    JSON.stringify(
      {
        recordId: result.recordId ?? result.record.recordId,
        recordDigest: result.recordDigest,
        recordPath: result.recordPath,
        indexPath:
          result.indexPath ??
          join(resolve(args.records ?? candidateConfig(kind).recordDirectory), "current.json"),
        mode: args["verify-current"] === true ? "verified-current" : "generated"
      },
      null,
      2
    )
  );
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
