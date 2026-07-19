import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  digestPackageFiles,
  runCommand,
  sha256Jcs,
  withExtractedPackage
} from "../../packages/pi-leetcode-tools/scripts/release-utils.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageName = "pi-leetcode-tools";
const registryOrigin = "https://registry.npmjs.org";
const bootstrapWorkflow = ".github/workflows/bootstrap-tools.yml";
const slsaPredicateType = "https://slsa.dev/provenance/v1";
const githubBuildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const sha256Pattern = /^(?:sha256:)?([0-9a-f]{64})$/u;
const recordDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const ownerPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/u;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const parsed = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    assert(key?.startsWith("--"), `Unexpected bootstrap argument: ${key ?? "<missing>"}`);
    const name = key.slice(2);
    assert(!Object.hasOwn(parsed, name), `Duplicate bootstrap argument: --${name}`);
    const value = rest[index + 1];
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

function stateDigest(value) {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function npmPurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function git(args) {
  const { stdout } = await runCommand("git", args, { cwd: repositoryRoot });
  return stdout;
}

function assertGitHubBootstrapContext(version) {
  const expectedTag = `pi-leetcode-tools-v${version}`;
  assert(process.env.GITHUB_ACTIONS === "true", "Bootstrap verification must run in GitHub Actions");
  assert(process.env.GITHUB_EVENT_NAME === "workflow_dispatch", "Bootstrap is allowed only from workflow_dispatch");
  assert(process.env.GITHUB_REF_TYPE === "tag", "Bootstrap requires a Git tag ref");
  assert(process.env.GITHUB_REF_NAME === expectedTag, `Bootstrap requires tag ${expectedTag}`);
  assert(/^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? ""), "Bootstrap requires an exact Git commit SHA");
  assert(
    /\.github\/workflows\/bootstrap-tools\.yml@refs\/tags\//u.test(process.env.GITHUB_WORKFLOW_REF ?? ""),
    "Bootstrap must run from bootstrap-tools.yml at the release tag"
  );
  return expectedTag;
}

async function fetchWithRetry(url, options = {}, attempts = 12) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          accept: "application/json",
          "user-agent": "pi-leetcode-tools-bootstrap-verifier/1",
          ...(options.headers ?? {})
        }
      });
      if (response.ok) return response;
      if (response.status !== 404 && response.status < 500) {
        throw new Error(`Registry request failed with HTTP ${response.status}: ${url}`);
      }
      lastError = new Error(`Registry data is not available yet (HTTP ${response.status}): ${url}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
  }
  throw lastError;
}

async function fetchRegistryState({ requireMissing = false, attempts = 1 } = {}) {
  const url = `${registryOrigin}/${encodeURIComponent(packageName)}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      redirect: "error"
    });
    if (response.status === 404) {
      return { packageExists: false, distTags: {} };
    }
    assert(response.ok, `npm registry preflight failed with HTTP ${response.status}`);
    const packument = await response.json();
    assert(packument.name === packageName, "npm registry returned the wrong package");
    const distTags = Object.fromEntries(
      Object.entries(packument["dist-tags"] ?? {}).sort(([left], [right]) => left.localeCompare(right))
    );
    if (!requireMissing) return { packageExists: true, distTags };
    if (attempt < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
  }
  throw new Error(`${packageName} already exists; the one-time bootstrap workflow cannot publish or overwrite it`);
}

function assertRegistryUrl(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is missing`);
  const url = new URL(value);
  assert(url.protocol === "https:", `${label} must use HTTPS`);
  assert(url.origin === registryOrigin, `${label} must remain on ${registryOrigin}`);
  assert(url.username === "" && url.password === "", `${label} must not contain credentials`);
  return url;
}

function decodeProvenance(attestations, version, tarballSha512) {
  assert(Array.isArray(attestations.attestations), "npm attestation response has no attestations array");
  const matches = attestations.attestations.filter((entry) => entry?.predicateType === slsaPredicateType);
  assert(matches.length === 1, `Expected exactly one SLSA provenance attestation, found ${matches.length}`);
  const envelope = matches[0].bundle?.dsseEnvelope;
  assert(envelope?.payloadType === "application/vnd.in-toto+json", "SLSA provenance has the wrong DSSE payload type");
  assert(typeof envelope.payload === "string" && envelope.payload.length > 0, "SLSA provenance payload is missing");
  assert(Array.isArray(envelope.signatures) && envelope.signatures.length > 0, "SLSA provenance has no DSSE signature");

  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  assert(statement._type === "https://in-toto.io/Statement/v1", "SLSA provenance statement has the wrong type");
  assert(statement.predicateType === slsaPredicateType, "SLSA provenance statement has the wrong predicate type");
  const subjectName = npmPurl(packageName, version);
  const subject = (statement.subject ?? []).find((entry) => entry?.name === subjectName);
  assert(subject?.digest?.sha512 === tarballSha512, "SLSA provenance subject does not match registry tarball bytes");

  const expectedRepository = `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  const predicate = statement.predicate;
  const workflow = predicate?.buildDefinition?.externalParameters?.workflow;
  assert(predicate?.buildDefinition?.buildType === githubBuildType, "SLSA provenance has the wrong GitHub Actions build type");
  assert(workflow?.repository === expectedRepository, "SLSA provenance repository does not match GITHUB_REPOSITORY");
  assert(workflow?.ref === process.env.GITHUB_REF, "SLSA provenance ref does not match the release tag");
  assert(
    workflow?.path === `/${bootstrapWorkflow}` || workflow?.path === bootstrapWorkflow,
    "SLSA provenance was not emitted by bootstrap-tools.yml"
  );
  assert(
    (predicate.buildDefinition?.resolvedDependencies ?? []).some(
      (entry) => entry?.digest?.gitCommit === process.env.GITHUB_SHA &&
        typeof entry?.uri === "string" &&
        entry.uri.includes(`github.com/${process.env.GITHUB_REPOSITORY}@${process.env.GITHUB_REF}`)
    ),
    "SLSA provenance does not bind the exact release commit and tag"
  );
  assert(
    predicate.runDetails?.builder?.id === "https://github.com/actions/runner/github-hosted",
    "SLSA provenance was not built by a GitHub-hosted runner"
  );

  return {
    predicateType: slsaPredicateType,
    subject: subjectName,
    subjectSha512: tarballSha512,
    buildType: githubBuildType,
    repository: workflow.repository,
    workflowPath: workflow.path,
    ref: workflow.ref,
    gitCommit: process.env.GITHUB_SHA,
    builder: predicate.runDetails.builder.id,
    invocationId: predicate.runDetails?.metadata?.invocationId ?? null
  };
}

async function prepareBundle(args) {
  const version = args.version;
  const expectedSha = sha256Pattern.exec(args["expected-sha256"] ?? "");
  const expectedRecordDigest = args["expected-record-digest"];
  const expectedOwner = args["expected-owner"];
  assert(semverPattern.test(version ?? ""), "--version must be an exact semantic version");
  assert(expectedSha !== null, "--expected-sha256 must be an exact lowercase SHA-256");
  assert(recordDigestPattern.test(expectedRecordDigest ?? ""), "--expected-record-digest is invalid");
  assert(ownerPattern.test(expectedOwner ?? ""), "--expected-owner is not a valid npm owner");
  assert(args.confirmation === `bootstrap ${packageName}@${version} to next`, "Bootstrap confirmation is invalid");
  const expectedTag = assertGitHubBootstrapContext(version);

  const [head, tagCommit, policyText, packageText, currentText] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["rev-parse", `refs/tags/${expectedTag}^{commit}`]),
    git(["show", "HEAD:release/tools-release-policy.json"]),
    git(["show", "HEAD:packages/pi-leetcode-tools/package.json"]),
    git(["show", "HEAD:release/candidates/tools/current.json"])
  ]);
  const commit = head.trim().toLowerCase();
  assert(commit === tagCommit.trim().toLowerCase(), `HEAD is not the peeled commit of ${expectedTag}`);
  assert(commit === process.env.GITHUB_SHA, "GITHUB_SHA differs from the tagged commit");

  const policy = JSON.parse(policyText);
  const packageJson = JSON.parse(packageText);
  const current = JSON.parse(currentText);
  assert(policy.packageName === packageName && policy.registry === registryOrigin, "Committed release policy has the wrong registry identity");
  assert(policy.releaseTagPrefix === "pi-leetcode-tools-v", "Committed release tag prefix is invalid");
  assert(policy.publishDistTag === "next" && policy.protectedDistTag === "latest", "Committed release dist-tags are invalid");
  assert(packageJson.name === packageName && packageJson.version === version, "Committed package.json does not match the requested version");
  assert(current.packageName === packageName && current.packageVersion === version, "Committed current.json does not match the requested version");
  assert(current.recordDigest === expectedRecordDigest, "Committed current.json differs from --expected-record-digest");
  assert(basename(current.recordFile) === current.recordFile, "Committed CandidateRecord filename is unsafe");

  const recordText = await git(["show", `HEAD:release/candidates/tools/${current.recordFile}`]);
  const record = JSON.parse(recordText);
  assert(`sha256:${sha256(recordText)}` === expectedRecordDigest, "Committed CandidateRecord byte digest is invalid");
  assert(record.recordId === current.recordId, "Committed current.json and CandidateRecord disagree");
  assert(record.subject?.packageName === packageName && record.subject?.packageVersion === version, "Committed CandidateRecord subject is invalid");
  assert(record.driftPolicy?.allowed === false, "Committed CandidateRecord permits release drift");

  const artifactsDirectory = resolve(args.artifacts ?? join(repositoryRoot, ".artifacts", "tools"));
  const bundleDirectory = resolve(args.bundle ?? join(repositoryRoot, ".artifacts", "bootstrap-bundle", "tools"));
  const tarballName = `pi-leetcode-tools-${version}.tgz`;
  assert(record.artifact?.file === tarballName, "Committed CandidateRecord names the wrong tarball");
  const tarballPath = join(artifactsDirectory, tarballName);
  const tarballBytes = await readFile(tarballPath);
  assert(sha256(tarballBytes) === expectedSha[1], "Built tgz differs from --expected-sha256");
  assert(record.artifact.sha256 === `sha256:${expectedSha[1]}`, "CandidateRecord SHA-256 differs from the built tgz");
  assert(record.artifact.bytes === tarballBytes.length, "CandidateRecord byte count differs from the built tgz");
  assert(record.artifact.distIntegrity === sha512Integrity(tarballBytes), "CandidateRecord integrity differs from the built tgz");

  const [worktreeCurrent, worktreeRecord, worktreePolicy] = await Promise.all([
    readFile(join(repositoryRoot, "release", "candidates", "tools", "current.json"), "utf8"),
    readFile(join(repositoryRoot, "release", "candidates", "tools", current.recordFile), "utf8"),
    readFile(join(repositoryRoot, "release", "tools-release-policy.json"), "utf8")
  ]);
  assert(worktreeCurrent === currentText, "Build changed committed current.json");
  assert(worktreeRecord === recordText, "Build changed the committed CandidateRecord");
  assert(worktreePolicy === policyText, "Release policy differs from the tagged commit");

  const prePublishState = await fetchRegistryState({ requireMissing: true, attempts: 3 });
  assert(prePublishState.packageExists === false, `${packageName} must be absent before bootstrap`);
  const distTagSnapshot = {
    schemaVersion: 1,
    evidenceType: "npm-dist-tag-snapshot",
    registry: registryOrigin,
    package: packageName,
    protectedTag: "latest",
    state: prePublishState,
    stateDigest: stateDigest(prePublishState)
  };
  const approval = {
    schemaVersion: 1,
    evidenceType: "one-time-npm-bootstrap-approval",
    generatedAt: new Date().toISOString(),
    subject: {
      package: packageName,
      version,
      tarball: tarballName,
      bytes: tarballBytes.length,
      sha256: `sha256:${expectedSha[1]}`,
      integrity: record.artifact.distIntegrity,
      recordId: current.recordId,
      recordDigest: expectedRecordDigest,
      recordFile: current.recordFile
    },
    source: {
      commit,
      tag: expectedTag,
      workflow: bootstrapWorkflow
    },
    registry: {
      origin: registryOrigin,
      expectedOwner,
      publishDistTag: "next",
      protectedDistTag: "latest",
      packageAbsent: true,
      prePublishStateDigest: distTagSnapshot.stateDigest
    },
    policyDigest: sha256Jcs(policy)
  };

  await rm(bundleDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await mkdir(bundleDirectory, { recursive: true });
  await Promise.all([
    copyFile(tarballPath, join(bundleDirectory, tarballName)),
    writeFile(join(bundleDirectory, "approval.json"), `${JSON.stringify(approval, null, 2)}\n`, "utf8"),
    writeFile(join(bundleDirectory, "current.json"), currentText, "utf8"),
    writeFile(join(bundleDirectory, "record.json"), recordText, "utf8"),
    writeFile(join(bundleDirectory, "policy.json"), policyText, "utf8"),
    writeFile(join(bundleDirectory, "pre-publish-dist-tags.json"), `${JSON.stringify(distTagSnapshot, null, 2)}\n`, "utf8")
  ]);
  console.log(`Prepared exact one-time bootstrap bundle: ${bundleDirectory}`);
}

async function verifyCleanInstall({ version, integrity, tarballUrl, record, expectedPackagePaths }) {
  const npmCli = process.env.npm_execpath;
  assert(
    typeof npmCli === "string" && npmCli.length > 0,
    "Bootstrap registry verification must be launched through an npm script"
  );
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-tools-bootstrap-install-"));
  const cache = join(temporaryDirectory, "npm-cache");
  const userConfig = join(temporaryDirectory, "user.npmrc");
  const globalConfig = join(temporaryDirectory, "global.npmrc");
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase();
    if (upper === "NPM_TOKEN" || upper === "NODE_AUTH_TOKEN" ||
      (upper.startsWith("NPM_CONFIG_") && /(?:AUTH|TOKEN|PASSWORD|USERNAME)/u.test(upper))) {
      delete environment[name];
    }
  }
  Object.assign(environment, {
    NODE_PATH: "",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_REGISTRY: `${registryOrigin}/`,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: userConfig
  });

  try {
    await Promise.all([
      mkdir(cache, { recursive: true }),
      writeFile(userConfig, `registry=${registryOrigin}/\naudit=false\nfund=false\nignore-scripts=true\n`, "utf8"),
      writeFile(globalConfig, "", "utf8"),
      writeFile(join(temporaryDirectory, "package.json"), `${JSON.stringify({ name: "bootstrap-registry-probe", version: "0.0.0", private: true }, null, 2)}\n`, "utf8")
    ]);
    const npmVersion = await runCommand(process.execPath, [npmCli, "--version"], {
      cwd: temporaryDirectory,
      env: environment
    });
    await runCommand(
      process.execPath,
      [npmCli, "install", "--save-exact", "--package-lock=true", "--ignore-scripts", "--no-audit", "--no-fund", `${packageName}@${version}`],
      { cwd: temporaryDirectory, env: environment, stdio: "inherit", timeoutMs: 600_000 }
    );
    const lockfile = await readJson(join(temporaryDirectory, "package-lock.json"));
    const lockEntry = lockfile.packages?.[`node_modules/${packageName}`];
    assert(lockEntry?.version === version, "Clean install resolved the wrong version");
    assert(lockEntry.integrity === integrity, "Clean install integrity differs from registry metadata");
    assert(lockEntry.resolved === tarballUrl, "Clean install resolved a different tarball URL");
    const installed = await digestPackageFiles(join(temporaryDirectory, "node_modules", packageName), expectedPackagePaths);
    assert(installed.digest === record.artifact.unpackedContentDigest, "Clean install content differs from the CandidateRecord");
    assert(installed.files.length === record.artifact.fileCount, "Clean install file count differs from the CandidateRecord");

    const audit = await runCommand(process.execPath, [npmCli, "audit", "signatures", "--json"], {
      cwd: temporaryDirectory,
      env: environment,
      timeoutMs: 600_000
    });
    const auditReport = JSON.parse(audit.stdout);
    assert(Array.isArray(auditReport.invalid) && auditReport.invalid.length === 0, "npm signature audit reported invalid provenance");
    assert(Array.isArray(auditReport.missing) && auditReport.missing.length === 0, "npm signature audit reported missing provenance");
    return {
      npmVersion: npmVersion.stdout.trim(),
      requested: `${packageName}@${version}`,
      resolved: lockEntry.resolved,
      integrity: lockEntry.integrity,
      installedContentDigest: installed.digest,
      installedFileCount: installed.files.length,
      lifecycleScripts: "disabled",
      signatureAudit: "passed"
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function verifyRegistry(args) {
  const version = args.version;
  const expectedSha = sha256Pattern.exec(args["expected-sha256"] ?? "");
  const expectedRecordDigest = args["expected-record-digest"];
  const expectedOwner = args["expected-owner"];
  assert(semverPattern.test(version ?? ""), "--version must be an exact semantic version");
  assert(expectedSha !== null, "--expected-sha256 must be an exact lowercase SHA-256");
  assert(recordDigestPattern.test(expectedRecordDigest ?? ""), "--expected-record-digest is invalid");
  assert(ownerPattern.test(expectedOwner ?? ""), "--expected-owner is not a valid npm owner");
  const expectedTag = assertGitHubBootstrapContext(version);

  for (const name of ["NPM_TOKEN", "NODE_AUTH_TOKEN"]) {
    assert(typeof process.env[name] !== "string" || process.env[name].length === 0, `${name} must not be present in the registry verification job`);
  }
  assert(
    typeof process.env.ACTIONS_ID_TOKEN_REQUEST_URL !== "string" && typeof process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== "string",
    "Registry verification job must not have GitHub OIDC permission"
  );

  const bundleDirectory = resolve(args.bundle ?? join(repositoryRoot, "bootstrap-bundle"));
  const artifactsDirectory = resolve(args.artifacts ?? join(repositoryRoot, ".artifacts", "tools"));
  const evidencePath = resolve(args.evidence ?? join(artifactsDirectory, `${packageName}-${version}-bootstrap-registry-evidence.json`));
  const tarballName = `pi-leetcode-tools-${version}.tgz`;
  const allowed = new Set(["approval.json", "current.json", "policy.json", "pre-publish-dist-tags.json", "record.json", tarballName]);
  const entries = await readdir(bundleDirectory);
  assert(entries.length === allowed.size && entries.every((entry) => allowed.has(entry)), "Bootstrap bundle allowlist mismatch");
  for (const entry of entries) {
    const metadata = await lstat(join(bundleDirectory, entry));
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `Unsafe bootstrap bundle entry: ${entry}`);
  }

  const [approval, current, policy, snapshot, recordBytes, candidateBytes] = await Promise.all([
    readJson(join(bundleDirectory, "approval.json")),
    readJson(join(bundleDirectory, "current.json")),
    readJson(join(bundleDirectory, "policy.json")),
    readJson(join(bundleDirectory, "pre-publish-dist-tags.json")),
    readFile(join(bundleDirectory, "record.json")),
    readFile(join(bundleDirectory, tarballName))
  ]);
  const record = JSON.parse(recordBytes.toString("utf8"));
  assert(approval.evidenceType === "one-time-npm-bootstrap-approval", "Bootstrap approval has the wrong type");
  assert(approval.source?.commit === process.env.GITHUB_SHA && approval.source?.tag === expectedTag, "Bootstrap approval is not bound to this tag and commit");
  assert(approval.source?.workflow === bootstrapWorkflow, "Bootstrap approval names the wrong workflow");
  assert(approval.subject?.version === version && approval.subject?.tarball === tarballName, "Bootstrap approval has the wrong subject");
  assert(approval.subject?.sha256 === `sha256:${expectedSha[1]}`, "Bootstrap approval SHA-256 differs from the input");
  assert(approval.subject?.recordDigest === expectedRecordDigest, "Bootstrap approval record digest differs from the input");
  assert(approval.registry?.expectedOwner === expectedOwner, "Bootstrap approval npm owner differs from the input");
  assert(approval.registry?.packageAbsent === true, "Bootstrap approval did not prove the package was absent");
  assert(approval.policyDigest === sha256Jcs(policy), "Bootstrap approval is not bound to the committed release policy");
  assert(current.recordId === record.recordId && current.recordDigest === expectedRecordDigest, "Bootstrap CandidateRecord pointer is inconsistent");
  assert(`sha256:${sha256(recordBytes)}` === expectedRecordDigest, "Bootstrap CandidateRecord byte digest is invalid");
  assert(record.artifact?.sha256 === `sha256:${expectedSha[1]}`, "Bootstrap CandidateRecord SHA-256 differs from the input");
  assert(sha256(candidateBytes) === expectedSha[1], "Bootstrap candidate tgz differs from the approved bytes");
  assert(record.artifact.bytes === candidateBytes.length, "Bootstrap candidate byte count differs from the CandidateRecord");
  assert(snapshot.state?.packageExists === false && Object.keys(snapshot.state?.distTags ?? {}).length === 0, "Pre-bootstrap registry snapshot was not empty");
  assert(snapshot.stateDigest === stateDigest(snapshot.state), "Pre-bootstrap dist-tag snapshot digest is invalid");
  assert(approval.registry.prePublishStateDigest === snapshot.stateDigest, "Bootstrap approval is not bound to the pre-publish dist-tags");

  const metadataUrl = `${registryOrigin}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const metadata = await (await fetchWithRetry(metadataUrl, { redirect: "error" })).json();
  assert(metadata.name === packageName && metadata.version === version, "Registry metadata has the wrong package identity");
  assert(metadata.deprecated === undefined || metadata.deprecated === "", "Registry version is deprecated");
  assert((metadata.maintainers ?? []).some((entry) => entry?.name === expectedOwner), `Registry maintainers do not include ${expectedOwner}`);
  assert(/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(metadata.dist?.integrity ?? ""), "Registry metadata has no SHA-512 integrity");
  assert(/^[0-9a-f]{40}$/u.test(metadata.dist?.shasum ?? ""), "Registry metadata has no SHA-1 shasum");
  assert(Array.isArray(metadata.dist?.signatures) && metadata.dist.signatures.length > 0, "Registry metadata has no npm signature");
  assert(metadata.dist?.attestations?.provenance?.predicateType === slsaPredicateType, "Registry metadata has no SLSA provenance declaration");
  const tarballUrl = assertRegistryUrl(metadata.dist.tarball, "Registry tarball URL");
  const attestationUrl = assertRegistryUrl(metadata.dist.attestations.url, "Registry attestation URL");

  const tarballResponse = await fetchWithRetry(tarballUrl.href, { headers: { accept: "application/octet-stream" }, redirect: "follow" });
  assertRegistryUrl(tarballResponse.url, "Resolved registry tarball URL");
  const registryBytes = Buffer.from(await tarballResponse.arrayBuffer());
  const registrySha512 = sha512Hex(registryBytes);
  const registryIntegrity = sha512Integrity(registryBytes);
  assert(registryBytes.equals(candidateBytes), "Registry tgz bytes differ from the exact approved tgz");
  assert(sha256(registryBytes) === expectedSha[1], "Registry tgz SHA-256 differs from the exact approved tgz");
  assert(registryIntegrity === metadata.dist.integrity, "Registry tgz integrity differs from metadata");
  assert(sha1(registryBytes) === metadata.dist.shasum, "Registry tgz SHA-1 differs from metadata");
  assert(record.artifact.distIntegrity === registryIntegrity, "Registry integrity differs from the CandidateRecord");
  assert(record.artifact.sha512 === `sha512:${registrySha512}`, "Registry SHA-512 differs from the CandidateRecord");

  const registryDirectory = join(artifactsDirectory, "registry", version);
  await mkdir(registryDirectory, { recursive: true });
  const registryTarball = join(registryDirectory, tarballName);
  await writeFile(registryTarball, registryBytes);
  const extracted = await withExtractedPackage(registryTarball, ({ packageDirectory }) => digestPackageFiles(packageDirectory));
  assert(extracted.digest === record.artifact.unpackedContentDigest, "Extracted registry content differs from the CandidateRecord");
  assert(extracted.files.length === record.artifact.fileCount, "Extracted registry file count differs from the CandidateRecord");

  const attestations = await (await fetchWithRetry(attestationUrl.href, { redirect: "error" })).json();
  const provenance = decodeProvenance(attestations, version, registrySha512);
  const cleanInstall = await verifyCleanInstall({
    version,
    integrity: registryIntegrity,
    tarballUrl: tarballUrl.href,
    record,
    expectedPackagePaths: extracted.files.map((entry) => entry.path)
  });
  await runCommand(process.execPath, [join(repositoryRoot, "packages", "pi-leetcode-tools", "scripts", "test-pi-activation.mjs"), registryTarball], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    timeoutMs: 600_000
  });
  const activationPath = join(registryDirectory, "pi-leetcode-tools-pi-activation-evidence.json");
  const activationBytes = await readFile(activationPath);

  let afterState;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    afterState = await fetchRegistryState();
    const latest = afterState.distTags.latest;
    assert(
      latest === undefined || latest === version,
      `Initial npm publication assigned protected latest to unexpected version ${latest}`
    );
    if (afterState.packageExists && afterState.distTags.next === version) break;
    if (attempt < 12) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  assert(afterState.packageExists && afterState.distTags.next === version, `Registry next tag does not point to ${version}`);
  const latestBefore = snapshot.state.distTags.latest ?? null;
  const latestAfter = afterState.distTags.latest ?? null;
  const latestDisposition = latestAfter === version
    ? "registry_initialized_to_bootstrap_version"
    : "absent";

  const evidence = {
    schemaVersion: 1,
    evidenceType: "one-time-npm-bootstrap-registry-verification",
    generatedAt: new Date().toISOString(),
    subject: {
      package: packageName,
      version,
      recordId: current.recordId,
      bytes: registryBytes.length,
      sha256: `sha256:${expectedSha[1]}`,
      sha512: `sha512:${registrySha512}`,
      integrity: registryIntegrity,
      exactApprovedBytes: true
    },
    registry: {
      origin: registryOrigin,
      metadataUrl,
      tarballUrl: tarballUrl.href,
      owner: expectedOwner,
      shasum: metadata.dist.shasum,
      signatures: metadata.dist.signatures.length
    },
    provenance: {
      ...provenance,
      attestationUrl: attestationUrl.href,
      attestationDigest: sha256Jcs(attestations),
      cryptographicVerification: "npm audit signatures"
    },
    cleanInstall,
    piActivation: {
      status: "passed",
      evidence: `registry/${version}/${basename(activationPath)}`,
      evidenceSha256: `sha256:${sha256(activationBytes)}`
    },
    distTags: {
      next: afterState.distTags.next,
      latestBefore,
      latestAfter,
      latestUnchanged: latestAfter === latestBefore,
      latestMutationRequested: false,
      latestDisposition,
      beforeDigest: snapshot.stateDigest,
      afterDigest: stateDigest(afterState)
    },
    credentialBoundary: {
      npmTokenPresent: false,
      nodeAuthTokenPresent: false,
      oidcPermissionPresent: false
    }
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Verified exact npm bootstrap release: ${packageName}@${version}`);
  console.log(`Evidence: ${evidencePath}`);
}

const args = parseArgs(process.argv.slice(2));
assert(args.command === "prepare" || args.command === "verify", "Expected bootstrap command: prepare | verify");
const allowed = new Set([
  "command",
  "version",
  "expected-sha256",
  "expected-record-digest",
  "expected-owner",
  "confirmation",
  "artifacts",
  "bundle",
  "evidence"
]);
for (const key of Object.keys(args)) assert(allowed.has(key), `Unknown bootstrap argument: --${key}`);
if (args.command === "prepare") await prepareBundle(args);
else await verifyRegistry(args);
