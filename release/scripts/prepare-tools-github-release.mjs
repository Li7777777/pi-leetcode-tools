#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareStableVersions,
  distTagStateDigest,
  parseStableVersion
} from "./dist-tag-policy.mjs";

const packageName = "pi-leetcode-tools";
const workflowPath = ".github/workflows/release-tools.yml";
const registryOrigin = "https://registry.npmjs.org";
const stableSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

const contentTypes = Object.freeze({
  tarball: "application/gzip",
  json: "application/json",
  sbom: "application/vnd.cyclonedx+json",
  checksums: "text/plain; charset=utf-8"
});

const sourceEvidenceNames = Object.freeze({
  piActivation: `${packageName}-pi-activation-evidence.json`,
  releaseEvidence: `${packageName}-release-evidence.json`,
  sbom: `${packageName}-sbom.cdx.json`
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512Hex(bytes) {
  return createHash("sha512").update(bytes).digest("hex");
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function prefixedSha256(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

function normalizeExpectedSha256(value) {
  const match = /^(?:sha256:)?([0-9a-f]{64})$/u.exec(value ?? "");
  assert(match !== null, "--expected-sha256 must be one exact lowercase SHA-256");
  return match[1];
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertJsonIdentity(value, { name, version, file, bytes }, label) {
  assert(value?.subject?.name === name, `${label} has the wrong subject name`);
  assert(value.subject.version === version, `${label} has the wrong subject version`);
  assert(value.subject.file === file, `${label} has the wrong subject file`);
  assert(value.subject.bytes === bytes, `${label} has the wrong subject byte length`);
}

function assertEvidenceDigest(reference, bytes, label) {
  assert(reference === prefixedSha256(bytes), `${label} digest does not match its exact bytes`);
}

function assertTransition(transition, version) {
  assert(transition?.schemaVersion === 2, "Dist-tag transition evidence must use schemaVersion 2");
  assert(transition.evidenceType === "npm-dist-tag-invariant", "Dist-tag transition evidence has the wrong type");
  assert(transition.registry === registryOrigin, "Dist-tag transition evidence has the wrong registry");
  assert(transition.package === packageName, "Dist-tag transition evidence has the wrong package");
  assert(transition.publishTag === "latest", "Dist-tag transition must target only latest");
  assert(transition.publishedVersion === version, "Dist-tag transition has the wrong published version");
  parseStableVersion(transition.latestBefore, "Previous npm latest");
  assert(compareStableVersions(version, transition.latestBefore) > 0, "Released version must be newer than previous npm latest");
  assert(transition.latestAfter === version, "Dist-tag transition does not move latest to the released version");
  assert(transition.latestMatchesPublishedVersion === true, "Dist-tag transition did not verify latest");
  assert(transition.nonTargetTagsUnchanged === true, "Dist-tag transition changed a non-target tag");
  assert(digestPattern.test(transition.beforeDigest ?? ""), "Dist-tag transition has an invalid before digest");
  assert(digestPattern.test(transition.afterDigest ?? ""), "Dist-tag transition has an invalid after digest");
  assert(
    transition.beforeTags !== null && typeof transition.beforeTags === "object" && !Array.isArray(transition.beforeTags),
    "Dist-tag transition has no beforeTags object"
  );
  assert(
    transition.afterTags !== null && typeof transition.afterTags === "object" && !Array.isArray(transition.afterTags),
    "Dist-tag transition has no afterTags object"
  );
  assert((transition.beforeTags.latest ?? null) === transition.latestBefore, "latestBefore differs from beforeTags");
  assert(transition.afterTags.latest === transition.latestAfter, "latestAfter differs from afterTags");
  assert(
    transition.beforeDigest === distTagStateDigest({ packageExists: true, distTags: transition.beforeTags }),
    "Dist-tag transition before digest does not match beforeTags"
  );
  assert(
    transition.afterDigest === distTagStateDigest({ packageExists: true, distTags: transition.afterTags }),
    "Dist-tag transition after digest does not match afterTags"
  );

  const nonTargetTags = new Set([
    ...Object.keys(transition.beforeTags),
    ...Object.keys(transition.afterTags)
  ]);
  nonTargetTags.delete("latest");
  for (const tag of nonTargetTags) {
    assert(
      Object.hasOwn(transition.beforeTags, tag) === Object.hasOwn(transition.afterTags, tag) &&
        transition.beforeTags[tag] === transition.afterTags[tag],
      `Dist-tag transition changed non-target tag ${tag}`
    );
  }
}

function assertSbom(sbom, version, expectedSha256) {
  assert(sbom?.bomFormat === "CycloneDX" && sbom.specVersion === "1.5", "SBOM is not CycloneDX 1.5");
  const component = sbom.metadata?.component;
  assert(component?.name === packageName, "SBOM root component has the wrong package name");
  assert(component.version === version, "SBOM root component has the wrong version");
  assert(
    Array.isArray(component.hashes) &&
      component.hashes.some((entry) => entry?.alg === "SHA-256" && entry.content === expectedSha256),
    "SBOM root component is not bound to the released tgz SHA-256"
  );
}

function assetIdentity(name, bytes, contentType) {
  assert(basename(name) === name && !name.includes("\0"), `Unsafe GitHub Release asset name: ${name}`);
  return Object.freeze({
    name,
    size: bytes.length,
    sha256: prefixedSha256(bytes),
    contentType
  });
}

export function publicAssetNames(version) {
  assert(stableSemverPattern.test(version ?? ""), "Release version must be stable semantic version");
  return Object.freeze({
    tarball: `${packageName}-${version}.tgz`,
    formalRegistry: `${packageName}-${version}-formal-registry-evidence.json`,
    distTagTransition: `${packageName}-${version}-dist-tag-evidence.json`,
    piActivation: `${packageName}-${version}-pi-activation.json`,
    releaseEvidence: `${packageName}-${version}-release-evidence.json`,
    sbom: `${packageName}-${version}-sbom.cdx.json`,
    checksums: "SHA256SUMS.txt"
  });
}

export function validateReleaseEvidence(input) {
  const {
    version,
    expectedRecordDigest,
    repository,
    ref,
    commit,
    candidateTarball,
    registryTarball,
    duplicateTarballPaths,
    formalRegistry,
    formalRegistryBytes,
    distTagTransition,
    distTagTransitionBytes,
    piActivation,
    piActivationBytes,
    releaseEvidence,
    releaseEvidenceBytes,
    sbom,
    sbomBytes
  } = input;
  const expectedSha256 = normalizeExpectedSha256(input.expectedSha256);
  const names = publicAssetNames(version);
  const tag = `${packageName}-v${version}`;

  assert(digestPattern.test(expectedRecordDigest ?? ""), "--expected-record-digest is invalid");
  assert(repositoryPattern.test(repository ?? ""), "GitHub repository must be one owner/name pair");
  assert(ref === `refs/tags/${tag}`, `GitHub ref must be refs/tags/${tag}`);
  assert(commitPattern.test(commit ?? ""), "GitHub commit must be one lowercase 40-character SHA");
  assert(Array.isArray(duplicateTarballPaths) && duplicateTarballPaths.length === 2, "Expected exactly the approved and registry copies of the release tgz");
  assert(candidateTarball.length === registryTarball.length, "Approved and registry tgz byte lengths differ");
  assert(candidateTarball.equals(registryTarball), "Approved and registry tgz bytes differ");
  assert(sha256Hex(candidateTarball) === expectedSha256, "Release tgz differs from --expected-sha256");

  assert(formalRegistry?.schemaVersion === 2, "Formal registry evidence must use schemaVersion 2");
  assert(formalRegistry.evidenceType === "formal-registry-release", "Formal registry evidence has the wrong type");
  assert(formalRegistry.sourceMode === "formal_registry", "Formal registry evidence has the wrong source mode");
  assert(formalRegistry.subject?.package === packageName, "Formal registry evidence has the wrong package");
  assert(formalRegistry.subject.version === version, "Formal registry evidence has the wrong version");
  assert(formalRegistry.subject.bytes === candidateTarball.length, "Formal registry evidence has the wrong tgz byte length");
  assert(formalRegistry.subject.sha256 === `sha256:${expectedSha256}`, "Formal registry evidence has the wrong tgz SHA-256");
  assert(formalRegistry.subject.recordDigest === expectedRecordDigest, "Formal registry evidence has the wrong CandidateRecord digest");
  assert(formalRegistry.registry?.origin === registryOrigin, "Formal registry evidence has the wrong registry");
  assert(formalRegistry.registry.publishDistTag === "latest", "Formal registry evidence did not verify the latest publication path");
  assert(formalRegistry.registry.latest === version, "Formal registry evidence did not resolve latest to the released version");
  assert(formalRegistry.cleanInstall?.requested === `${packageName}@latest`, "Formal registry evidence did not install through @latest");
  assert(formalRegistry.cleanInstall.resolvedVersion === version, "Formal registry @latest install resolved the wrong version");
  assert(formalRegistry.provenance?.repository === `https://github.com/${repository}`, "Formal provenance has the wrong repository");
  assert(
    String(formalRegistry.provenance.workflowPath ?? "").replace(/^\//u, "") === workflowPath,
    "Formal provenance has the wrong workflow"
  );
  assert(formalRegistry.provenance.ref === ref, "Formal provenance has the wrong release tag ref");
  assert(formalRegistry.provenance.gitCommit === commit, "Formal provenance has the wrong release commit");

  assertTransition(distTagTransition, version);
  assertJsonIdentity(
    piActivation,
    { name: packageName, version, file: names.tarball, bytes: candidateTarball.length },
    "Pi activation evidence"
  );
  assert(piActivation.evidenceType === "pi-package-activation", "Pi activation evidence has the wrong type");
  assert(piActivation.subject.sha512 === sha512Hex(candidateTarball), "Pi activation evidence has the wrong tgz SHA-512");
  assert(piActivation.subject.distIntegrity === sha512Integrity(candidateTarball), "Pi activation evidence has the wrong tgz integrity");

  assertJsonIdentity(
    releaseEvidence,
    { name: packageName, version, file: names.tarball, bytes: candidateTarball.length },
    "Supply-chain release evidence"
  );
  assert(releaseEvidence.evidenceType === "release-supply-chain", "Supply-chain release evidence has the wrong type");
  assert(releaseEvidence.subject.sha256 === expectedSha256, "Supply-chain release evidence has the wrong tgz SHA-256");
  assert(releaseEvidence.source?.revision === commit, "Supply-chain release evidence has the wrong source revision");
  assert(
    JSON.stringify(releaseEvidence.piActivation) === JSON.stringify(piActivation),
    "Supply-chain release evidence does not embed the exact Pi activation evidence"
  );
  assertSbom(sbom, version, expectedSha256);
  assert(releaseEvidence.artifacts?.sbom?.file === sourceEvidenceNames.sbom, "Supply-chain release evidence names the wrong SBOM");
  assert(releaseEvidence.artifacts.sbom.sha256 === sha256Hex(sbomBytes), "Supply-chain release evidence has the wrong SBOM digest");

  const expectedActivationPath = `registry/${version}/${sourceEvidenceNames.piActivation}`;
  const expectedReleaseEvidencePath = `registry/${version}/${sourceEvidenceNames.releaseEvidence}`;
  const expectedSbomPath = `registry/${version}/${sourceEvidenceNames.sbom}`;
  assert(formalRegistry.piActivation?.status === "passed", "Formal registry evidence did not pass Pi activation");
  assert(formalRegistry.piActivation.evidence === expectedActivationPath, "Formal registry evidence names the wrong Pi activation asset");
  assertEvidenceDigest(formalRegistry.piActivation.evidenceSha256, piActivationBytes, "Pi activation evidence");
  assert(formalRegistry.supplyChain?.status === "passed", "Formal registry evidence did not pass supply-chain verification");
  assert(formalRegistry.supplyChain.evidence === expectedReleaseEvidencePath, "Formal registry evidence names the wrong release-evidence asset");
  assertEvidenceDigest(formalRegistry.supplyChain.evidenceSha256, releaseEvidenceBytes, "Supply-chain release evidence");
  assert(formalRegistry.supplyChain.sbom === expectedSbomPath, "Formal registry evidence names the wrong SBOM asset");
  assertEvidenceDigest(formalRegistry.supplyChain.sbomSha256, sbomBytes, "SBOM evidence");

  return Object.freeze({
    packageName,
    version,
    tag,
    title: `${packageName} ${version}`,
    expectedSha256,
    expectedRecordDigest,
    previousVersion: distTagTransition.latestBefore,
    repository,
    ref,
    commit,
    workflow: workflowPath,
    names,
    files: Object.freeze({
      tarball: candidateTarball,
      formalRegistry: formalRegistryBytes,
      distTagTransition: distTagTransitionBytes,
      piActivation: piActivationBytes,
      releaseEvidence: releaseEvidenceBytes,
      sbom: sbomBytes
    })
  });
}

export function createReleaseNotes(validated) {
  return [
    `# ${validated.packageName} ${validated.version}`,
    "",
    `- npm package: \`${validated.packageName}@${validated.version}\``,
    "- npm dist-tag: `latest`",
    `- Git tag: \`${validated.tag}\``,
    `- Previous stable release: \`${validated.packageName}@${validated.previousVersion}\``,
    `- Source commit: \`${validated.commit}\``,
    `- Tarball SHA-256: \`sha256:${validated.expectedSha256}\``,
    `- CandidateRecord digest: \`${validated.expectedRecordDigest}\``,
    `- Provenance workflow: \`${validated.workflow}\``,
    "",
    "The attached seven assets were prepared only after exact npm registry, provenance,",
    "default `@latest` installation, Pi activation, supply-chain, SBOM, and dist-tag",
    "transition verification completed successfully.",
    "",
    "`SHA256SUMS.txt` covers every attached release asset except itself.",
    ""
  ].join("\n");
}

export function buildBundle(validated) {
  const nonChecksumAssets = [
    [validated.names.tarball, validated.files.tarball, contentTypes.tarball],
    [validated.names.formalRegistry, validated.files.formalRegistry, contentTypes.json],
    [validated.names.distTagTransition, validated.files.distTagTransition, contentTypes.json],
    [validated.names.piActivation, validated.files.piActivation, contentTypes.json],
    [validated.names.releaseEvidence, validated.files.releaseEvidence, contentTypes.json],
    [validated.names.sbom, validated.files.sbom, contentTypes.sbom]
  ].map(([name, bytes, contentType]) => ({
    identity: assetIdentity(name, bytes, contentType),
    bytes
  }));
  const checksums = Buffer.from(
    `${nonChecksumAssets
      .map(({ identity }) => identity)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((identity) => `${identity.sha256.slice("sha256:".length)}  ${identity.name}`)
      .join("\n")}\n`,
    "utf8"
  );
  const assets = [
    ...nonChecksumAssets,
    {
      identity: assetIdentity(validated.names.checksums, checksums, contentTypes.checksums),
      bytes: checksums
    }
  ];
  const releaseNotes = createReleaseNotes(validated);
  const releaseNotesBytes = Buffer.from(releaseNotes, "utf8");
  const manifest = {
    schemaVersion: 1,
    bundleType: "pi-leetcode-tools-github-release",
    package: validated.packageName,
    version: validated.version,
    release: {
      tag: validated.tag,
      title: validated.title,
      previousVersion: validated.previousVersion,
      previousTag: `${validated.packageName}-v${validated.previousVersion}`,
      bodyFile: "release-notes.md",
      bodySha256: prefixedSha256(releaseNotesBytes),
      draftFirst: true,
      prerelease: false,
      makeLatest: true
    },
    source: {
      repository: validated.repository,
      ref: validated.ref,
      commit: validated.commit,
      workflow: validated.workflow
    },
    npm: {
      registry: registryOrigin,
      distTag: "latest",
      tarballSha256: `sha256:${validated.expectedSha256}`,
      candidateRecordDigest: validated.expectedRecordDigest
    },
    assets: assets.map(({ identity }) => identity)
  };
  return Object.freeze({ manifest, releaseNotes, assets });
}

async function readRegularFile(path, label) {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be one regular non-symbolic-link file`);
  return readFile(path);
}

function isWithin(path, parent) {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function findNamedFiles(directory, fileName, excludedDirectory) {
  const matches = [];
  async function visit(current) {
    if (excludedDirectory !== undefined && isWithin(current, excludedDirectory)) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      assert(!entry.isSymbolicLink(), `Artifact traversal encountered symbolic link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === fileName) matches.push(resolve(path));
    }
  }
  await visit(directory);
  return matches.sort();
}

export async function prepareGitHubReleaseBundle(options) {
  const artifactsDirectory = resolve(options.artifactsDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  assert(!isWithin(artifactsDirectory, outputDirectory), "GitHub Release output cannot contain the verifier artifact directory");
  const names = publicAssetNames(options.version);
  const registryDirectory = join(artifactsDirectory, "registry", options.version);
  const paths = {
    candidateTarball: join(artifactsDirectory, names.tarball),
    registryTarball: join(registryDirectory, names.tarball),
    formalRegistry: join(artifactsDirectory, names.formalRegistry),
    distTagTransition: join(artifactsDirectory, names.distTagTransition),
    piActivation: join(registryDirectory, sourceEvidenceNames.piActivation),
    releaseEvidence: join(registryDirectory, sourceEvidenceNames.releaseEvidence),
    sbom: join(registryDirectory, sourceEvidenceNames.sbom)
  };
  const duplicateTarballPaths = await findNamedFiles(artifactsDirectory, names.tarball, outputDirectory);
  assert(
    JSON.stringify(duplicateTarballPaths) === JSON.stringify([resolve(paths.candidateTarball), resolve(paths.registryTarball)].sort()),
    `Expected exactly the approved and registry copies of ${names.tarball}; found ${duplicateTarballPaths.join(", ")}`
  );
  const [
    candidateTarball,
    registryTarball,
    formalRegistryBytes,
    distTagTransitionBytes,
    piActivationBytes,
    releaseEvidenceBytes,
    sbomBytes
  ] = await Promise.all([
    readRegularFile(paths.candidateTarball, "Approved tgz"),
    readRegularFile(paths.registryTarball, "Registry tgz"),
    readRegularFile(paths.formalRegistry, "Formal registry evidence"),
    readRegularFile(paths.distTagTransition, "Dist-tag transition evidence"),
    readRegularFile(paths.piActivation, "Pi activation evidence"),
    readRegularFile(paths.releaseEvidence, "Supply-chain release evidence"),
    readRegularFile(paths.sbom, "CycloneDX SBOM")
  ]);
  const validated = validateReleaseEvidence({
    ...options,
    candidateTarball,
    registryTarball,
    duplicateTarballPaths,
    formalRegistryBytes,
    formalRegistry: parseJson(formalRegistryBytes, "Formal registry evidence"),
    distTagTransitionBytes,
    distTagTransition: parseJson(distTagTransitionBytes, "Dist-tag transition evidence"),
    piActivationBytes,
    piActivation: parseJson(piActivationBytes, "Pi activation evidence"),
    releaseEvidenceBytes,
    releaseEvidence: parseJson(releaseEvidenceBytes, "Supply-chain release evidence"),
    sbomBytes,
    sbom: parseJson(sbomBytes, "CycloneDX SBOM")
  });
  const bundle = buildBundle(validated);
  const parentDirectory = dirname(outputDirectory);
  const stagingDirectory = join(parentDirectory, `.${basename(outputDirectory)}.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(parentDirectory, { recursive: true });
  try {
    await mkdir(stagingDirectory);
    await Promise.all([
      ...bundle.assets.map(({ identity, bytes }) => writeFile(join(stagingDirectory, identity.name), bytes, { flag: "wx" })),
      writeFile(join(stagingDirectory, "manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
      writeFile(join(stagingDirectory, "release-notes.md"), bundle.releaseNotes, { encoding: "utf8", flag: "wx" })
    ]);
    try {
      await lstat(outputDirectory);
      throw new Error(`GitHub Release output already exists: ${outputDirectory}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return { outputDirectory, manifest: bundle.manifest };
}

function parseArgs(argv) {
  const allowed = new Set([
    "version",
    "expected-sha256",
    "expected-record-digest",
    "artifacts",
    "output",
    "repository",
    "ref",
    "commit"
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    assert(option?.startsWith("--") && value !== undefined && !value.startsWith("--"), `Invalid argument near ${option ?? "<missing>"}`);
    const name = option.slice(2);
    assert(allowed.has(name), `Unsupported argument: --${name}`);
    assert(!Object.hasOwn(parsed, name), `Duplicate argument: --${name}`);
    parsed[name] = value;
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareGitHubReleaseBundle({
    version: args.version,
    expectedSha256: args["expected-sha256"],
    expectedRecordDigest: args["expected-record-digest"],
    artifactsDirectory: args.artifacts,
    outputDirectory: args.output,
    repository: args.repository,
    ref: args.ref,
    commit: args.commit?.toLowerCase()
  });
  console.log(
    JSON.stringify(
      {
        bundle: result.outputDirectory,
        tag: result.manifest.release.tag,
        publicAssets: result.manifest.assets.length,
        status: "prepared"
      },
      null,
      2
    )
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
