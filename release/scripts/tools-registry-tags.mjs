import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  assertNonTargetDistTagsUnchanged,
  createDistTagSnapshot,
  createLatestTransitionEvidence,
  parseStableVersion,
  verifyDistTagSnapshot
} from "./dist-tag-policy.mjs";

const packageName = "pi-leetcode-tools";
const registryOrigin = "https://registry.npmjs.org";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const parsed = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    assert(key?.startsWith("--"), `Unexpected registry-tag argument: ${key ?? "<missing>"}`);
    const value = rest[index + 1];
    assert(value !== undefined && !value.startsWith("--"), `Missing value for ${key}`);
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function packageUrl() {
  return `${registryOrigin}/${encodeURIComponent(packageName)}`;
}

async function fetchState({ attempts = 1 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(packageUrl(), {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        redirect: "error"
      });
      if (response.status === 404) {
        return { packageExists: false, distTags: {} };
      }
      if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
      const packument = await response.json();
      assert(packument.name === packageName, "Registry packument has the wrong package name");
      const distTags = packument["dist-tags"] ?? {};
      assert(distTags !== null && typeof distTags === "object" && !Array.isArray(distTags), "Registry dist-tags are invalid");
      return {
        packageExists: true,
        distTags: Object.fromEntries(Object.entries(distTags).sort(([left], [right]) => left.localeCompare(right)))
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
  }
  throw lastError;
}

const args = parseArgs(process.argv.slice(2));
assert(args.command === "snapshot" || args.command === "assert", "Expected registry-tags command: snapshot | assert");
assert(args.output, "--output is required");
const output = resolve(args.output);

if (args.command === "snapshot") {
  const state = await fetchState();
  const snapshot = createDistTagSnapshot({
    registry: registryOrigin,
    packageName,
    publishTag: "latest",
    preserveOtherDistTags: true,
    state
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Recorded pre-publish dist-tags: ${output}`);
} else {
  assert(args.snapshot, "--snapshot is required for assert");
  assert(args.version, "--version is required for assert");
  parseStableVersion(args.version, "--version");
  const snapshot = JSON.parse(await readFile(resolve(args.snapshot), "utf8"));
  const beforeState = verifyDistTagSnapshot(snapshot, {
    registry: registryOrigin,
    packageName,
    publishTag: "latest",
    preserveOtherDistTags: true
  });
  assert(beforeState.packageExists, "Regular latest publication requires an existing registry package");

  let state;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    state = await fetchState();
    assertNonTargetDistTagsUnchanged(beforeState, state, "latest");
    if (state.packageExists && state.distTags.latest === args.version) break;
    if (attempt < 12) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
  }
  assert(state.packageExists, `${packageName}@${args.version} is not visible in the registry`);
  const transition = createLatestTransitionEvidence({
    snapshot,
    afterState: state,
    publishedVersion: args.version,
    registry: registryOrigin,
    packageName
  });

  const evidence = {
    schemaVersion: 2,
    evidenceType: "npm-dist-tag-invariant",
    generatedAt: new Date().toISOString(),
    registry: registryOrigin,
    package: packageName,
    preserveOtherDistTags: true,
    ...transition
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Verified latest publication without changing other dist-tags: ${output}`);
}
