#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseWorkflowPath = join(repositoryRoot, ".github", "workflows", "release-tools.yml");
const ciWorkflowPath = join(repositoryRoot, ".github", "workflows", "ci.yml");
const workflowsDirectory = join(repositoryRoot, ".github", "workflows");
const packagePath = join(repositoryRoot, "package.json");
const policyPath = join(repositoryRoot, "release", "tools-release-policy.json");
const validationScriptPath = join(repositoryRoot, "release", "scripts", "validate-tools-release-inputs.mjs");
const provisionScriptPath = join(repositoryRoot, "release", "scripts", "provision-tools-upstream.mjs");

const fullActionShaPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u;
const ownerPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/u;
const expectedUpstreamPins = Object.freeze([
  Object.freeze({
    spec: "@jinzcdev/leetcode-mcp-server@1.4.0",
    name: "@jinzcdev/leetcode-mcp-server",
    version: "1.4.0",
    file: "jinzcdev-leetcode-mcp-server-1.4.0.tgz",
    bytes: 46_005,
    sha256: "976ffafb49f1a3d2132a119e71af28b2911b4c56480bcb58097fa9d1c9657b56",
    integrity: "sha512-9DewGzg265ob+ld0dq8R2yzK7/k9RCPE/KNKB/3cDAeiIuONPi1OopAzAcAkHpYnXG/xgxDwuy8tokZjX3BTpw=="
  }),
  Object.freeze({
    spec: "leetcode-query@2.0.1",
    name: "leetcode-query",
    version: "2.0.1",
    file: "leetcode-query-2.0.1.tgz",
    bytes: 26_379,
    sha256: "281fbaa950bf82e0b72a7273c2e7f5502ea6eb1dd593079ab5b89f8048b3eff0",
    integrity: "sha512-zvVp5T5C69pmvgaaxIP8OFBfhzIw57TAVPFDK5y2DYDNPW2A5sBSFHAUDgFpbZylO3VeHJWlCBAEgrhs2PHR9Q=="
  })
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedLines(source, label) {
  assert(typeof source === "string" && source.length > 0, `${label} is empty`);
  assert(!source.includes("\t"), `${label} contains tabs; job boundaries are ambiguous`);
  return source.replaceAll("\r\n", "\n").split("\n");
}

function parseWorkflowJobs(source, label) {
  const lines = normalizedLines(source, label);
  const jobsIndexes = lines
    .map((line, index) => line === "jobs:" ? index : -1)
    .filter((index) => index >= 0);
  assert(jobsIndexes.length === 1, `${label} must contain one top-level jobs section`);

  const jobs = new Map();
  const jobsIndex = jobsIndexes[0];
  let activeJob;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const indentation = line.length - line.trimStart().length;
    if (indentation === 0) break;
    if (indentation !== 2) continue;
    const match = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/u.exec(line);
    assert(match !== null, `${label}:${index + 1} has an unsupported job declaration`);
    if (activeJob !== undefined) activeJob.endLine = index;
    activeJob = { id: match[1], startLine: index, endLine: lines.length };
    assert(!jobs.has(activeJob.id), `${label} declares job ${activeJob.id} more than once`);
    jobs.set(activeJob.id, activeJob);
  }
  if (activeJob !== undefined && activeJob.endLine === lines.length) {
    const nextTopLevel = lines.findIndex(
      (line, index) => index > activeJob.startLine && line.trim().length > 0 && !line.startsWith(" ")
    );
    if (nextTopLevel >= 0) activeJob.endLine = nextTopLevel;
  }
  assert(jobs.size > 0, `${label} has no parseable jobs`);
  for (const job of jobs.values()) {
    job.lines = lines.slice(job.startLine, job.endLine);
    job.source = job.lines.join("\n");
  }
  return { jobs, lines };
}

function parseJobPermissions(job, label) {
  const permissionIndexes = job.lines
    .map((line, index) => line === "    permissions:" ? index : -1)
    .filter((index) => index >= 0);
  assert(permissionIndexes.length === 1, `${label} job ${job.id} must declare one explicit permissions block`);
  const permissions = new Map();
  for (let index = permissionIndexes[0] + 1; index < job.lines.length; index += 1) {
    const line = job.lines[index];
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const indentation = line.length - line.trimStart().length;
    if (indentation <= 4) break;
    const match = /^      ([A-Za-z0-9_-]+):\s*([^\s#]+)\s*(?:#.*)?$/u.exec(line);
    assert(match !== null, `${label} job ${job.id} has an unsupported permissions entry`);
    assert(!permissions.has(match[1]), `${label} job ${job.id} repeats permission ${match[1]}`);
    permissions.set(match[1], match[2]);
  }
  assert(permissions.size > 0, `${label} job ${job.id} has an empty permissions block`);
  return permissions;
}

function actionUses(source, label) {
  const uses = [];
  for (const [index, line] of normalizedLines(source, label).entries()) {
    const possibleUsesKey = /(?:^|[{,]\s*)(?:["']?uses["']?)\s*:/u.test(
      line.trimStart().replace(/^-\s*/u, "")
    );
    if (!possibleUsesKey) continue;
    const match = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/u.exec(line);
    assert(match !== null, `${label}:${index + 1} has an unsupported uses declaration`);
    const reference = match[1].replace(/\s+#.*$/u, "").trim();
    assert(reference.length > 0, `${label}:${index + 1} has an empty uses reference`);
    uses.push({ line: index + 1, reference });
  }
  return uses;
}

function verifyActionPins(source, label) {
  const uses = actionUses(source, label);
  for (const entry of uses) {
    if (entry.reference.startsWith("./")) continue;
    assert(
      fullActionShaPattern.test(entry.reference),
      `${label}:${entry.line} action is not pinned to a full lowercase commit SHA: ${entry.reference}`
    );
  }
  return uses.length;
}

function npmRunTargets(command) {
  return [...command.matchAll(/(?:^|[\s;&|()])npm\s+run\s+([A-Za-z0-9][A-Za-z0-9:._-]*)/gu)]
    .map((match) => match[1]);
}

function verifyNoRecordScriptGraph(packageJson, rootScript) {
  const scripts = packageJson.scripts ?? {};
  assert(typeof scripts[rootScript] === "string", `Missing npm script ${rootScript}`);
  const visited = new Set();
  const pending = [rootScript];
  while (pending.length > 0) {
    const scriptName = pending.pop();
    if (visited.has(scriptName)) continue;
    visited.add(scriptName);
    assert(scriptName !== "record:tools", `${rootScript} reaches record:tools`);
    const command = scripts[scriptName];
    assert(typeof command === "string", `${rootScript} reaches undefined npm script ${scriptName}`);
    assert(!/(?:^|[^A-Za-z0-9:._-])record:tools(?:$|[^A-Za-z0-9:._-])/u.test(command), `${scriptName} invokes record:tools`);
    if (command.includes("candidate-record.mjs")) {
      assert(command.includes("--verify-current"), `${scriptName} can write a CandidateRecord from a no-record path`);
    }
    for (const target of npmRunTargets(command)) {
      if (Object.hasOwn(scripts, target)) pending.push(target);
    }
  }
  return visited;
}

function releasePolicyState(policy, { packageExists }) {
  const ownerConfigured = typeof policy.expectedNpmOwner === "string" && ownerPattern.test(policy.expectedNpmOwner);
  const trustedPublisherConfigured =
    policy.trustedPublisher?.configured === true &&
    policy.trustedPublisher?.workflow === ".github/workflows/release-tools.yml" &&
    policy.trustedPublisher?.environment === "npm-tools-next" &&
    typeof policy.trustedPublisher?.evidenceReference === "string" &&
    policy.trustedPublisher.evidenceReference.trim().length > 0;
  const blockers = [];
  if (packageExists !== true) blockers.push("bootstrap_required");
  if (!ownerConfigured) blockers.push("expected_npm_owner_unconfigured");
  if (!trustedPublisherConfigured) blockers.push("trusted_publisher_external_gate_unconfirmed");
  return { blockers, ownerConfigured, trustedPublisherConfigured };
}

function verifyReleasePolicy(policy) {
  assert(policy.schemaVersion === 1, "Tools release policy schemaVersion must be 1");
  assert(policy.packageName === "pi-leetcode-tools", "Tools release policy package is invalid");
  assert(policy.registry === "https://registry.npmjs.org", "Tools release policy registry is not fixed to public npm");
  assert(policy.publishDistTag === "next" && policy.protectedDistTag === "latest", "Tools release policy dist-tags are invalid");
  assert(
    policy.expectedNpmOwner === null || ownerPattern.test(policy.expectedNpmOwner),
    "Tools release policy owner must be null or one exact reviewed npm owner"
  );
  assert(policy.bootstrap?.mode === "external_required", "First-package bootstrap must remain an external gate");
  assert(policy.bootstrap?.packageMustAlreadyExist === true, "Regular OIDC publishing must require an existing package");
  assert(policy.bootstrap?.automationImplemented === false, "Bootstrap authority must not be implemented in the regular workflow");
  assert(policy.bootstrap?.procedure === "release/TOOLS-BOOTSTRAP.md", "Bootstrap procedure is not fixed");

  const unavailable = releasePolicyState(policy, { packageExists: false });
  assert(unavailable.blockers.includes("bootstrap_required"), "Absent npm package does not fail closed");
  if (!unavailable.ownerConfigured) {
    assert(unavailable.blockers.includes("expected_npm_owner_unconfigured"), "Missing npm owner does not fail closed");
  }
  if (!unavailable.trustedPublisherConfigured) {
    assert(
      unavailable.blockers.includes("trusted_publisher_external_gate_unconfirmed"),
      "Missing trusted publisher does not fail closed"
    );
  }
  return unavailable;
}

function requirePatterns(source, label, patterns) {
  for (const [description, pattern] of patterns) {
    assert(pattern.test(source), `${label} is missing ${description}`);
  }
}

function verifyPolicyEnforcement(validationSource, publishJobSource) {
  requirePatterns(validationSource, "release input validator", [
    ["publish-next-only policy branch", /if \(mode === "publish-next"\)/u],
    ["existing-package bootstrap gate", /assert\(\s*registry\.packageExists,/u],
    ["reviewed npm owner gate", /assert\(ownerConfigured,/u],
    ["trusted publisher gate", /assert\(\s*trustedPublisherConfigured,/u],
    ["bootstrap blocker evidence", /releaseBlockers\.push\("bootstrap_required"\)/u],
    ["owner blocker evidence", /releaseBlockers\.push\("expected_npm_owner_unconfigured"\)/u],
    ["trusted publisher blocker evidence", /releaseBlockers\.push\("trusted_publisher_external_gate_unconfirmed"\)/u]
  ]);
  requirePatterns(publishJobSource, "publish-next job", [
    ["existing-package approval guard", /approval\.registryPreflight\?\.packageExists !== true/u],
    ["immutable-version approval guard", /approval\.registryPreflight\?\.versionExists !== false/u],
    ["reviewed npm owner approval guard", /typeof policy\.expectedNpmOwner !== "string"/u],
    ["trusted publisher approval guard", /policy\.trustedPublisher\?\.configured !== true/u],
    ["retained release blocker guard", /approval\.releaseBlockers\?\.includes\(blocker\)/u]
  ]);
}

function verifyReleaseWorkflow(source, packageJson, validationSource) {
  const label = ".github/workflows/release-tools.yml";
  const { jobs } = parseWorkflowJobs(source, label);
  const validateJob = jobs.get("validate-build");
  const publishJob = jobs.get("publish-next");
  assert(validateJob !== undefined, `${label} is missing validate-build`);
  assert(publishJob !== undefined, `${label} is missing publish-next`);

  const validatePermissions = parseJobPermissions(validateJob, label);
  assert(!validatePermissions.has("id-token"), "validate-build must not receive id-token permission");
  assert(!/^\s*id-token\s*:/mu.test(validateJob.source), "validate-build contains an id-token permission outside the parsed block");

  const publishPermissions = parseJobPermissions(publishJob, label);
  assert(publishPermissions.get("id-token") === "write", "publish-next must receive id-token: write");
  assert(publishPermissions.get("contents") === "read", "publish-next must keep contents: read");
  assert(publishPermissions.size === 2, "publish-next has permissions beyond contents: read and id-token: write");

  const publishUses = actionUses(publishJob.source, `${label} publish-next`);
  assert(publishUses.length === 2, "publish-next must use only setup-node and download-artifact");
  assert(publishUses.some(({ reference }) => reference.startsWith("actions/setup-node@")), "publish-next is missing setup-node");
  assert(publishUses.some(({ reference }) => reference.startsWith("actions/download-artifact@")), "publish-next is missing download-artifact");
  assert(!publishUses.some(({ reference }) => reference.startsWith("actions/checkout@")), "publish-next must not check out repository source");
  assert(!/\bnpm\s+(?:ci|install|install-ci-test|run)\b/iu.test(publishJob.source), "publish-next must not install dependencies or invoke npm scripts");
  const publishCount = [...publishJob.source.matchAll(/\bnpm\s+publish\b/giu)].length;
  assert(publishCount === 1, `publish-next must contain exactly one npm publish command; found ${publishCount}`);
  requirePatterns(publishJob.source, "publish-next job", [
    ["exact downloaded tgz publish input", /npm publish "release-bundle\/pi-leetcode-tools-\$\{RELEASE_VERSION\}\.tgz"/u],
    ["next dist-tag", /--tag next/u],
    ["npm provenance", /--provenance/u],
    ["public access", /--access public/u],
    ["script suppression", /--ignore-scripts/u]
  ]);

  const packClosure = verifyNoRecordScriptGraph(packageJson, "pack:tools:no-record");
  const releaseClosure = verifyNoRecordScriptGraph(packageJson, "verify:tools:release:no-record");
  assert(packClosure.has("pack:tools:no-record"), "pack:tools:no-record graph was not checked");
  assert(releaseClosure.has("pack:tools:no-record"), "verify:tools:release:no-record must use pack:tools:no-record");
  assert(/\bnpm\s+pack\b/u.test(packageJson.scripts["pack:tools:no-record"]), "pack:tools:no-record no longer packs the workspace");
  assert(/npm\s+run\s+verify:tools:release:no-record\b/u.test(validateJob.source), "validate-build must use the no-record release path");
  assert(/npm\s+run\s+verify:tools:release-workflow\b/u.test(validateJob.source), "validate-build must run its static release-workflow gate");
  for (const target of npmRunTargets(validateJob.source)) {
    if (Object.hasOwn(packageJson.scripts, target)) verifyNoRecordScriptGraph(packageJson, target);
  }

  verifyPolicyEnforcement(validationSource, publishJob.source);
  return { jobs: jobs.size, publishCount };
}

function extractReferenceObjects(source) {
  const declaration = /const references = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(source);
  assert(declaration !== null, "Upstream provisioner has no statically pinned references array");
  const objects = [];
  let start = -1;
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = 0; index < declaration[1].length; index += 1) {
    const character = declaration[1][index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      assert(depth >= 0, "Upstream references array has unbalanced braces");
      if (depth === 0) objects.push(declaration[1].slice(start, index + 1));
    }
  }
  assert(depth === 0 && quote === undefined, "Upstream references array is not statically parseable");
  assert(objects.length > 0, "Upstream references array is empty");
  return objects;
}

function stringField(objectSource, field) {
  const match = new RegExp(`(?:^|\\n)\\s*${field}:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*,?`, "u").exec(objectSource);
  assert(match !== null, `Pinned upstream reference has no literal ${field}`);
  return JSON.parse(match[1]);
}

function numberField(objectSource, field) {
  const match = new RegExp(`(?:^|\\n)\\s*${field}:\\s*([0-9][0-9_]*)\\s*,?`, "u").exec(objectSource);
  assert(match !== null, `Pinned upstream reference has no integer ${field}`);
  return Number(match[1].replaceAll("_", ""));
}

function parseUpstreamPins(source) {
  return extractReferenceObjects(source).map((objectSource) => ({
    spec: stringField(objectSource, "spec"),
    name: stringField(objectSource, "name"),
    version: stringField(objectSource, "version"),
    file: stringField(objectSource, "file"),
    bytes: numberField(objectSource, "bytes"),
    sha256: stringField(objectSource, "sha256"),
    integrity: stringField(objectSource, "integrity")
  }));
}

function verifyUpstreamPins(source) {
  const pins = parseUpstreamPins(source);
  assert(pins.length === expectedUpstreamPins.length, "Pinned upstream reference inventory changed without updating the release gate");
  for (const [index, expected] of expectedUpstreamPins.entries()) {
    const actual = pins[index];
    assert(JSON.stringify(actual) === JSON.stringify(expected), `Pinned upstream reference changed: ${expected.spec}`);
    assert(actual.spec === `${actual.name}@${actual.version}`, `Upstream spec is not an exact version: ${actual.spec}`);
    assert(Number.isSafeInteger(actual.bytes) && actual.bytes > 0, `Upstream byte length is invalid: ${actual.spec}`);
    assert(/^[0-9a-f]{64}$/u.test(actual.sha256), `Upstream SHA-256 is invalid: ${actual.spec}`);
    assert(/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(actual.integrity), `Upstream integrity is invalid: ${actual.spec}`);
  }
  requirePatterns(source, "upstream provisioner", [
    ["fixed public npm registry", /const registry = "https:\/\/registry\.npmjs\.org";/u],
    ["archive byte verification", /assert\(bytes\.length === reference\.bytes,/u],
    ["archive SHA-256 verification", /assert\(actualSha256 === reference\.sha256,/u],
    ["archive integrity verification", /assert\(actualIntegrity === reference\.integrity,/u],
    ["ignore-scripts npm pack", /"--ignore-scripts"/u],
    ["fixed registry npm pack", /`--registry=\$\{registry\}`/u]
  ]);
  const renameIndex = source.indexOf("await rename(");
  assert(renameIndex > source.indexOf("assert(bytes.length === reference.bytes"), "Upstream bytes are not checked before installation");
  assert(renameIndex > source.indexOf("assert(actualSha256 === reference.sha256"), "Upstream SHA-256 is not checked before installation");
  assert(renameIndex > source.indexOf("assert(actualIntegrity === reference.integrity"), "Upstream integrity is not checked before installation");
  return pins.length;
}

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  assert(index >= 0, `Self-test fixture cannot find ${label}`);
  assert(source.indexOf(search, index + search.length) < 0, `Self-test fixture ${label} is not unique`);
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function mutateJob(source, jobId, mutation) {
  const parsed = parseWorkflowJobs(source, "self-test workflow");
  const job = parsed.jobs.get(jobId);
  assert(job !== undefined, `Self-test fixture has no ${jobId} job`);
  const replacement = mutation(job.source);
  const lines = [...parsed.lines];
  lines.splice(job.startLine, job.endLine - job.startLine, ...replacement.split("\n"));
  return lines.join("\n");
}

function expectFailure(name, operation, expectedMessage) {
  try {
    operation();
  } catch (error) {
    assert(error instanceof Error, `${name} failed with a non-Error value`);
    assert(error.message.includes(expectedMessage), `${name} failed for an unexpected reason: ${error.message}`);
    return;
  }
  throw new Error(`Negative self-test unexpectedly passed: ${name}`);
}

function runNegativeSelfTests({ releaseWorkflow, packageJson, policy, validationSource, provisionSource }) {
  const tests = [];
  const negative = (name, operation, expectedMessage) => {
    expectFailure(name, operation, expectedMessage);
    tests.push(name);
  };

  negative(
    "publish OIDC removed",
    () => verifyReleaseWorkflow(
      mutateJob(releaseWorkflow, "publish-next", (job) => replaceOnce(job, "      id-token: write", "      id-token: read", "publish id-token")),
      packageJson,
      validationSource
    ),
    "id-token: write"
  );
  negative(
    "checkout added to publish",
    () => verifyReleaseWorkflow(
      mutateJob(releaseWorkflow, "publish-next", (job) => replaceOnce(
        job,
        "    steps:\n",
        "    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n",
        "publish steps"
      )),
      packageJson,
      validationSource
    ),
    "setup-node and download-artifact"
  );
  negative(
    "npm run added to publish",
    () => verifyReleaseWorkflow(
      mutateJob(releaseWorkflow, "publish-next", (job) => replaceOnce(job, "          set -euo pipefail", "          set -euo pipefail\n          npm run unexpected", "publish shell")),
      packageJson,
      validationSource
    ),
    "must not install dependencies"
  );
  negative(
    "second publish added",
    () => verifyReleaseWorkflow(
      mutateJob(releaseWorkflow, "publish-next", (job) => `${job}\n          npm publish duplicate.tgz`),
      packageJson,
      validationSource
    ),
    "exactly one npm publish"
  );
  negative(
    "OIDC added to validate-build",
    () => verifyReleaseWorkflow(
      mutateJob(releaseWorkflow, "validate-build", (job) => replaceOnce(job, "      contents: read", "      contents: read\n      id-token: write", "validate permissions")),
      packageJson,
      validationSource
    ),
    "must not receive id-token"
  );
  negative(
    "action tag is mutable",
    () => verifyActionPins(releaseWorkflow.replace(/@[0-9a-f]{40}/u, "@v4"), "mutable-action fixture"),
    "not pinned to a full lowercase commit SHA"
  );

  const recordPackage = structuredClone(packageJson);
  recordPackage.scripts["pack:tools:no-record"] += " && npm run record:tools";
  negative(
    "no-record pack records candidate",
    () => verifyNoRecordScriptGraph(recordPackage, "pack:tools:no-record"),
    "invokes record:tools"
  );

  const readyPolicy = structuredClone(policy);
  readyPolicy.expectedNpmOwner = "reviewed-owner";
  readyPolicy.trustedPublisher = {
    ...readyPolicy.trustedPublisher,
    configured: true,
    workflow: ".github/workflows/release-tools.yml",
    environment: "npm-tools-next",
    evidenceReference: "reviewed-external-evidence"
  };
  assert(releasePolicyState(readyPolicy, { packageExists: true }).blockers.length === 0, "Configured policy fixture is not publish-ready");
  const ownerMissing = structuredClone(readyPolicy);
  ownerMissing.expectedNpmOwner = null;
  assert(releasePolicyState(ownerMissing, { packageExists: true }).blockers.includes("expected_npm_owner_unconfigured"), "Missing-owner fixture did not fail closed");
  const trustedMissing = structuredClone(readyPolicy);
  trustedMissing.trustedPublisher.configured = false;
  assert(releasePolicyState(trustedMissing, { packageExists: true }).blockers.includes("trusted_publisher_external_gate_unconfirmed"), "Missing-trusted-publisher fixture did not fail closed");
  assert(releasePolicyState(readyPolicy, { packageExists: false }).blockers.includes("bootstrap_required"), "Missing-bootstrap fixture did not fail closed");
  tests.push("owner/trusted publisher/bootstrap fail closed");

  negative(
    "upstream SHA changed",
    () => verifyUpstreamPins(replaceOnce(provisionSource, expectedUpstreamPins[0].sha256, "0".repeat(64), "first upstream SHA")),
    "Pinned upstream reference changed"
  );
  negative(
    "upstream integrity check removed",
    () => verifyUpstreamPins(replaceOnce(provisionSource, "assert(actualIntegrity === reference.integrity,", "assert(true,", "integrity assertion")),
    "archive integrity verification"
  );
  return tests.length;
}

const [releaseWorkflow, ciWorkflow, packageText, policyText, validationSource, provisionSource, workflowEntries] = await Promise.all([
  readFile(releaseWorkflowPath, "utf8"),
  readFile(ciWorkflowPath, "utf8"),
  readFile(packagePath, "utf8"),
  readFile(policyPath, "utf8"),
  readFile(validationScriptPath, "utf8"),
  readFile(provisionScriptPath, "utf8"),
  readdir(workflowsDirectory, { withFileTypes: true })
]);
const packageJson = JSON.parse(packageText);
const policy = JSON.parse(policyText);
assert(
  packageJson.scripts?.["verify:tools:release-workflow"] === "node ./release/scripts/verify-tools-release-workflow.mjs",
  "Root package.json must expose the exact verify:tools:release-workflow command"
);

const workflowFiles = workflowEntries
  .filter((entry) => entry.isFile() && [".yml", ".yaml"].includes(extname(entry.name)))
  .map((entry) => entry.name)
  .sort();
let actionCount = 0;
for (const workflowFile of workflowFiles) {
  const source = workflowFile === "release-tools.yml"
    ? releaseWorkflow
    : workflowFile === "ci.yml"
      ? ciWorkflow
      : await readFile(join(workflowsDirectory, workflowFile), "utf8");
  actionCount += verifyActionPins(source, `.github/workflows/${workflowFile}`);
}

const workflowResult = verifyReleaseWorkflow(releaseWorkflow, packageJson, validationSource);
const policyResult = verifyReleasePolicy(policy);
const upstreamPinCount = verifyUpstreamPins(provisionSource);
const ciGateCommands = normalizedLines(ciWorkflow, ".github/workflows/ci.yml")
  .filter((line) => /^\s+run:\s*npm\s+run\s+verify:tools:release-workflow\s*$/u.test(line));
assert(ciGateCommands.length === 1, "CI must invoke verify:tools:release-workflow exactly once as a run step");
const negativeChecks = runNegativeSelfTests({
  releaseWorkflow,
  packageJson,
  policy,
  validationSource,
  provisionSource
});

console.log(JSON.stringify({
  gate: "tools-release-workflow-static",
  workflows: workflowFiles.length,
  jobs: workflowResult.jobs,
  pinnedActions: actionCount,
  publishCommands: workflowResult.publishCount,
  upstreamPins: upstreamPinCount,
  currentPolicyBlockersWhenPackageAbsent: policyResult.blockers,
  negativeChecks,
  status: "passed"
}, null, 2));
