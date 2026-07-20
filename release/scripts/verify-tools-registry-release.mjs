import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  digestPackageFiles,
  pathExists,
  readJson,
  runCommand,
  sha256Jcs,
  withExtractedPackage
} from "../../packages/pi-leetcode-tools/scripts/release-utils.mjs";
import { parseStableVersion } from "./dist-tag-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageName = "pi-leetcode-tools";
const registryOrigin = "https://registry.npmjs.org";
const slsaPredicateType = "https://slsa.dev/provenance/v1";
const githubBuildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const sha256Pattern = /^(?:sha256:)?([0-9a-f]{64})$/u;
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    assert(key?.startsWith("--"), `Unexpected registry verification argument: ${key ?? "<missing>"}`);
    const name = key.slice(2);
    assert(!Object.hasOwn(parsed, name), `Duplicate registry verification argument: --${name}`);
    const value = args[index + 1];
    assert(value !== undefined && !value.startsWith("--"), `Missing value for --${name}`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512Hex(bytes) {
  return createHash("sha512").update(bytes).digest("hex");
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function sha1(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}

function encodedPackage(name) {
  return encodeURIComponent(name);
}

function npmPurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

async function fetchWithRetry(url, options = {}, attempts = 12) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          accept: "application/json",
          "user-agent": "pi-leetcode-tools-formal-release-verifier/1",
          ...(options.headers ?? {})
        }
      });
      if (response.ok) return response;
      if (response.status !== 404 && response.status < 500) {
        throw new Error(`Registry request failed with HTTP ${response.status}: ${url}`);
      }
      lastError = new Error(`Registry artifact is not available yet (HTTP ${response.status}): ${url}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
  }
  throw lastError;
}

function assertRegistryUrl(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is missing`);
  const url = new URL(value);
  assert(url.protocol === "https:", `${label} must use HTTPS`);
  assert(url.origin === registryOrigin, `${label} must remain on ${registryOrigin}`);
  assert(url.username === "" && url.password === "", `${label} must not contain credentials`);
  return url;
}

async function assertGitHubReleaseContext(version, policy) {
  const expectedTag = `${policy.releaseTagPrefix}${version}`;
  assert(process.env.GITHUB_ACTIONS === "true", "Formal registry verification must run in GitHub Actions");
  assert(process.env.GITHUB_EVENT_NAME === "workflow_dispatch", "Formal registry verification must run from workflow_dispatch");
  assert(process.env.GITHUB_REF_TYPE === "tag", "Formal registry verification requires a Git tag ref");
  assert(process.env.GITHUB_REF_NAME === expectedTag, `Formal registry verification requires tag ${expectedTag}`);
  assert(process.env.GITHUB_REF === `refs/tags/${expectedTag}`, `GITHUB_REF must be refs/tags/${expectedTag}`);
  assert(/^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? ""), "Formal registry verification requires an exact Git commit SHA");
  assert(
    (process.env.GITHUB_WORKFLOW_REF ?? "").endsWith(
      `/.github/workflows/release-tools.yml@refs/tags/${expectedTag}`
    ),
    "Formal registry verification must run from release-tools.yml at the exact release tag"
  );
  const [{ stdout: headOutput }, { stdout: tagOutput }] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    runCommand("git", ["rev-parse", `refs/tags/${expectedTag}^{commit}`], {
      cwd: repositoryRoot
    })
  ]);
  const expectedCommit = process.env.GITHUB_SHA;
  assert(headOutput.trim().toLowerCase() === expectedCommit, "Checked-out HEAD differs from GITHUB_SHA");
  assert(tagOutput.trim().toLowerCase() === expectedCommit, `Tag ${expectedTag} does not peel to GITHUB_SHA`);
  return expectedTag;
}

async function fetchPackumentAtLatest(version) {
  const packumentUrl = `${registryOrigin}/${encodedPackage(packageName)}`;
  let packument;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const response = await fetchWithRetry(packumentUrl, { redirect: "error" }, 1);
    packument = await response.json();
    assert(packument.name === packageName, "Registry packument has the wrong package identity");
    if (packument["dist-tags"]?.latest === version) return { packumentUrl, packument };
    if (attempt < 12) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error(`Registry latest tag does not point to ${version}; found ${packument?.["dist-tags"]?.latest ?? "<missing>"}`);
}

function decodeProvenance(attestations, version, tarballSha512) {
  assert(Array.isArray(attestations.attestations), "npm attestation response has no attestations array");
  const matches = attestations.attestations.filter(
    (entry) => entry?.predicateType === slsaPredicateType
  );
  assert(matches.length === 1, `Expected exactly one SLSA provenance attestation, found ${matches.length}`);
  const provenance = matches[0];
  const envelope = provenance.bundle?.dsseEnvelope;
  assert(envelope?.payloadType === "application/vnd.in-toto+json", "SLSA provenance has the wrong DSSE payload type");
  assert(typeof envelope.payload === "string" && envelope.payload.length > 0, "SLSA provenance payload is missing");
  assert(Array.isArray(envelope.signatures) && envelope.signatures.length > 0, "SLSA provenance has no DSSE signature");

  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  assert(statement._type === "https://in-toto.io/Statement/v1", "SLSA provenance statement has the wrong type");
  assert(statement.predicateType === slsaPredicateType, "SLSA provenance statement has the wrong predicate type");
  const expectedSubject = npmPurl(packageName, version);
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const subject = subjects.find((entry) => entry?.name === expectedSubject);
  assert(subject !== undefined, `SLSA provenance does not name ${expectedSubject}`);
  assert(subject.digest?.sha512 === tarballSha512, "SLSA provenance subject SHA-512 does not match registry tarball bytes");

  const expectedRepository = `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  const expectedRef = process.env.GITHUB_REF;
  const expectedCommit = process.env.GITHUB_SHA;
  assert(/^https:\/\/github\.com\/[^/]+\/[^/]+$/u.test(expectedRepository), "GITHUB_REPOSITORY is unavailable or invalid");
  assert(/^refs\/tags\//u.test(expectedRef ?? ""), "Formal provenance verification requires a Git tag ref");
  assert(/^[0-9a-f]{40}$/u.test(expectedCommit ?? ""), "Formal provenance verification requires an exact Git commit SHA");

  const predicate = statement.predicate;
  assert(predicate?.buildDefinition?.buildType === githubBuildType, "SLSA provenance was not produced by the GitHub Actions workflow build type");
  const workflow = predicate.buildDefinition?.externalParameters?.workflow;
  assert(workflow?.repository === expectedRepository, "SLSA provenance repository does not match GITHUB_REPOSITORY");
  assert(workflow?.ref === expectedRef, "SLSA provenance ref does not match the release tag");
  assert(
    workflow?.path === "/.github/workflows/release-tools.yml" ||
      workflow?.path === ".github/workflows/release-tools.yml",
    "SLSA provenance workflow path is not release-tools.yml"
  );
  const resolvedDependencies = predicate.buildDefinition?.resolvedDependencies;
  assert(Array.isArray(resolvedDependencies), "SLSA provenance has no resolved source dependencies");
  assert(
    resolvedDependencies.some(
      (entry) => entry?.digest?.gitCommit === expectedCommit &&
        typeof entry?.uri === "string" &&
        entry.uri.includes(`github.com/${process.env.GITHUB_REPOSITORY}@${expectedRef}`)
    ),
    "SLSA provenance does not bind the exact Git commit and release tag"
  );
  assert(
    predicate.runDetails?.builder?.id === "https://github.com/actions/runner/github-hosted",
    "SLSA provenance was not built by a GitHub-hosted runner"
  );

  return {
    predicateType: slsaPredicateType,
    subject: expectedSubject,
    subjectSha512: tarballSha512,
    buildType: predicate.buildDefinition.buildType,
    repository: workflow.repository,
    workflowPath: workflow.path,
    ref: workflow.ref,
    gitCommit: expectedCommit,
    builder: predicate.runDetails.builder.id,
    invocationId: predicate.runDetails?.metadata?.invocationId ?? null
  };
}

async function verifyRegistryCleanInstall({
  version,
  integrity,
  tarballUrl,
  record,
  expectedPackagePaths
}) {
  const npmCli = process.env.npm_execpath;
  assert(typeof npmCli === "string" && npmCli.length > 0, "Registry verification must be launched through an npm script");
  assert(await pathExists(npmCli), `npm CLI does not exist: ${npmCli}`);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-tools-registry-install-"));
  const npmCache = join(temporaryDirectory, "npm-cache");
  const npmUserConfig = join(temporaryDirectory, "user.npmrc");
  const npmGlobalConfig = join(temporaryDirectory, "global.npmrc");
  const packageJsonPath = join(temporaryDirectory, "package.json");
  const isolatedEnvironment = { ...process.env };
  for (const name of Object.keys(isolatedEnvironment)) {
    const upperName = name.toUpperCase();
    if (
      upperName === "NPM_TOKEN" ||
      upperName === "NODE_AUTH_TOKEN" ||
      (upperName.startsWith("NPM_CONFIG_") &&
        /(?:AUTH|TOKEN|PASSWORD|USERNAME)/u.test(upperName))
    ) {
      delete isolatedEnvironment[name];
    }
  }
  Object.assign(isolatedEnvironment, {
    HOME: temporaryDirectory,
    NODE_PATH: "",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_REGISTRY: registryOrigin,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: npmUserConfig
  });

  try {
    await Promise.all([
      mkdir(npmCache, { recursive: true }),
      writeFile(npmUserConfig, `registry=${registryOrigin}/\naudit=false\nfund=false\nignore-scripts=true\n`, "utf8"),
      writeFile(npmGlobalConfig, "", "utf8"),
      writeFile(
        packageJsonPath,
        `${JSON.stringify({ name: "pi-leetcode-tools-registry-probe", version: "0.0.0", private: true }, null, 2)}\n`,
        "utf8"
      )
    ]);

    const { stdout: npmVersionOutput } = await runCommand(
      process.execPath,
      [npmCli, "--version"],
      { cwd: temporaryDirectory, env: isolatedEnvironment }
    );
    await runCommand(
      process.execPath,
      [
        npmCli,
        "install",
        "--save-exact",
        "--package-lock=true",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `${packageName}@latest`
      ],
      {
        cwd: temporaryDirectory,
        env: isolatedEnvironment,
        stdio: "inherit",
        timeoutMs: 600_000
      }
    );

    const lockfile = await readJson(join(temporaryDirectory, "package-lock.json"));
    const lockEntry = lockfile.packages?.[`node_modules/${packageName}`];
    assert(lockEntry?.version === version, "Clean registry install resolved the wrong package version");
    assert(lockEntry.integrity === integrity, "Clean registry install lockfile integrity differs from registry metadata");
    assert(lockEntry.resolved === tarballUrl, "Clean registry install resolved a different tarball URL");

    const installedDirectory = join(temporaryDirectory, "node_modules", packageName);
    const installedPackageJson = await readJson(join(installedDirectory, "package.json"));
    assert(installedPackageJson.name === packageName && installedPackageJson.version === version, "Clean registry install has the wrong package identity");
    const installedContent = await digestPackageFiles(
      installedDirectory,
      expectedPackagePaths
    );
    assert(
      installedContent.digest === record.artifact.unpackedContentDigest,
      "Clean registry install content digest differs from the CandidateRecord"
    );
    assert(installedContent.files.length === record.artifact.fileCount, "Clean registry install file count differs from the CandidateRecord");

    const signatureAudit = await runCommand(
      process.execPath,
      [npmCli, "audit", "signatures", "--json"],
      {
        cwd: temporaryDirectory,
        env: isolatedEnvironment,
        timeoutMs: 600_000
      }
    );
    const signatureAuditReport = JSON.parse(signatureAudit.stdout);
    assert(
      Array.isArray(signatureAuditReport.invalid) &&
        signatureAuditReport.invalid.length === 0,
      "npm signature audit reported invalid signatures or provenance"
    );
    assert(
      Array.isArray(signatureAuditReport.missing) &&
        signatureAuditReport.missing.length === 0,
      "npm signature audit reported missing signatures or provenance"
    );

    return {
      npmVersion: npmVersionOutput.trim(),
      requested: `${packageName}@latest`,
      resolvedVersion: lockEntry.version,
      resolved: lockEntry.resolved,
      integrity: lockEntry.integrity,
      installedContentDigest: installedContent.digest,
      installedFileCount: installedContent.files.length,
      lifecycleScripts: "disabled",
      signatureAudit: {
        command: "npm audit signatures --json",
        status: "passed",
        invalid: 0,
        missing: 0,
        stdoutSha256: `sha256:${sha256(signatureAudit.stdout)}`,
        stderrSha256: `sha256:${sha256(signatureAudit.stderr)}`
      }
    };
  } finally {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    });
  }
}

async function runExistingVerifier(script, tarball, timeoutMs = 600_000) {
  await runCommand(process.execPath, [join(repositoryRoot, script), tarball], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    timeoutMs
  });
}

const args = parseArgs(process.argv.slice(2));
const allowedArguments = new Set([
  "version",
  "expected-sha256",
  "expected-record-digest",
  "artifacts",
  "records",
  "evidence"
]);
for (const key of Object.keys(args)) {
  assert(allowedArguments.has(key), `Unknown registry verification argument: --${key}`);
}

const version = args.version;
const expectedShaMatch = sha256Pattern.exec(args["expected-sha256"] ?? "");
const expectedRecordDigest = args["expected-record-digest"];
assert(typeof version === "string" && semverPattern.test(version), "--version must be an exact semantic version");
parseStableVersion(version, "--version");
assert(expectedShaMatch !== null, "--expected-sha256 must be an exact lowercase SHA-256 digest");
assert(/^sha256:[0-9a-f]{64}$/u.test(expectedRecordDigest ?? ""), "--expected-record-digest must be an exact SHA-256 digest");

const artifactsDirectory = resolve(args.artifacts ?? join(repositoryRoot, ".artifacts", "tools"));
const recordsDirectory = resolve(args.records ?? join(repositoryRoot, "release", "candidates", "tools"));
const evidencePath = resolve(
  args.evidence ?? join(artifactsDirectory, `${packageName}-${version}-formal-registry-evidence.json`)
);
const policy = await readJson(join(repositoryRoot, "release", "tools-release-policy.json"));
assert(
  policy.schemaVersion === 2 &&
    policy.packageName === packageName &&
    policy.registry === registryOrigin,
  "Committed release policy has the wrong schema or registry identity"
);
assert(policy.releaseTagPrefix === "pi-leetcode-tools-v", "Committed release tag prefix is invalid");
assert(
  policy.publishDistTag === "latest" && policy.preserveOtherDistTags === true,
  "Committed regular release policy must publish latest and preserve every other dist-tag"
);
await assertGitHubReleaseContext(version, policy);
const expectedOwner = policy.expectedNpmOwner;
assert(/^[a-z0-9](?:[a-z0-9._-]{0,62})$/u.test(expectedOwner ?? ""), "Committed release policy has no reviewed npm owner");
assert(
    policy.trustedPublisher?.configured === true &&
    policy.trustedPublisher?.workflow === ".github/workflows/release-tools.yml" &&
    policy.trustedPublisher?.environment === "npm-tools-next" &&
    typeof policy.trustedPublisher?.evidenceReference === "string" &&
    policy.trustedPublisher.evidenceReference.length > 0,
  "Committed trusted-publisher external gate is not configured"
);
const current = await readJson(join(recordsDirectory, "current.json"));
assert(current.packageName === packageName && current.packageVersion === version, "Current CandidateRecord does not match the requested registry package");
const recordBytes = await readFile(join(recordsDirectory, current.recordFile));
const record = JSON.parse(recordBytes.toString("utf8"));
assert(record.recordId === current.recordId, "Current CandidateRecord pointer is inconsistent");
assert(current.recordDigest === expectedRecordDigest, "Current CandidateRecord digest differs from the approved input");
assert(`sha256:${sha256(recordBytes)}` === expectedRecordDigest, "Current CandidateRecord byte digest is invalid");
const candidateTarball = join(artifactsDirectory, record.artifact.file);
const candidateBytes = await readFile(candidateTarball);
const expectedSha256 = expectedShaMatch[1];
assert(sha256(candidateBytes) === expectedSha256, "Local candidate tarball does not match --expected-sha256");
assert(record.artifact.sha256 === `sha256:${expectedSha256}`, "CandidateRecord does not match --expected-sha256");

const { packumentUrl, packument } = await fetchPackumentAtLatest(version);
assert(Object.hasOwn(packument.versions ?? {}, version), "Registry packument does not contain the published version");
const registryLatest = packument["dist-tags"].latest;

const metadataUrl = `${registryOrigin}/${encodedPackage(packageName)}/${encodeURIComponent(version)}`;
const metadataResponse = await fetchWithRetry(metadataUrl, { redirect: "error" });
const metadata = await metadataResponse.json();
assert(metadata.name === packageName && metadata.version === version, "Registry metadata has the wrong package identity");
assert(metadata.deprecated === undefined || metadata.deprecated === "", "Registry version is deprecated");
assert(
  Array.isArray(metadata.maintainers) && metadata.maintainers.some((entry) => entry?.name === expectedOwner),
  `Expected npm owner ${expectedOwner} is not a registry maintainer`
);
assert(/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(metadata.dist?.integrity ?? ""), "Registry metadata has no SHA-512 integrity");
assert(/^[0-9a-f]{40}$/u.test(metadata.dist?.shasum ?? ""), "Registry metadata has no SHA-1 shasum");
assert(Array.isArray(metadata.dist?.signatures) && metadata.dist.signatures.length > 0, "Registry metadata has no npm registry signature");
assert(metadata.dist?.attestations?.provenance?.predicateType === slsaPredicateType, "Registry metadata has no SLSA provenance declaration");
const tarballUrl = assertRegistryUrl(metadata.dist.tarball, "Registry tarball URL");
const attestationUrl = assertRegistryUrl(metadata.dist.attestations.url, "Registry attestation URL");

const tarballResponse = await fetchWithRetry(tarballUrl.href, {
  headers: { accept: "application/octet-stream" },
  redirect: "follow"
});
assertRegistryUrl(tarballResponse.url, "Resolved registry tarball URL");
const registryBytes = Buffer.from(await tarballResponse.arrayBuffer());
const registrySha256 = sha256(registryBytes);
const registrySha512 = sha512Hex(registryBytes);
const registryIntegrity = sha512Integrity(registryBytes);
assert(registrySha256 === expectedSha256, "Registry tarball SHA-256 differs from the approved candidate");
assert(registryBytes.equals(candidateBytes), "Registry tarball bytes differ from the approved candidate");
assert(registryIntegrity === metadata.dist.integrity, "Registry tarball SHA-512 integrity differs from metadata");
assert(sha1(registryBytes) === metadata.dist.shasum, "Registry tarball SHA-1 differs from metadata");
assert(record.artifact.distIntegrity === registryIntegrity, "Registry integrity differs from the CandidateRecord");
assert(record.artifact.sha512 === `sha512:${registrySha512}`, "Registry SHA-512 differs from the CandidateRecord");

const registryArtifactDirectory = join(artifactsDirectory, "registry", version);
await mkdir(registryArtifactDirectory, { recursive: true });
const registryTarball = join(registryArtifactDirectory, basename(record.artifact.file));
await writeFile(registryTarball, registryBytes);
const extractedRegistryContent = await withExtractedPackage(
  registryTarball,
  ({ packageDirectory }) => digestPackageFiles(packageDirectory)
);
assert(
  extractedRegistryContent.digest === record.artifact.unpackedContentDigest,
  "Extracted registry tarball content differs from the CandidateRecord"
);
assert(
  extractedRegistryContent.files.length === record.artifact.fileCount,
  "Extracted registry tarball file count differs from the CandidateRecord"
);

const attestationResponse = await fetchWithRetry(attestationUrl.href, { redirect: "error" });
const attestations = await attestationResponse.json();
const provenance = decodeProvenance(attestations, version, registrySha512);
const cleanInstall = await verifyRegistryCleanInstall({
  version,
  integrity: registryIntegrity,
  tarballUrl: tarballUrl.href,
  record,
  expectedPackagePaths: extractedRegistryContent.files.map((entry) => entry.path)
});

await runExistingVerifier(
  "packages/pi-leetcode-tools/scripts/test-packed-install.mjs",
  registryTarball
);
await runExistingVerifier(
  "packages/pi-leetcode-tools/scripts/test-pi-activation.mjs",
  registryTarball
);
await runExistingVerifier(
  "packages/pi-leetcode-tools/scripts/verify-release-security.mjs",
  registryTarball,
  900_000
);

const activationEvidencePath = join(
  registryArtifactDirectory,
  "pi-leetcode-tools-pi-activation-evidence.json"
);
const supplyChainEvidencePath = join(
  registryArtifactDirectory,
  "pi-leetcode-tools-release-evidence.json"
);
const sbomPath = join(
  registryArtifactDirectory,
  "pi-leetcode-tools-sbom.cdx.json"
);
const [activationBytes, supplyChainBytes, sbomBytes] = await Promise.all([
  readFile(activationEvidencePath),
  readFile(supplyChainEvidencePath),
  readFile(sbomPath)
]);

const evidence = {
  schemaVersion: 2,
  evidenceType: "formal-registry-release",
  generatedAt: new Date().toISOString(),
  sourceMode: "formal_registry",
  subject: {
    package: packageName,
    version,
    recordId: current.recordId,
    recordDigest: current.recordDigest,
    bytes: registryBytes.length,
    sha256: `sha256:${registrySha256}`,
    sha512: `sha512:${registrySha512}`,
    integrity: registryIntegrity
  },
  registry: {
    origin: registryOrigin,
    packumentUrl,
    metadataUrl,
    tarballUrl: tarballUrl.href,
    owner: expectedOwner,
    publishDistTag: policy.publishDistTag,
    latest: registryLatest,
    releasePolicyDigest: sha256Jcs(policy),
    shasum: metadata.dist.shasum,
    signatures: metadata.dist.signatures.length,
    selectedMetadataDigest: sha256Jcs({
      name: metadata.name,
      version: metadata.version,
      maintainers: metadata.maintainers,
      dist: metadata.dist
    })
  },
  provenance: {
    ...provenance,
    attestationUrl: attestationUrl.href,
    attestationDigest: sha256Jcs(attestations),
    cryptographicVerification: "npm audit signatures"
  },
  externalGates: {
    trustedPublisher: policy.trustedPublisher,
    tagProtectionEvidenceGate: policy.source?.tagProtectionEvidenceGate ?? null,
    mainlineAncestorRequired: policy.source?.requireMainlineAncestor === true
  },
  cleanInstall,
  packedInstall: {
    status: "passed",
    source: "downloaded exact registry tarball"
  },
  piActivation: {
    status: "passed",
    evidence: `registry/${version}/${basename(activationEvidencePath)}`,
    evidenceSha256: `sha256:${sha256(activationBytes)}`
  },
  supplyChain: {
    status: "passed",
    evidence: `registry/${version}/${basename(supplyChainEvidencePath)}`,
    evidenceSha256: `sha256:${sha256(supplyChainBytes)}`,
    sbom: `registry/${version}/${basename(sbomPath)}`,
    sbomSha256: `sha256:${sha256(sbomBytes)}`
  }
};
await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(
  [
    `Formal registry release verified: ${packageName}@${version}`,
    `Registry tarball SHA-256: ${registrySha256}`,
    `Provenance: ${provenance.repository}${provenance.workflowPath}@${provenance.ref}`,
    `Clean install and npm signature audit: passed`,
    `Pi activation and supply-chain verification: passed`,
    `Evidence: ${evidencePath}`
  ].join("\n")
);
