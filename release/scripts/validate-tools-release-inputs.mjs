import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  runCommand,
  sha256Jcs
} from "../../packages/pi-leetcode-tools/scripts/release-utils.mjs";
import {
  assertRegularPublishVersion,
  createDistTagSnapshot,
  parseStableVersion
} from "./dist-tag-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageName = "pi-leetcode-tools";
const currentPath = "release/candidates/tools/current.json";
const policyPath = "release/tools-release-policy.json";
const artifactsDirectory = join(repositoryRoot, ".artifacts", "tools");
const allowedBundleDirectory = join(
  repositoryRoot,
  ".artifacts",
  "release-bundle",
  "tools"
);
const allowedSnapshotDirectory = join(
  repositoryRoot,
  ".artifacts",
  "committed-release",
  "tools"
);
const allowedModes = new Set(["dry-run", "publish-latest"]);
const sha256Pattern = /^(?:sha256:)?([0-9a-f]{64})$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const ownerPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/u;

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    assert(key?.startsWith("--"), `Unexpected release argument: ${key ?? "<missing>"}`);
    const name = key.slice(2);
    assert(!Object.hasOwn(parsed, name), `Duplicate release argument: --${name}`);
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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function committedText(path) {
  const { stdout } = await runCommand("git", ["show", `HEAD:${path}`], {
    cwd: repositoryRoot
  });
  return stdout;
}

async function registryState(policy, version) {
  const url = `${policy.registry}/${encodeURIComponent(packageName)}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error"
  });
  if (response.status === 404) {
    return {
      packageExists: false,
      versionExists: false,
      maintainers: [],
      distTags: {}
    };
  }
  assert(response.ok, `npm registry preflight failed with HTTP ${response.status}`);
  const packument = await response.json();
  assert(packument.name === packageName, "npm registry preflight returned the wrong package");
  return {
    packageExists: true,
    versionExists: Object.hasOwn(packument.versions ?? {}, version),
    maintainers: (packument.maintainers ?? [])
      .map((entry) => entry?.name)
      .filter((name) => typeof name === "string")
      .sort(),
    distTags: Object.fromEntries(
      Object.entries(packument["dist-tags"] ?? {}).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    )
  };
}

const args = parseArgs(process.argv.slice(2));
const allowedArguments = new Set([
  "mode",
  "version",
  "expected-sha256",
  "expected-record-digest",
  "confirmation",
  "bundle",
  "snapshot"
]);
for (const key of Object.keys(args)) {
  assert(allowedArguments.has(key), `Unknown release argument: --${key}`);
}

const mode = args.mode;
const version = args.version;
const expectedShaMatch = sha256Pattern.exec(args["expected-sha256"] ?? "");
const expectedRecordDigest = args["expected-record-digest"];
const bundleDirectory = resolve(args.bundle ?? allowedBundleDirectory);
const snapshotDirectory = resolve(args.snapshot ?? allowedSnapshotDirectory);
assert(allowedModes.has(mode), `--mode must be one of: ${[...allowedModes].join(", ")}`);
parseStableVersion(version, "--version");
assert(expectedShaMatch !== null, "--expected-sha256 must be an exact lowercase SHA-256 digest");
assert(digestPattern.test(expectedRecordDigest ?? ""), "--expected-record-digest must be an exact SHA-256 digest");
assert(bundleDirectory === allowedBundleDirectory, `--bundle must be ${allowedBundleDirectory}`);
assert(snapshotDirectory === allowedSnapshotDirectory, `--snapshot must be ${allowedSnapshotDirectory}`);

const committedPolicyText = await committedText(policyPath);
const policy = JSON.parse(committedPolicyText);
assert(policy.schemaVersion === 2 && policy.packageName === packageName, "Committed Tools release policy is invalid");
assert(policy.registry === "https://registry.npmjs.org", "Tools release policy must use the public npm registry");
assert(
  policy.publishDistTag === "latest" && policy.preserveOtherDistTags === true,
  "Tools regular release policy must publish latest and preserve every other dist-tag"
);
assert(
  policy.bootstrap?.publishDistTag === "next" &&
    policy.bootstrap?.protectedDistTag === "latest",
  "Tools bootstrap release policy dist-tags are invalid"
);
assert(policy.bootstrap?.packageMustAlreadyExist === true, "Regular OIDC release must require an existing npm package");

const expectedTag = `${policy.releaseTagPrefix}${version}`;
const { stdout: headOutput } = await runCommand("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot
});
const { stdout: tagOutput } = await runCommand(
  "git",
  ["rev-parse", `refs/tags/${expectedTag}^{commit}`],
  { cwd: repositoryRoot }
);
const headCommit = headOutput.trim().toLowerCase();
const tagCommit = tagOutput.trim().toLowerCase();
assert(/^[0-9a-f]{40}$/u.test(headCommit), "HEAD is not an exact Git commit");
assert(tagCommit === headCommit, `HEAD is not the peeled commit of tag ${expectedTag}`);

if (process.env.GITHUB_ACTIONS === "true") {
  assert(process.env.GITHUB_EVENT_NAME === "workflow_dispatch", "Release validation is allowed only from workflow_dispatch");
  assert(process.env.GITHUB_REF_TYPE === "tag", "Release validation requires a Git tag ref");
  assert(process.env.GITHUB_REF_NAME === expectedTag, `Release validation requires tag ${expectedTag}`);
  assert((process.env.GITHUB_SHA ?? "").toLowerCase() === headCommit, "GITHUB_SHA differs from the checked-out tag commit");
  assert(/\.github\/workflows\/release-tools\.yml@refs\/tags\//u.test(process.env.GITHUB_WORKFLOW_REF ?? ""), "Release validation must run from release-tools.yml at a tag ref");
}

let mainlineAncestorVerified = false;
if (policy.source?.requireMainlineAncestor === true) {
  await runCommand(
    "git",
    ["merge-base", "--is-ancestor", policy.source.mainlineRef, headCommit],
    { cwd: repositoryRoot }
  );
  mainlineAncestorVerified = true;
}

const committedCurrentText = await committedText(currentPath);
const current = JSON.parse(committedCurrentText);
assert(current.packageName === packageName && current.packageVersion === version, "Committed current.json does not match the requested package/version");
assert(basename(current.recordFile) === current.recordFile, "Committed current.json has an unsafe record filename");
assert(current.recordDigest === expectedRecordDigest, "Committed current.json does not match --expected-record-digest");

const recordPath = `release/candidates/tools/${current.recordFile}`;
const committedRecordText = await committedText(recordPath);
const record = JSON.parse(committedRecordText);
assert(`sha256:${sha256(committedRecordText)}` === current.recordDigest, "Committed CandidateRecord byte digest is invalid");
assert(record.recordId === current.recordId, "Committed CandidateRecord ID differs from current.json");
assert(record.subject?.packageName === packageName && record.subject?.packageVersion === version, "Committed CandidateRecord subject is invalid");
assert(record.driftPolicy?.allowed === false, "Committed CandidateRecord permits drift");

const [snapshotCurrent, snapshotRecord, snapshotPolicy, snapshotManifest] =
  await Promise.all([
    readFile(join(snapshotDirectory, "current.json"), "utf8"),
    readFile(join(snapshotDirectory, "record.json"), "utf8"),
    readFile(join(snapshotDirectory, "policy.json"), "utf8"),
    readJson(join(snapshotDirectory, "snapshot.json"))
  ]);
assert(snapshotCurrent === committedCurrentText, "Pre-build current.json snapshot differs from the tagged commit");
assert(snapshotRecord === committedRecordText, "Pre-build CandidateRecord snapshot differs from the tagged commit");
assert(snapshotPolicy === committedPolicyText, "Pre-build release-policy snapshot differs from the tagged commit");
assert(
  snapshotManifest.commit === headCommit &&
    snapshotManifest.tag === expectedTag &&
    snapshotManifest.recordDigest === expectedRecordDigest &&
    snapshotManifest.artifactSha256 === `sha256:${expectedShaMatch[1]}`,
  "Pre-build committed-record snapshot manifest is invalid"
);

const [worktreeCurrent, worktreeRecord, worktreePolicy] = await Promise.all([
  readFile(join(repositoryRoot, currentPath), "utf8"),
  readFile(join(repositoryRoot, recordPath), "utf8"),
  readFile(join(repositoryRoot, policyPath), "utf8")
]);
assert(worktreeCurrent === committedCurrentText, "Build changed or dirtied committed current.json");
assert(worktreeRecord === committedRecordText, "Build changed or dirtied the committed CandidateRecord");
assert(worktreePolicy === committedPolicyText, "Release policy differs from the tagged commit");

const committedPackage = JSON.parse(
  await committedText("packages/pi-leetcode-tools/package.json")
);
assert(committedPackage.name === packageName && committedPackage.version === version, "Committed package.json does not match the requested version");

const tarballPath = join(artifactsDirectory, record.artifact.file);
const tarballBytes = await readFile(tarballPath);
const actualSha256 = sha256(tarballBytes);
const expectedSha256 = expectedShaMatch[1];
assert(record.artifact.sha256 === `sha256:${actualSha256}`, "Committed CandidateRecord is not bound to the built tarball");
assert(record.artifact.bytes === tarballBytes.length, "Committed CandidateRecord tarball size is invalid");
assert(actualSha256 === expectedSha256, "Built tarball SHA-256 does not match --expected-sha256");

const registry = await registryState(policy, version);
const configuredOwner = policy.expectedNpmOwner;
const ownerConfigured =
  typeof configuredOwner === "string" && ownerPattern.test(configuredOwner);
const trustedPublisherConfigured =
  policy.trustedPublisher?.configured === true &&
  policy.trustedPublisher?.workflow === ".github/workflows/release-tools.yml" &&
  policy.trustedPublisher?.environment === "npm-tools-next" &&
  typeof policy.trustedPublisher?.evidenceReference === "string" &&
  policy.trustedPublisher.evidenceReference.length > 0;

if (registry.packageExists) {
  assertRegularPublishVersion({
    requestedVersion: version,
    versionExists: registry.versionExists,
    latestVersion: registry.distTags.latest
  });
}

if (mode === "publish-latest") {
  const expectedConfirmation = `publish ${packageName}@${version} to latest`;
  assert(args.confirmation === expectedConfirmation, `--confirmation must equal: ${expectedConfirmation}`);
  assert(
    registry.packageExists,
    `[bootstrap_required] ${packageName} does not exist in npm. The regular OIDC workflow cannot perform first-package bootstrap; follow the committed external bootstrap policy first.`
  );
  assert(ownerConfigured, "Committed release policy has no reviewed expectedNpmOwner");
  assert(registry.maintainers.includes(configuredOwner), `Registry maintainers do not include committed owner ${configuredOwner}`);
  assert(
    trustedPublisherConfigured,
    "Committed release policy does not attest that the npm trusted publisher and protected environment were externally configured"
  );
}

const releaseBlockers = [];
if (!registry.packageExists) releaseBlockers.push("bootstrap_required");
if (!ownerConfigured) releaseBlockers.push("expected_npm_owner_unconfigured");
if (!trustedPublisherConfigured) releaseBlockers.push("trusted_publisher_external_gate_unconfirmed");
if (policy.source?.tagProtectionEvidenceGate === "external_required") {
  releaseBlockers.push("tag_protection_external_gate");
}
if (policy.source?.requireMainlineAncestor !== true) {
  releaseBlockers.push("mainline_ancestor_not_machine_required");
}

await rm(bundleDirectory, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100
});
await mkdir(bundleDirectory, { recursive: true });
await Promise.all([
  copyFile(tarballPath, join(bundleDirectory, basename(tarballPath))),
  writeFile(join(bundleDirectory, "current.json"), committedCurrentText, "utf8"),
  writeFile(join(bundleDirectory, "record.json"), committedRecordText, "utf8"),
  writeFile(join(bundleDirectory, "policy.json"), committedPolicyText, "utf8")
]);

const distTagState = {
  packageExists: registry.packageExists,
  distTags: registry.distTags
};
const distTagSnapshot = createDistTagSnapshot({
  registry: policy.registry,
  packageName,
  publishTag: policy.publishDistTag,
  preserveOtherDistTags: policy.preserveOtherDistTags,
  state: distTagState
});
await writeFile(
  join(bundleDirectory, "pre-publish-dist-tags.json"),
  `${JSON.stringify(distTagSnapshot, null, 2)}\n`,
  "utf8"
);

const approval = {
  schemaVersion: 1,
  evidenceType: "committed-tools-release-approval",
  generatedAt: new Date().toISOString(),
  mode,
  subject: {
    package: packageName,
    version,
    tarball: basename(tarballPath),
    bytes: tarballBytes.length,
    sha256: `sha256:${actualSha256}`,
    recordId: current.recordId,
    recordDigest: current.recordDigest,
    committedRecordFile: current.recordFile
  },
  source: {
    commit: headCommit,
    tag: expectedTag,
    tagPeeledToHead: true,
    mainlineAncestorVerified,
    tagProtectionEvidenceGate: policy.source?.tagProtectionEvidenceGate
  },
  policy: {
    digest: sha256Jcs(policy),
    expectedNpmOwner: configuredOwner,
    publishDistTag: policy.publishDistTag,
    preserveOtherDistTags: policy.preserveOtherDistTags,
    trustedPublisher: policy.trustedPublisher,
    bootstrap: policy.bootstrap
  },
  registryPreflight: registry,
  releaseBlockers
};
await writeFile(
  join(bundleDirectory, "approval.json"),
  `${JSON.stringify(approval, null, 2)}\n`,
  "utf8"
);

console.log(
  JSON.stringify(
    {
      mode,
      package: packageName,
      version,
      tag: expectedTag,
      commit: headCommit,
      tarball: basename(tarballPath),
      sha256: actualSha256,
      recordId: current.recordId,
      recordDigest: current.recordDigest,
      bundle: bundleDirectory,
      registryPackageExists: registry.packageExists,
      releaseBlockers,
      publishAuthorized: mode === "publish-latest"
    },
    null,
    2
  )
);
