import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertRegularPublishVersion,
  compareStableVersions,
  createDistTagSnapshot,
  createLatestTransitionEvidence,
  verifyDistTagSnapshot
} from "../scripts/dist-tag-policy.mjs";

const registry = "https://registry.npmjs.org";
const packageName = "pi-leetcode-tools";

function snapshot(distTags = { latest: "0.1.3", next: "0.1.4" }) {
  return createDistTagSnapshot({
    registry,
    packageName,
    state: { packageExists: true, distTags }
  });
}

test("release policy separates regular latest publication from bootstrap next", async () => {
  const policy = JSON.parse(
    await readFile(new URL("../tools-release-policy.json", import.meta.url), "utf8")
  );
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.publishDistTag, "latest");
  assert.equal(policy.preserveOtherDistTags, true);
  assert.equal(policy.trustedPublisher.environment, "npm-tools-next");
  assert.equal(policy.bootstrap.publishDistTag, "next");
  assert.equal(policy.bootstrap.protectedDistTag, "latest");
});

test("stable version comparison uses numeric SemVer precedence", () => {
  assert.equal(compareStableVersions("0.1.9", "0.1.10"), -1);
  assert.equal(compareStableVersions("2.0.0", "1.999.999"), 1);
  assert.throws(
    () => compareStableVersions("1.2.3+build.1", "1.2.3"),
    /without a prerelease or build metadata/u
  );
  assert.equal(
    compareStableVersions("999999999999999999999.0.0", "999999999999999999998.999.999"),
    1
  );
});

test("regular publication rejects prereleases, immutable versions, and rollback", () => {
  assert.throws(
    () => assertRegularPublishVersion({
      requestedVersion: "0.2.0-rc.1",
      versionExists: false,
      latestVersion: "0.1.9"
    }),
    /stable semantic version without a prerelease/u
  );
  assert.throws(
    () => assertRegularPublishVersion({
      requestedVersion: "0.2.0",
      versionExists: true,
      latestVersion: "0.1.9"
    }),
    /already exists and is immutable/u
  );
  assert.throws(
    () => assertRegularPublishVersion({
      requestedVersion: "0.1.9",
      versionExists: false,
      latestVersion: "0.1.9"
    }),
    /must be greater than current stable latest/u
  );
  assert.throws(
    () => assertRegularPublishVersion({
      requestedVersion: "0.1.8",
      versionExists: false,
      latestVersion: "0.1.9"
    }),
    /must be greater than current stable latest/u
  );
  assert.throws(
    () => assertRegularPublishVersion({
      requestedVersion: "0.2.0",
      versionExists: false,
      latestVersion: undefined
    }),
    /latest version is required/u
  );
  assert.doesNotThrow(() => assertRegularPublishVersion({
    requestedVersion: "0.2.0",
    versionExists: false,
    latestVersion: "0.1.9"
  }));
});

test("latest transition accepts only the target tag moving to the published version", () => {
  const before = snapshot({ beta: "0.2.0-beta.1", latest: "0.1.3", next: "0.1.4" });
  assert.equal(before.schemaVersion, 2);
  assert.equal(before.publishTag, "latest");
  assert.equal(before.preserveOtherDistTags, true);
  const evidence = createLatestTransitionEvidence({
    snapshot: before,
    afterState: {
      packageExists: true,
      distTags: { beta: "0.2.0-beta.1", latest: "0.1.5", next: "0.1.4" }
    },
    publishedVersion: "0.1.5",
    registry,
    packageName
  });

  assert.equal(evidence.publishTag, "latest");
  assert.equal(evidence.latestBefore, "0.1.3");
  assert.equal(evidence.latestAfter, "0.1.5");
  assert.equal(evidence.latestMatchesPublishedVersion, true);
  assert.equal(evidence.nonTargetTagsUnchanged, true);
  assert.deepEqual(evidence.beforeTags, {
    beta: "0.2.0-beta.1",
    latest: "0.1.3",
    next: "0.1.4"
  });
  assert.deepEqual(evidence.afterTags, {
    beta: "0.2.0-beta.1",
    latest: "0.1.5",
    next: "0.1.4"
  });
});

test("latest transition rejects another dist-tag drifting", () => {
  const before = snapshot();
  assert.throws(
    () => createLatestTransitionEvidence({
      snapshot: before,
      afterState: {
        packageExists: true,
        distTags: { latest: "0.1.5", next: "0.1.5" }
      },
      publishedVersion: "0.1.5",
      registry,
      packageName
    }),
    /other than latest changed/u
  );
});

test("latest transition rejects a registry latest mismatch", () => {
  const before = snapshot();
  assert.throws(
    () => createLatestTransitionEvidence({
      snapshot: before,
      afterState: {
        packageExists: true,
        distTags: { latest: "0.1.4", next: "0.1.4" }
      },
      publishedVersion: "0.1.5",
      registry,
      packageName
    }),
    /latest tag does not point to 0\.1\.5/u
  );
});

test("snapshot digest detects tampering", () => {
  const before = snapshot();
  before.state.distTags.latest = "9.9.9";
  assert.throws(
    () => verifyDistTagSnapshot(before, {
      registry,
      packageName,
      publishTag: "latest",
      preserveOtherDistTags: true
    }),
    /snapshot digest is invalid/u
  );
});
