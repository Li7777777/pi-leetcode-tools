import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { distTagStateDigest } from "../scripts/dist-tag-policy.mjs";
import {
  buildBundle,
  prepareGitHubReleaseBundle,
  publicAssetNames,
  validateReleaseEvidence
} from "../scripts/prepare-tools-github-release.mjs";
import {
  loadGitHubReleaseBundle,
  peelGitTagReference,
  planGitHubRelease
} from "../scripts/publish-tools-github-release.mjs";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = (bytes) => `sha256:${sha256Hex(bytes)}`;
const sha512Hex = (bytes) => createHash("sha512").update(bytes).digest("hex");
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

function releaseFixture() {
  const version = "1.2.3";
  const names = publicAssetNames(version);
  const sourceNames = {
    piActivation: "pi-leetcode-tools-pi-activation-evidence.json",
    releaseEvidence: "pi-leetcode-tools-release-evidence.json",
    sbom: "pi-leetcode-tools-sbom.cdx.json"
  };
  const repository = "example/pi-leetcode-tools";
  const ref = `refs/tags/pi-leetcode-tools-v${version}`;
  const commit = "a".repeat(40);
  const expectedRecordDigest = `sha256:${"b".repeat(64)}`;
  const tarball = Buffer.from("exact npm tgz fixture bytes\n", "utf8");
  const expectedSha256 = sha256Hex(tarball);
  const piActivation = {
    schemaVersion: "1.0.0",
    evidenceType: "pi-package-activation",
    generatedAt: "2026-07-20T00:00:00.000Z",
    subject: {
      name: "pi-leetcode-tools",
      version,
      file: names.tarball,
      bytes: tarball.length,
      sha512: sha512Hex(tarball),
      distIntegrity: integrity(tarball)
    },
    activation: { activeTools: ["daily_question"] }
  };
  const piActivationBytes = jsonBytes(piActivation);
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "pi-leetcode-tools",
        version,
        hashes: [{ alg: "SHA-256", content: expectedSha256 }]
      }
    },
    components: [],
    dependencies: []
  };
  const sbomBytes = jsonBytes(sbom);
  const releaseEvidence = {
    schemaVersion: "1.0.0",
    evidenceType: "release-supply-chain",
    generatedAt: "2026-07-20T00:00:01.000Z",
    subject: {
      name: "pi-leetcode-tools",
      version,
      file: names.tarball,
      bytes: tarball.length,
      sha256: expectedSha256,
      sha512: sha512Hex(tarball),
      distIntegrity: integrity(tarball)
    },
    piActivation,
    source: { revision: commit, source: "GITHUB_SHA" },
    artifacts: {
      sbom: {
        file: sourceNames.sbom,
        format: "CycloneDX",
        specVersion: "1.5",
        sha256: sha256Hex(sbomBytes)
      }
    }
  };
  const releaseEvidenceBytes = jsonBytes(releaseEvidence);
  const distTagTransition = {
    schemaVersion: 2,
    evidenceType: "npm-dist-tag-invariant",
    generatedAt: "2026-07-20T00:00:02.000Z",
    registry: "https://registry.npmjs.org",
    package: "pi-leetcode-tools",
    publishTag: "latest",
    publishedVersion: version,
    latestBefore: "1.2.2",
    latestAfter: version,
    latestMatchesPublishedVersion: true,
    nonTargetTagsUnchanged: true,
    beforeTags: { latest: "1.2.2", next: "1.2.1" },
    afterTags: { latest: version, next: "1.2.1" },
    beforeDigest: distTagStateDigest({ packageExists: true, distTags: { latest: "1.2.2", next: "1.2.1" } }),
    afterDigest: distTagStateDigest({ packageExists: true, distTags: { latest: version, next: "1.2.1" } })
  };
  const distTagTransitionBytes = jsonBytes(distTagTransition);
  const formalRegistry = {
    schemaVersion: 2,
    evidenceType: "formal-registry-release",
    generatedAt: "2026-07-20T00:00:03.000Z",
    sourceMode: "formal_registry",
    subject: {
      package: "pi-leetcode-tools",
      version,
      recordId: "fixture-record",
      recordDigest: expectedRecordDigest,
      bytes: tarball.length,
      sha256: `sha256:${expectedSha256}`,
      sha512: `sha512:${sha512Hex(tarball)}`,
      integrity: integrity(tarball)
    },
    registry: {
      origin: "https://registry.npmjs.org",
      publishDistTag: "latest",
      latest: version
    },
    cleanInstall: {
      requested: "pi-leetcode-tools@latest",
      resolvedVersion: version
    },
    provenance: {
      repository: `https://github.com/${repository}`,
      workflowPath: "/.github/workflows/release-tools.yml",
      ref,
      gitCommit: commit
    },
    piActivation: {
      status: "passed",
      evidence: `registry/${version}/${sourceNames.piActivation}`,
      evidenceSha256: sha256(piActivationBytes)
    },
    supplyChain: {
      status: "passed",
      evidence: `registry/${version}/${sourceNames.releaseEvidence}`,
      evidenceSha256: sha256(releaseEvidenceBytes),
      sbom: `registry/${version}/${sourceNames.sbom}`,
      sbomSha256: sha256(sbomBytes)
    }
  };
  const formalRegistryBytes = jsonBytes(formalRegistry);
  return {
    version,
    names,
    sourceNames,
    expectedSha256,
    expectedRecordDigest,
    repository,
    ref,
    commit,
    candidateTarball: tarball,
    registryTarball: Buffer.from(tarball),
    duplicateTarballPaths: ["approved.tgz", "registry.tgz"],
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
  };
}

test("prepare validation binds both tgz copies, provenance, evidence, and latest transition", () => {
  const fixture = releaseFixture();
  const validated = validateReleaseEvidence(fixture);
  assert.equal(validated.tag, "pi-leetcode-tools-v1.2.3");
  assert.equal(validated.expectedRecordDigest, fixture.expectedRecordDigest);
  const bundle = buildBundle(validated);
  assert.equal(bundle.manifest.assets.length, 7);
  assert.deepEqual(
    new Set(bundle.manifest.assets.map((asset) => asset.name)),
    new Set(Object.values(fixture.names))
  );
  assert.match(bundle.releaseNotes, /npm dist-tag: `latest`/u);
  assert.doesNotMatch(bundle.releaseNotes, /latest.*next|next.*latest/iu);
});

test("prepare validation fails closed on duplicate, provenance, record, and dist-tag drift", () => {
  const fixture = releaseFixture();
  assert.throws(
    () => validateReleaseEvidence({ ...fixture, duplicateTarballPaths: [...fixture.duplicateTarballPaths, "third.tgz"] }),
    /exactly the approved and registry copies/u
  );
  assert.throws(
    () => validateReleaseEvidence({
      ...fixture,
      formalRegistry: {
        ...fixture.formalRegistry,
        provenance: { ...fixture.formalRegistry.provenance, gitCommit: "f".repeat(40) }
      }
    }),
    /wrong release commit/u
  );
  assert.throws(
    () => validateReleaseEvidence({
      ...fixture,
      formalRegistry: {
        ...fixture.formalRegistry,
        subject: { ...fixture.formalRegistry.subject, recordDigest: `sha256:${"e".repeat(64)}` }
      }
    }),
    /wrong CandidateRecord digest/u
  );
  assert.throws(
    () => validateReleaseEvidence({
      ...fixture,
      distTagTransition: { ...fixture.distTagTransition, afterTags: { latest: fixture.version, next: fixture.version } }
    }),
    /after digest|changed non-target tag next/u
  );
  assert.throws(
    () => validateReleaseEvidence({
      ...fixture,
      distTagTransition: { ...fixture.distTagTransition, latestAfter: "1.2.2" }
    }),
    /does not move latest/u
  );
});

test("prepared directory contains exactly seven public assets plus manifest and notes", async (context) => {
  const fixture = releaseFixture();
  const root = await mkdtemp(join(tmpdir(), "pi-tools-github-release-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = join(root, "artifacts");
  const registry = join(artifacts, "registry", fixture.version);
  const output = join(root, "bundle");
  await mkdir(registry, { recursive: true });
  await Promise.all([
    writeFile(join(artifacts, fixture.names.tarball), fixture.candidateTarball),
    writeFile(join(registry, fixture.names.tarball), fixture.registryTarball),
    writeFile(join(artifacts, fixture.names.formalRegistry), fixture.formalRegistryBytes),
    writeFile(join(artifacts, fixture.names.distTagTransition), fixture.distTagTransitionBytes),
    writeFile(join(registry, fixture.sourceNames.piActivation), fixture.piActivationBytes),
    writeFile(join(registry, fixture.sourceNames.releaseEvidence), fixture.releaseEvidenceBytes),
    writeFile(join(registry, fixture.sourceNames.sbom), fixture.sbomBytes)
  ]);
  const result = await prepareGitHubReleaseBundle({
    version: fixture.version,
    expectedSha256: fixture.expectedSha256,
    expectedRecordDigest: fixture.expectedRecordDigest,
    artifactsDirectory: artifacts,
    outputDirectory: output,
    repository: fixture.repository,
    ref: fixture.ref,
    commit: fixture.commit
  });
  assert.equal(result.manifest.assets.length, 7);
  assert.deepEqual((await readdir(output)).sort(), [
    ...Object.values(fixture.names),
    "manifest.json",
    "release-notes.md"
  ].sort());
  const loaded = await loadGitHubReleaseBundle(output);
  assert.equal(loaded.assets.length, 7);
  const checksumText = await readFile(join(output, "SHA256SUMS.txt"), "utf8");
  assert.equal(checksumText.trimEnd().split("\n").length, 6);
});

function plannerBundle() {
  const validated = validateReleaseEvidence(releaseFixture());
  const built = buildBundle(validated);
  return {
    manifest: built.manifest,
    body: built.releaseNotes
  };
}

function matchingRelease(bundle, overrides = {}) {
  return {
    id: 123,
    tag_name: bundle.manifest.release.tag,
    name: bundle.manifest.release.title,
    body: bundle.body,
    draft: true,
    prerelease: false,
    ...overrides
  };
}

function matchingAssets(bundle) {
  return bundle.manifest.assets.map((asset, index) => ({
    id: index + 1,
    name: asset.name,
    state: "uploaded",
    size: asset.size,
    sha256: asset.sha256
  }));
}

function matchingPredecessor(bundle, overrides = {}) {
  return {
    id: 122,
    tag_name: bundle.manifest.release.previousTag,
    draft: false,
    prerelease: false,
    ...overrides
  };
}

test("publisher planner creates, resumes, and no-ops without replacing assets", () => {
  const bundle = plannerBundle();
  const create = planGitHubRelease({
    bundle,
    existingRelease: null,
    existingAssets: [],
    repositoryLatestRelease: matchingPredecessor(bundle)
  });
  assert.equal(create.action, "create-draft");
  assert.equal(create.upload.length, 7);

  const assets = matchingAssets(bundle);
  const resume = planGitHubRelease({
    bundle,
    existingRelease: matchingRelease(bundle),
    existingAssets: assets.slice(0, 3),
    repositoryLatestRelease: matchingPredecessor(bundle)
  });
  assert.equal(resume.action, "resume-draft");
  assert.equal(resume.upload.length, 4);

  const noop = planGitHubRelease({
    bundle,
    existingRelease: matchingRelease(bundle, { draft: false }),
    existingAssets: assets,
    repositoryLatestRelease: matchingRelease(bundle, { draft: false })
  });
  assert.deepEqual(noop, { action: "no-op", upload: [] });
});

test("publisher planner fails closed on metadata, asset, completeness, or latest drift", () => {
  const bundle = plannerBundle();
  const assets = matchingAssets(bundle);
  assert.throws(
    () => planGitHubRelease({
      bundle,
      existingRelease: matchingRelease(bundle, { body: "different" }),
      existingAssets: [],
      repositoryLatestRelease: matchingPredecessor(bundle)
    }),
    /body differs/u
  );
  assert.throws(
    () => planGitHubRelease({
      bundle,
      existingRelease: matchingRelease(bundle),
      existingAssets: [{ ...assets[0], sha256: `sha256:${"0".repeat(64)}` }],
      repositoryLatestRelease: matchingPredecessor(bundle)
    }),
    /different SHA-256/u
  );
  assert.throws(
    () => planGitHubRelease({
      bundle,
      existingRelease: matchingRelease(bundle),
      existingAssets: [...assets, { name: "unexpected.txt", size: 1, sha256: `sha256:${"0".repeat(64)}` }],
      repositoryLatestRelease: matchingPredecessor(bundle)
    }),
    /unexpected asset/u
  );
  assert.throws(
    () => planGitHubRelease({
      bundle,
      existingRelease: matchingRelease(bundle, { draft: false }),
      existingAssets: assets.slice(0, 6),
      repositoryLatestRelease: matchingRelease(bundle, { draft: false })
    }),
    /missing assets/u
  );
  assert.throws(
    () => planGitHubRelease({
      bundle,
      existingRelease: matchingRelease(bundle, { draft: false }),
      existingAssets: assets,
      repositoryLatestRelease: { ...matchingRelease(bundle, { draft: false }), id: 999 }
    }),
    /not the repository latest release/u
  );
  assert.throws(
    () => planGitHubRelease({
      bundle,
      existingRelease: null,
      existingAssets: [],
      repositoryLatestRelease: matchingPredecessor(bundle, { tag_name: "pi-leetcode-tools-v9.0.0" })
    }),
    /expected predecessor/u
  );
  const rollbackBundle = structuredClone(bundle);
  rollbackBundle.manifest.release.previousVersion = "9.0.0";
  rollbackBundle.manifest.release.previousTag = "pi-leetcode-tools-v9.0.0";
  assert.throws(
    () => planGitHubRelease({
      bundle: rollbackBundle,
      existingRelease: null,
      existingAssets: [],
      repositoryLatestRelease: matchingPredecessor(rollbackBundle)
    }),
    /move latest backwards/u
  );
});

test("tag peeling accepts direct and annotated tags but rejects cycles", async () => {
  const commit = "a".repeat(40);
  assert.equal(
    await peelGitTagReference({ object: { type: "commit", sha: commit } }, async () => assert.fail("unexpected lookup")),
    commit
  );
  const tagSha = "b".repeat(40);
  assert.equal(
    await peelGitTagReference(
      { object: { type: "tag", sha: tagSha } },
      async (sha) => ({ sha, object: { type: "commit", sha: commit } })
    ),
    commit
  );
  await assert.rejects(
    peelGitTagReference(
      { object: { type: "tag", sha: tagSha } },
      async (sha) => ({ sha, object: { type: "tag", sha } })
    ),
    /cycle/u
  );
});
