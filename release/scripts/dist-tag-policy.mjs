import { createHash } from "node:crypto";

const identifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const exactSemverPattern = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
    `(?:-(${identifier}(?:\\.${identifier})*))?` +
    "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$",
  "u"
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} fields are invalid`
  );
}

function parseVersion(value, label) {
  assert(typeof value === "string", `${label} must be an exact semantic version`);
  const match = exactSemverPattern.exec(value);
  assert(match !== null, `${label} must be an exact semantic version`);
  return {
    value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ?? null,
    build: match[5] ?? null
  };
}

export function parseStableVersion(value, label = "Version") {
  const parsed = parseVersion(value, label);
  assert(
    parsed.prerelease === null && parsed.build === null,
    `${label} must be a stable semantic version without a prerelease or build metadata`
  );
  return parsed;
}

export function compareStableVersions(left, right) {
  const leftVersion = parseStableVersion(left, "Left version");
  const rightVersion = parseStableVersion(right, "Right version");
  for (const key of ["major", "minor", "patch"]) {
    if (leftVersion[key] < rightVersion[key]) return -1;
    if (leftVersion[key] > rightVersion[key]) return 1;
  }
  return 0;
}

export function assertRegularPublishVersion({
  requestedVersion,
  versionExists,
  latestVersion
}) {
  parseStableVersion(requestedVersion, "Requested version");
  assert(
    versionExists !== true,
    `${requestedVersion} already exists and is immutable`
  );
  assert(
    typeof latestVersion === "string" && latestVersion.length > 0,
    "Registry latest version is required for a regular publication"
  );
  parseStableVersion(latestVersion, "Registry latest version");
  assert(
    compareStableVersions(requestedVersion, latestVersion) > 0,
    `Requested version ${requestedVersion} must be greater than current stable latest ${latestVersion}`
  );
}

function normalizeDistTags(distTags) {
  assert(
    distTags !== null && typeof distTags === "object" && !Array.isArray(distTags),
    "Registry dist-tags must be an object"
  );
  const entries = Object.entries(distTags).map(([tag, version]) => {
    assert(
      tag.length > 0 && !/\s/u.test(tag),
      "Registry dist-tag names must be non-empty and contain no whitespace"
    );
    parseVersion(version, `Registry dist-tag ${tag}`);
    return [tag, version];
  });
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

export function normalizeRegistryTagState(state) {
  assert(
    state !== null && typeof state === "object" && !Array.isArray(state),
    "Registry tag state must be an object"
  );
  assertExactKeys(state, ["packageExists", "distTags"], "Registry tag state");
  assert(
    typeof state.packageExists === "boolean",
    "Registry tag state packageExists must be boolean"
  );
  const distTags = normalizeDistTags(state.distTags ?? {});
  assert(
    state.packageExists || Object.keys(distTags).length === 0,
    "A missing registry package cannot have dist-tags"
  );
  return {
    packageExists: state.packageExists,
    distTags
  };
}

export function distTagStateDigest(state) {
  const normalized = normalizeRegistryTagState(state);
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export function createDistTagSnapshot({
  registry,
  packageName,
  state,
  publishTag = "latest",
  preserveOtherDistTags = true
}) {
  assert(
    typeof registry === "string" && registry.length > 0,
    "Snapshot registry is required"
  );
  assert(
    typeof packageName === "string" && packageName.length > 0,
    "Snapshot package is required"
  );
  assert(publishTag === "latest", "Regular publication must target latest");
  assert(
    preserveOtherDistTags === true,
    "Regular publication must preserve all non-target dist-tags"
  );
  const normalizedState = normalizeRegistryTagState(state);
  return {
    schemaVersion: 2,
    evidenceType: "npm-dist-tag-snapshot",
    registry,
    package: packageName,
    publishTag,
    preserveOtherDistTags,
    state: normalizedState,
    stateDigest: distTagStateDigest(normalizedState)
  };
}

export function verifyDistTagSnapshot(snapshot, {
  registry,
  packageName,
  publishTag = "latest",
  preserveOtherDistTags = true
} = {}) {
  assert(
    snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot),
    "Dist-tag snapshot must be an object"
  );
  assertExactKeys(
    snapshot,
    [
      "schemaVersion",
      "evidenceType",
      "registry",
      "package",
      "publishTag",
      "preserveOtherDistTags",
      "state",
      "stateDigest"
    ],
    "Dist-tag snapshot"
  );
  assert(snapshot.schemaVersion === 2, "Dist-tag snapshot must use schemaVersion 2");
  assert(
    snapshot.evidenceType === "npm-dist-tag-snapshot",
    "Dist-tag snapshot has the wrong evidence type"
  );
  if (registry !== undefined) {
    assert(snapshot.registry === registry, "Dist-tag snapshot targets the wrong registry");
  }
  if (packageName !== undefined) {
    assert(snapshot.package === packageName, "Dist-tag snapshot targets the wrong package");
  }
  assert(snapshot.publishTag === publishTag, `Dist-tag snapshot must target ${publishTag}`);
  assert(
    snapshot.preserveOtherDistTags === preserveOtherDistTags,
    "Dist-tag snapshot has the wrong non-target preservation policy"
  );
  const state = normalizeRegistryTagState(snapshot.state);
  assert(snapshot.stateDigest === distTagStateDigest(state), "Dist-tag snapshot digest is invalid");
  return state;
}

function tagsWithoutTarget(distTags, targetTag) {
  return Object.fromEntries(
    Object.entries(distTags).filter(([tag]) => tag !== targetTag)
  );
}

export function assertNonTargetDistTagsUnchanged(
  beforeState,
  afterState,
  targetTag = "latest"
) {
  const before = normalizeRegistryTagState(beforeState);
  const after = normalizeRegistryTagState(afterState);
  assert(
    JSON.stringify(tagsWithoutTarget(before.distTags, targetTag)) ===
      JSON.stringify(tagsWithoutTarget(after.distTags, targetTag)),
    `Registry dist-tags other than ${targetTag} changed during publication`
  );
}

export function createLatestTransitionEvidence({
  snapshot,
  afterState,
  publishedVersion,
  registry,
  packageName
}) {
  parseStableVersion(publishedVersion, "Published version");
  const before = verifyDistTagSnapshot(snapshot, {
    registry,
    packageName,
    publishTag: "latest",
    preserveOtherDistTags: true
  });
  const after = normalizeRegistryTagState(afterState);
  assert(
    after.packageExists,
    `${packageName ?? "Package"}@${publishedVersion} is not visible in the registry`
  );
  assert(
    after.distTags.latest === publishedVersion,
    `Registry latest tag does not point to ${publishedVersion}`
  );
  assertNonTargetDistTagsUnchanged(before, after, "latest");
  return {
    publishTag: "latest",
    publishedVersion,
    latestBefore: before.distTags.latest ?? null,
    latestAfter: after.distTags.latest,
    latestMatchesPublishedVersion: true,
    nonTargetTagsUnchanged: true,
    beforeDigest: snapshot.stateDigest,
    afterDigest: distTagStateDigest(after),
    beforeTags: before.distTags,
    afterTags: after.distTags
  };
}
