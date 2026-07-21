#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseWorkflowPath = join(repositoryRoot, ".github", "workflows", "release-tools.yml");
const bootstrapWorkflowPath = join(repositoryRoot, ".github", "workflows", "bootstrap-tools.yml");
const ciWorkflowPath = join(repositoryRoot, ".github", "workflows", "ci.yml");
const workflowsDirectory = join(repositoryRoot, ".github", "workflows");
const packagePath = join(repositoryRoot, "package.json");
const policyPath = join(repositoryRoot, "release", "tools-release-policy.json");
const validationScriptPath = join(repositoryRoot, "release", "scripts", "validate-tools-release-inputs.mjs");
const provisionScriptPath = join(repositoryRoot, "release", "scripts", "provision-tools-upstream.mjs");
const registryReleaseVerifierPath = join(repositoryRoot, "release", "scripts", "verify-tools-registry-release.mjs");
const prepareGitHubReleaseScriptPath = join(repositoryRoot, "release", "scripts", "prepare-tools-github-release.mjs");
const publishGitHubReleaseScriptPath = join(repositoryRoot, "release", "scripts", "publish-tools-github-release.mjs");

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
  assert(policy.schemaVersion === 2, "Tools release policy schemaVersion must be 2");
  assert(policy.packageName === "pi-leetcode-tools", "Tools release policy package is invalid");
  assert(policy.registry === "https://registry.npmjs.org", "Tools release policy registry is not fixed to public npm");
  assert(
    policy.publishDistTag === "latest" && policy.preserveOtherDistTags === true,
    "Tools regular release policy must publish latest and preserve every other dist-tag"
  );
  assert(
    policy.bootstrap?.publishDistTag === "next" && policy.bootstrap?.protectedDistTag === "latest",
    "Tools bootstrap dist-tag policy is invalid"
  );
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
    ["publish-latest-only policy branch", /if \(mode === "publish-latest"\)/u],
    ["existing-package bootstrap gate", /assert\(\s*registry\.packageExists,/u],
    ["stable monotonic latest gate", /assertRegularPublishVersion\(\{/u],
    ["reviewed npm owner gate", /assert\(ownerConfigured,/u],
    ["trusted publisher gate", /assert\(\s*trustedPublisherConfigured,/u],
    ["bootstrap blocker evidence", /releaseBlockers\.push\("bootstrap_required"\)/u],
    ["owner blocker evidence", /releaseBlockers\.push\("expected_npm_owner_unconfigured"\)/u],
    ["trusted publisher blocker evidence", /releaseBlockers\.push\("trusted_publisher_external_gate_unconfirmed"\)/u]
  ]);
  requirePatterns(publishJobSource, "publish-latest job", [
    ["existing-package approval guard", /approval\.registryPreflight\?\.packageExists !== true/u],
    ["immutable-version approval guard", /approval\.registryPreflight\?\.versionExists !== false/u],
    ["existing latest stable-version guard", /stableVersion\(approval\.registryPreflight\?\.distTags\?\.latest/u],
    ["monotonic latest-version guard", /compareVersions\(requestedVersion, latestVersion\) <= 0/u],
    ["stable-only policy guard", /policy\.publishDistTag !== "latest" \|\| policy\.preserveOtherDistTags !== true/u],
    ["approval dist-tag policy guard", /approval\.policy\?\.publishDistTag !== "latest" \|\| approval\.policy\?\.preserveOtherDistTags !== true/u],
    ["snapshot digest guard", /snapshot\.stateDigest !== registryStateDigest/u],
    ["approval-to-snapshot binding", /Approval registry preflight is not bound to the dist-tag snapshot/u],
    ["live npm packument pre-publish recheck", /const liveResponse = await fetch\("https:\/\/registry\.npmjs\.org\/pi-leetcode-tools"/u],
    ["live immutable-version recheck", /Object\.hasOwn\(livePackument\.versions \?\? \{\}, version\)/u],
    ["live npm owner recheck", /liveMaintainers\.includes\(policy\.expectedNpmOwner\)/u],
    ["live full dist-tag recheck", /JSON\.stringify\(liveTags\) !== JSON\.stringify\(snapshotTags\)/u],
    ["live latest monotonic recheck", /compareVersions\(requestedVersion, liveLatestVersion\) <= 0/u],
    ["reviewed npm owner approval guard", /typeof policy\.expectedNpmOwner !== "string"/u],
    ["trusted publisher approval guard", /policy\.trustedPublisher\?\.configured !== true/u],
    ["retained release blocker guard", /approval\.releaseBlockers\?\.includes\(blocker\)/u]
  ]);
}

function requireExactJobBoundary(job, { mode, needs, environment }, label) {
  assert(
    new RegExp(`^    if: \\$\\{\\{ inputs\\.mode == '${mode}' \\}\\}$`, "mu").test(job.source),
    `${label} must use the exact ${mode} mode guard`
  );
  assert(new RegExp(`^    needs: ${needs}$`, "mu").test(job.source), `${label} must need only ${needs}`);
  if (environment === undefined) {
    assert(!/^    environment:/mu.test(job.source), `${label} must not use a protected environment`);
  } else {
    assert(
      new RegExp(`^    environment: ${environment}$`, "mu").test(job.source),
      `${label} must use environment ${environment}`
    );
  }
}

function verifyGitHubReleaseScripts(prepareSource, publisherSource) {
  requirePatterns(prepareSource, "GitHub Release bundle preparer", [
    ["exact two-tgz gate", /duplicateTarballPaths\.length === 2/u],
    ["CandidateRecord digest gate", /formalRegistry\.subject\.recordDigest === expectedRecordDigest/u],
    ["provenance repository gate", /formalRegistry\.provenance\?\.repository === `https:\/\/github\.com\/\$\{repository\}`/u],
    ["provenance workflow gate", /formalRegistry\.provenance\.workflowPath/u],
    ["provenance ref gate", /formalRegistry\.provenance\.ref === ref/u],
    ["provenance commit gate", /formalRegistry\.provenance\.gitCommit === commit/u],
    ["default latest install gate", /formalRegistry\.cleanInstall\?\.requested === `\$\{packageName\}@latest`/u],
    ["default latest resolved-version gate", /formalRegistry\.cleanInstall\.resolvedVersion === version/u],
    ["supply-chain source revision gate", /releaseEvidence\.source\?\.revision === commit/u],
    ["latest transition gate", /transition\.latestAfter === version/u],
    ["non-target dist-tag gate", /transition\.nonTargetTagsUnchanged === true/u],
    ["before dist-tag digest recomputation", /transition\.beforeDigest === distTagStateDigest/u],
    ["after dist-tag digest recomputation", /transition\.afterDigest === distTagStateDigest/u],
    ["symbolic-link traversal rejection", /assert\(!entry\.isSymbolicLink\(\), `Artifact traversal encountered symbolic link:/u],
    ["versioned public activation asset", /`\$\{packageName\}-\$\{version\}-pi-activation\.json`/u],
    ["versioned public release-evidence asset", /`\$\{packageName\}-\$\{version\}-release-evidence\.json`/u],
    ["versioned public SBOM asset", /`\$\{packageName\}-\$\{version\}-sbom\.cdx\.json`/u],
    ["release title without extra v", /title: `\$\{packageName\} \$\{version\}`/u],
    ["seven public assets", /assets: assets\.map\(\(\{ identity \}\) => identity\)/u],
    ["SHA256SUMS generation", /checksums: "SHA256SUMS\.txt"/u]
  ]);
  requirePatterns(publisherSource, "GitHub Release publisher logic", [
    ["pure release planner", /export function planGitHubRelease/u],
    ["create-draft plan", /action: "create-draft"/u],
    ["resume-draft plan", /action: "resume-draft"/u],
    ["published no-op plan", /action: "no-op"/u],
    ["repository latest predecessor gate", /assertExpectedPredecessor\(bundle\.manifest, repositoryLatestRelease\)/u],
    ["Git tag peeling logic", /export async function peelGitTagReference/u],
    ["manifest commit tag binding", /commit === bundle\.manifest\.source\.commit/u],
    ["pre-publication predecessor refresh", /const prePublishRepositoryLatest = await getLatestRelease/u],
    ["draft-first creation", /draft: true/u],
    ["latest publication", /make_latest: "true"/u],
    ["asset SHA-256 comparison", /asset\.sha256 === wanted\.sha256/u]
  ]);
  assert(!/--clobber/iu.test(publisherSource), "GitHub Release publisher must not contain a clobber path");
  assert(!/method:\s*["']DELETE["']/u.test(publisherSource), "GitHub Release publisher must not contain a destructive API method");
  return 2;
}

function verifyFormalRegistryVerifier(source) {
  requirePatterns(source, "formal registry verifier", [
    ["default latest install", /`\$\{packageName\}@latest`/u],
    ["resolved latest version evidence", /resolvedVersion: lockEntry\.version/u],
    ["registry README filename gate", /packument\.readmeFilename === "README\.md"/u],
    ["registry English README gate", /packument\.readme\.includes\("Unofficial native Pi tool calls/u],
    ["credential environment removal", /upperName === "NPM_TOKEN"[\s\S]*upperName === "NODE_AUTH_TOKEN"/u],
    ["credential-bearing npm config removal", /upperName\.startsWith\("NPM_CONFIG_"\)[\s\S]*AUTH\|TOKEN\|PASSWORD\|USERNAME/u],
    ["isolated home", /HOME: temporaryDirectory/u],
    ["isolated global npm config", /NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig/u],
    ["empty global npm config", /writeFile\(npmGlobalConfig, "", "utf8"\)/u]
  ]);
  return 1;
}

function verifyExactLocalTgzPublish(jobSource, label, expectedInput) {
  const publishInputs = [...jobSource.matchAll(/\bnpm\s+publish\s+"([^"\r\n]+\.tgz)"/gu)]
    .map((match) => match[1]);
  assert(
    publishInputs.length === 1,
    `${label} must contain one quoted local tgz publish input; found ${publishInputs.length}`
  );
  const [publishInput] = publishInputs;
  assert(
    publishInput.startsWith("./"),
    `${label} must use an explicit ./ local tgz path instead of an npm Git shorthand`
  );
  assert(
    publishInput === expectedInput,
    `${label} must publish ${expectedInput}; found ${publishInput}`
  );
}

function verifyReleaseWorkflow(source, packageJson, validationSource, prepareSource, publisherSource) {
  const label = ".github/workflows/release-tools.yml";
  const { jobs } = parseWorkflowJobs(source, label);
  const validateJob = jobs.get("validate-build");
  const publishJob = jobs.get("publish-latest");
  const verifyRegistryJob = jobs.get("verify-registry");
  const publishGitHubJob = jobs.get("publish-github-release");
  assert(validateJob !== undefined, `${label} is missing validate-build`);
  assert(publishJob !== undefined, `${label} is missing publish-latest`);
  assert(verifyRegistryJob !== undefined, `${label} is missing verify-registry`);
  assert(publishGitHubJob !== undefined, `${label} is missing publish-github-release`);
  assert(jobs.size === 4, `${label} must contain exactly the four reviewed release jobs`);

  requirePatterns(source, label, [
    ["latest workflow name", /^name: release-tools-latest$/mu],
    ["publish-latest mode option", /^          - publish-latest$/mu],
    ["latest confirmation text", /publish pi-leetcode-tools@VERSION to latest/u],
    ["latest concurrency group", /^  group: release-pi-leetcode-tools-latest$/mu]
  ]);
  assert(!/publish-next/u.test(source), `${label} must not retain the regular publish-next mode`);
  assert(!/--tag next/u.test(source), `${label} regular publication must not target next`);

  const validatePermissions = parseJobPermissions(validateJob, label);
  assert(validatePermissions.get("contents") === "read" && validatePermissions.size === 1, "validate-build must keep only contents: read");
  assert(!/^\s*id-token\s*:/mu.test(validateJob.source), "validate-build contains an id-token permission outside the parsed block");

  const publishPermissions = parseJobPermissions(publishJob, label);
  assert(publishPermissions.get("id-token") === "write", "publish-latest must receive id-token: write");
  assert(publishPermissions.get("contents") === "read", "publish-latest must keep contents: read");
  assert(publishPermissions.size === 2, "publish-latest has permissions beyond contents: read and id-token: write");
  requireExactJobBoundary(
    publishJob,
    { mode: "publish-latest", needs: "validate-build", environment: "npm-tools-next" },
    "publish-latest"
  );

  const publishUses = actionUses(publishJob.source, `${label} publish-latest`);
  assert(publishUses.length === 2, "publish-latest must use only setup-node and download-artifact");
  assert(publishUses.some(({ reference }) => reference.startsWith("actions/setup-node@")), "publish-latest is missing setup-node");
  assert(publishUses.some(({ reference }) => reference.startsWith("actions/download-artifact@")), "publish-latest is missing download-artifact");
  assert(!publishUses.some(({ reference }) => reference.startsWith("actions/checkout@")), "publish-latest must not check out repository source");
  assert(!/\bnpm\s+(?:ci|install|install-ci-test|run)\b/iu.test(publishJob.source), "publish-latest must not install dependencies or invoke npm scripts");
  const publishCount = [...publishJob.source.matchAll(/\bnpm\s+publish\b/giu)].length;
  assert(publishCount === 1, `publish-latest must contain exactly one npm publish command; found ${publishCount}`);
  verifyExactLocalTgzPublish(
    publishJob.source,
    "publish-latest job",
    "./release-bundle/pi-leetcode-tools-${RELEASE_VERSION}.tgz"
  );
  requirePatterns(publishJob.source, "publish-latest job", [
    ["downloaded bundle directory", /path:\s*release-bundle/u],
    ["latest dist-tag", /--tag latest/u],
    ["npm provenance", /--provenance/u],
    ["public access", /--access public/u],
    ["script suppression", /--ignore-scripts/u]
  ]);
  requirePatterns(validateJob.source, "validate-build job", [
    [
      "explicit local dry-run tgz input",
      /npm publish "\.\/\.artifacts\/release-bundle\/tools\/pi-leetcode-tools-\$\{RELEASE_VERSION\}\.tgz"/u
    ],
    ["release bundle upload path", /path:\s*\.artifacts\/release-bundle\/tools\/\*\*/u],
    ["dry-run publish guard", /--dry-run/u],
    ["dry-run latest dist-tag", /--tag latest/u]
  ]);
  assert([...validateJob.source.matchAll(/--tag latest/gu)].length === 1, "validate-build must contain exactly one dry-run --tag latest");
  assert([...publishJob.source.matchAll(/--tag latest/gu)].length === 1, "publish-latest must contain exactly one formal --tag latest");

  const verifyPermissions = parseJobPermissions(verifyRegistryJob, label);
  assert(verifyPermissions.get("contents") === "read" && verifyPermissions.size === 1, "verify-registry must keep only contents: read");
  assert(!/^\s*id-token\s*:/mu.test(verifyRegistryJob.source), "verify-registry must not receive id-token permission");
  requireExactJobBoundary(verifyRegistryJob, { mode: "publish-latest", needs: "publish-latest" }, "verify-registry");
  requirePatterns(verifyRegistryJob.source, "verify-registry job", [
    ["formal registry verifier", /npm run verify:tools:registry-release --/u],
    ["latest transition verifier", /npm run assert:tools:registry-tags --/u],
    ["GitHub Release bundle preparer", /node \.\/release\/scripts\/prepare-tools-github-release\.mjs/u],
    ["seven-asset bundle output", /--output \.artifacts\/github-release-bundle\/tools/u],
    ["data-only bundle artifact", /path:\s*\.artifacts\/github-release-bundle\/tools\/\*\*/u]
  ]);
  const registryIndex = verifyRegistryJob.source.indexOf("npm run verify:tools:registry-release --");
  const transitionIndex = verifyRegistryJob.source.indexOf("npm run assert:tools:registry-tags --");
  const prepareIndex = verifyRegistryJob.source.indexOf("node ./release/scripts/prepare-tools-github-release.mjs");
  const bundleUploadIndex = verifyRegistryJob.source.indexOf("path: .artifacts/github-release-bundle/tools/**");
  assert(registryIndex >= 0 && registryIndex < transitionIndex && transitionIndex < prepareIndex && prepareIndex < bundleUploadIndex, "verify-registry release-evidence ordering is invalid");
  assert(!verifyRegistryJob.source.includes("publish-tools-github-release.mjs"), "verify-registry artifact must contain data only, not executable publisher code");

  const githubPermissions = parseJobPermissions(publishGitHubJob, label);
  assert(githubPermissions.get("contents") === "write" && githubPermissions.size === 1, "publish-github-release must keep only contents: write");
  requireExactJobBoundary(publishGitHubJob, { mode: "publish-latest", needs: "verify-registry" }, "publish-github-release");
  const githubUses = actionUses(publishGitHubJob.source, `${label} publish-github-release`);
  assert(githubUses.length === 2, "publish-github-release must use only setup-node and download-artifact");
  assert(githubUses.some(({ reference }) => reference.startsWith("actions/setup-node@")), "publish-github-release is missing setup-node");
  assert(githubUses.some(({ reference }) => reference.startsWith("actions/download-artifact@")), "publish-github-release is missing download-artifact");
  assert(!githubUses.some(({ reference }) => reference.startsWith("actions/checkout@")), "publish-github-release must not check out repository source");
  assert(!/^\s*id-token\s*:/mu.test(publishGitHubJob.source), "publish-github-release must not receive id-token permission");
  assert(
    !/\$\{\{[^\r\n}]*\bsecrets\b[^\r\n}]*\}\}/u.test(publishGitHubJob.source),
    "publish-github-release must not use any secrets context"
  );
  assert(!/^\s+(?:NPM_TOKEN|NODE_AUTH_TOKEN):/mu.test(publishGitHubJob.source), "publish-github-release must not inject npm credentials");
  assert(!/\bnpm\s+(?:ci|install|install-ci-test|run|publish|exec|pack|view|dist-tag)\b/iu.test(publishGitHubJob.source), "publish-github-release must not invoke npm");
  assert(!/node\s+[^\n]*publish-tools-github-release\.mjs/iu.test(publishGitHubJob.source), "publish-github-release must not execute publisher code downloaded from an artifact");
  assert(!/--clobber/iu.test(publishGitHubJob.source), "publish-github-release must not contain a clobber path");
  assert(!/method:\s*["']DELETE["']/u.test(publishGitHubJob.source), "publish-github-release must not contain a destructive API method");
  requirePatterns(publishGitHubJob.source, "publish-github-release job", [
    ["data-only bundle download", /name:\s*tools-github-release-bundle-\$\{\{ github\.run_id \}\}/u],
    ["exact github.token", /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/u],
    ["inline audited module", /node --input-type=module <<'NODE'/u],
    ["draft-first creation", /draft: true/u],
    ["matching draft continuation", /action: "resume-draft"/u],
    ["published no-op", /action: "no-op"/u],
    ["repository latest predecessor read", /const initialRepositoryLatest = await latestRelease\(\)/u],
    ["repository latest predecessor gate", /assertExpectedPredecessor\(initialRepositoryLatest\)/u],
    ["Git tag ref read", /\/git\/ref\/tags\/\$\{encodeURIComponent\(expectedTag\)\}/u],
    ["annotated Git tag peeling", /\/git\/tags\/\$\{object\.sha\}/u],
    ["peeled tag commit binding", /object\.sha === manifest\.source\.commit/u],
    ["pre-publication predecessor refresh", /const prePublishRepositoryLatest = await latestRelease\(\)/u],
    ["asset size and digest verification", /bytes\.length === expected\.size && sha256\(bytes\) === expected\.sha256/u],
    ["latest publication", /make_latest: "true"/u]
  ]);
  assert(
    [...publishGitHubJob.source.matchAll(/await verifyReleaseTagCommit\(\);/gu)].length === 2,
    "publish-github-release must peel and verify the tag both before draft work and immediately before publication"
  );
  const firstTagVerification = publishGitHubJob.source.indexOf("await verifyReleaseTagCommit();");
  const draftCreation = publishGitHubJob.source.indexOf('method: "POST"');
  const secondTagVerification = publishGitHubJob.source.indexOf("await verifyReleaseTagCommit();", firstTagVerification + 1);
  const finalLatestRefresh = publishGitHubJob.source.indexOf("const prePublishRepositoryLatest = await latestRelease();");
  const draftPublication = publishGitHubJob.source.indexOf('method: "PATCH"');
  assert(
    firstTagVerification >= 0 && firstTagVerification < draftCreation &&
      draftCreation < secondTagVerification && secondTagVerification < finalLatestRefresh &&
      finalLatestRefresh < draftPublication,
    "publish-github-release tag and predecessor checks do not bracket the mutable draft phase"
  );

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
  const releaseScriptChecks = verifyGitHubReleaseScripts(prepareSource, publisherSource);
  return { jobs: jobs.size, publishCount, releaseScriptChecks };
}

function verifyBootstrapWorkflow(source, packageJson) {
  const label = ".github/workflows/bootstrap-tools.yml";
  const { jobs } = parseWorkflowJobs(source, label);
  const validateJob = jobs.get("validate");
  const publishJob = jobs.get("publish");
  const verifyJob = jobs.get("verify");
  assert(validateJob !== undefined, `${label} is missing validate`);
  assert(publishJob !== undefined, `${label} is missing publish`);
  assert(verifyJob !== undefined, `${label} is missing verify`);

  const validatePermissions = parseJobPermissions(validateJob, label);
  assert(
    validatePermissions.get("contents") === "read" && validatePermissions.size === 1,
    "bootstrap validate must keep only contents: read"
  );
  assert(!validatePermissions.has("id-token"), "bootstrap validate must not receive id-token permission");

  const verifyPermissions = parseJobPermissions(verifyJob, label);
  assert(
    verifyPermissions.get("contents") === "read" && verifyPermissions.size === 1,
    "bootstrap verify must keep only contents: read"
  );
  assert(!verifyPermissions.has("id-token"), "bootstrap verify must not receive id-token permission");
  assert(!/^\s*environment:/mu.test(verifyJob.source), "bootstrap verify must not use a protected environment");
  assert(
    !/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*:/u.test(verifyJob.source),
    "bootstrap verify must not receive npm credentials"
  );
  assert(
    packageJson.scripts?.["verify:tools:bootstrap-registry"] ===
      "node ./release/scripts/verify-tools-bootstrap-registry.mjs",
    "Root package.json must expose the exact verify:tools:bootstrap-registry command"
  );
  const registryVerifyInvocations = [
    ...verifyJob.source.matchAll(/\bnpm\s+run\s+verify:tools:bootstrap-registry\s+--\s+verify\b/gu)
  ];
  assert(
    registryVerifyInvocations.length === 1,
    `bootstrap verify must invoke verify:tools:bootstrap-registry through npm exactly once; found ${registryVerifyInvocations.length}`
  );
  assert(
    !/\bnode\s+(?:\.\/)?release\/scripts\/verify-tools-bootstrap-registry\.mjs\s+verify\b/u.test(verifyJob.source),
    "bootstrap verify must not launch the registry verifier directly with node"
  );

  const publishPermissions = parseJobPermissions(publishJob, label);
  assert(
    publishPermissions.get("id-token") === "write" && publishPermissions.size === 1,
    "bootstrap publish must keep only id-token: write"
  );
  const publishUses = actionUses(publishJob.source, `${label} publish`);
  assert(publishUses.length === 2, "bootstrap publish must use only setup-node and download-artifact");
  assert(
    publishUses.some(({ reference }) => reference.startsWith("actions/setup-node@")),
    "bootstrap publish is missing setup-node"
  );
  assert(
    publishUses.some(({ reference }) => reference.startsWith("actions/download-artifact@")),
    "bootstrap publish is missing download-artifact"
  );
  assert(
    !publishUses.some(({ reference }) => reference.startsWith("actions/checkout@")),
    "bootstrap publish must not check out repository source"
  );
  assert(
    !/\bnpm\s+(?:ci|install|install-ci-test|run)\b/iu.test(publishJob.source),
    "bootstrap publish must not install dependencies or invoke npm scripts"
  );
  const publishCount = [...publishJob.source.matchAll(/\bnpm\s+publish\b/giu)].length;
  assert(
    publishCount === 1,
    `bootstrap publish must contain exactly one npm publish command; found ${publishCount}`
  );
  verifyExactLocalTgzPublish(
    publishJob.source,
    "bootstrap publish job",
    "./bootstrap-bundle/pi-leetcode-tools-${RELEASE_VERSION}.tgz"
  );
  requirePatterns(publishJob.source, "bootstrap publish job", [
    ["protected bootstrap environment", /^\s*environment:\s*npm-tools-bootstrap\s*$/mu],
    ["downloaded bundle directory", /path:\s*bootstrap-bundle/u],
    ["protected npm token", /NPM_TOKEN:\s*\$\{\{ secrets\.NPM_TOKEN \}\}/u],
    ["next dist-tag", /--tag next/u],
    ["npm provenance", /--provenance/u],
    ["public access", /--access public/u],
    ["script suppression", /--ignore-scripts/u]
  ]);
  requirePatterns(validateJob.source, "bootstrap validate job", [
    [
      "explicit local dry-run tgz input",
      /npm publish "\.\/\.artifacts\/bootstrap-bundle\/tools\/pi-leetcode-tools-\$\{RELEASE_VERSION\}\.tgz"/u
    ],
    ["bootstrap bundle upload path", /path:\s*\.artifacts\/bootstrap-bundle\/tools\/\*\*/u],
    ["dry-run publish guard", /--dry-run/u]
  ]);

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

function runNegativeSelfTests({
  releaseWorkflow,
  bootstrapWorkflow,
  packageJson,
  policy,
  validationSource,
  provisionSource,
  registryReleaseVerifierSource,
  prepareGitHubReleaseSource,
  publishGitHubReleaseSource
}) {
  const tests = [];
  const negative = (name, operation, expectedMessage) => {
    expectFailure(name, operation, expectedMessage);
    tests.push(name);
  };
  const verifyRelease = (
    workflow = releaseWorkflow,
    prepareSource = prepareGitHubReleaseSource,
    publisherSource = publishGitHubReleaseSource
  ) => verifyReleaseWorkflow(workflow, packageJson, validationSource, prepareSource, publisherSource);

  negative(
    "publish OIDC removed",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-latest", (job) => replaceOnce(job, "      id-token: write", "      id-token: read", "publish id-token"))),
    "id-token: write"
  );
  negative(
    "checkout added to publish",
    () => verifyRelease(
      mutateJob(releaseWorkflow, "publish-latest", (job) => replaceOnce(
        job,
        "    steps:\n",
        "    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n",
        "publish steps"
      ))
    ),
    "setup-node and download-artifact"
  );
  negative(
    "npm run added to publish",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-latest", (job) => replaceOnce(job, "          set -euo pipefail", "          set -euo pipefail\n          npm run unexpected", "publish shell"))),
    "must not install dependencies"
  );
  negative(
    "second publish added",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-latest", (job) => `${job}\n          npm publish duplicate.tgz`)),
    "exactly one npm publish"
  );
  negative(
    "release local tgz prefix removed",
    () => verifyRelease(
      replaceOnce(
        releaseWorkflow,
        'npm publish "./release-bundle/pi-leetcode-tools-${RELEASE_VERSION}.tgz"',
        'npm publish "release-bundle/pi-leetcode-tools-${RELEASE_VERSION}.tgz"',
        "release local tgz input"
      )
    ),
    "explicit ./ local tgz path"
  );
  negative(
    "bootstrap local tgz prefix removed",
    () => verifyBootstrapWorkflow(replaceOnce(
      bootstrapWorkflow,
      'npm publish "./bootstrap-bundle/pi-leetcode-tools-${RELEASE_VERSION}.tgz"',
      'npm publish "bootstrap-bundle/pi-leetcode-tools-${RELEASE_VERSION}.tgz"',
      "bootstrap local tgz input"
    ), packageJson),
    "explicit ./ local tgz path"
  );
  negative(
    "bootstrap verify bypasses npm script",
    () => verifyBootstrapWorkflow(
      mutateJob(bootstrapWorkflow, "verify", (job) => replaceOnce(
        job,
        "npm run verify:tools:bootstrap-registry -- verify",
        "node release/scripts/verify-tools-bootstrap-registry.mjs verify",
        "bootstrap verify invocation"
      )),
      packageJson
    ),
    "through npm exactly once"
  );
  negative(
    "OIDC added to bootstrap verify",
    () => verifyBootstrapWorkflow(
      mutateJob(bootstrapWorkflow, "verify", (job) => replaceOnce(
        job,
        "      contents: read",
        "      contents: read\n      id-token: write",
        "bootstrap verify permissions"
      )),
      packageJson
    ),
    "only contents: read"
  );
  negative(
    "OIDC added to validate-build",
    () => verifyRelease(mutateJob(releaseWorkflow, "validate-build", (job) => replaceOnce(job, "      contents: read", "      contents: read\n      id-token: write", "validate permissions"))),
    "only contents: read"
  );
  negative(
    "publish environment changed",
    () => verifyRelease(replaceOnce(releaseWorkflow, "    environment: npm-tools-next", "    environment: npm-tools-latest", "publish environment")),
    "environment npm-tools-next"
  );
  negative(
    "registry verification dependency bypassed",
    () => verifyRelease(replaceOnce(releaseWorkflow, "    needs: publish-latest", "    needs: validate-build", "verify-registry needs")),
    "need only publish-latest"
  );
  negative(
    "live npm pre-publish recheck removed",
    () => verifyRelease(replaceOnce(
      releaseWorkflow,
      "const liveResponse = await fetch(\"https://registry.npmjs.org/pi-leetcode-tools\"",
      "const liveResponse = await Promise.resolve(\"unchecked\")",
      "live npm recheck"
    )),
    "live npm packument pre-publish recheck"
  );
  negative(
    "formal latest install regains ambient npm credentials",
    () => verifyFormalRegistryVerifier(replaceOnce(
      registryReleaseVerifierSource,
      "    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,",
      "    NPM_CONFIG_GLOBALCONFIG: process.env.NPM_CONFIG_GLOBALCONFIG,",
      "isolated npm global config"
    )),
    "isolated global npm config"
  );
  negative(
    "GitHub Release permission expanded",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-github-release", (job) => replaceOnce(job, "      contents: write", "      contents: write\n      id-token: write", "GitHub permissions"))),
    "only contents: write"
  );
  negative(
    "GitHub Release secrets context added",
    () => verifyRelease(replaceOnce(
      releaseWorkflow,
      "          GITHUB_TOKEN: ${{ github.token }}",
      "          GITHUB_TOKEN: ${{ secrets['NPM_TOKEN'] }}",
      "GitHub token context"
    )),
    "must not use any secrets context"
  );
  negative(
    "GitHub Release dependency bypassed",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-github-release", (job) => replaceOnce(job, "    needs: verify-registry", "    needs: publish-latest", "GitHub needs"))),
    "need only verify-registry"
  );
  negative(
    "checkout added to GitHub Release",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-github-release", (job) => replaceOnce(
      job,
      "    steps:\n",
      "    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n",
      "GitHub steps"
    ))),
    "setup-node and download-artifact"
  );
  negative(
    "npm added to GitHub Release",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-github-release", (job) => replaceOnce(job, "          set -euo pipefail", "          set -euo pipefail\n          npm publish unexpected.tgz", "GitHub shell"))),
    "must not invoke npm"
  );
  negative(
    "artifact publisher execution added",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-github-release", (job) => replaceOnce(job, "          node --input-type=module <<'NODE'", "          node ./github-release-bundle/publish-tools-github-release.mjs\n          node --input-type=module <<'NODE'", "inline publisher"))),
    "must not execute publisher code downloaded from an artifact"
  );
  negative(
    "Git tag peel recheck removed",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-github-release", (job) => job.replace("          await verifyReleaseTagCommit();", "          // tag check removed"))),
    "both before draft work and immediately before publication"
  );
  negative(
    "repository latest predecessor gate removed",
    () => verifyRelease(replaceOnce(
      releaseWorkflow,
      "            assertExpectedPredecessor(initialRepositoryLatest);",
      "            // predecessor check removed",
      "initial predecessor check"
    )),
    "repository latest predecessor gate"
  );
  negative(
    "pre-publication predecessor refresh removed",
    () => verifyRelease(replaceOnce(
      releaseWorkflow,
      "          const prePublishRepositoryLatest = await latestRelease();",
      "          const prePublishRepositoryLatest = initialRepositoryLatest;",
      "pre-publication latest refresh"
    )),
    "pre-publication predecessor refresh"
  );
  negative(
    "clobber path added",
    () => verifyRelease(mutateJob(releaseWorkflow, "publish-github-release", (job) => `${job}\n          gh release upload --clobber bad`)),
    "must not contain a clobber path"
  );
  negative(
    "destructive publisher API added",
    () => verifyRelease(releaseWorkflow, prepareGitHubReleaseSource, `${publishGitHubReleaseSource}\nconst destructiveFixture = { method: "DELETE" };`),
    "must not contain a destructive API method"
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

const [
  releaseWorkflow,
  bootstrapWorkflow,
  ciWorkflow,
  packageText,
  policyText,
  validationSource,
  provisionSource,
  registryReleaseVerifierSource,
  prepareGitHubReleaseSource,
  publishGitHubReleaseSource,
  workflowEntries
] = await Promise.all([
  readFile(releaseWorkflowPath, "utf8"),
  readFile(bootstrapWorkflowPath, "utf8"),
  readFile(ciWorkflowPath, "utf8"),
  readFile(packagePath, "utf8"),
  readFile(policyPath, "utf8"),
  readFile(validationScriptPath, "utf8"),
  readFile(provisionScriptPath, "utf8"),
  readFile(registryReleaseVerifierPath, "utf8"),
  readFile(prepareGitHubReleaseScriptPath, "utf8"),
  readFile(publishGitHubReleaseScriptPath, "utf8"),
  readdir(workflowsDirectory, { withFileTypes: true })
]);
const packageJson = JSON.parse(packageText);
const policy = JSON.parse(policyText);
assert(
  packageJson.scripts?.["test:release-infra"] === "node --test ./release/tests/*.test.mjs",
  "Root package.json must expose the exact test:release-infra command"
);
assert(
  packageJson.scripts?.["verify:tools:release-workflow"] ===
    "node --test ./release/tests/*.test.mjs && node ./release/scripts/verify-tools-release-workflow.mjs",
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
    : workflowFile === "bootstrap-tools.yml"
      ? bootstrapWorkflow
    : workflowFile === "ci.yml"
      ? ciWorkflow
      : await readFile(join(workflowsDirectory, workflowFile), "utf8");
  actionCount += verifyActionPins(source, `.github/workflows/${workflowFile}`);
}

const workflowResult = verifyReleaseWorkflow(
  releaseWorkflow,
  packageJson,
  validationSource,
  prepareGitHubReleaseSource,
  publishGitHubReleaseSource
);
const bootstrapResult = verifyBootstrapWorkflow(bootstrapWorkflow, packageJson);
const policyResult = verifyReleasePolicy(policy);
const upstreamPinCount = verifyUpstreamPins(provisionSource);
const registryVerifierChecks = verifyFormalRegistryVerifier(registryReleaseVerifierSource);
const ciGateCommands = normalizedLines(ciWorkflow, ".github/workflows/ci.yml")
  .filter((line) => /^\s+run:\s*npm\s+run\s+verify:tools:release-workflow\s*$/u.test(line));
assert(ciGateCommands.length === 1, "CI must invoke verify:tools:release-workflow exactly once as a run step");
const negativeChecks = runNegativeSelfTests({
  releaseWorkflow,
  bootstrapWorkflow,
  packageJson,
  policy,
  validationSource,
  provisionSource,
  registryReleaseVerifierSource,
  prepareGitHubReleaseSource,
  publishGitHubReleaseSource
});

console.log(JSON.stringify({
  gate: "tools-release-workflow-static",
  workflows: workflowFiles.length,
  jobs: workflowResult.jobs + bootstrapResult.jobs,
  pinnedActions: actionCount,
  publishCommands: workflowResult.publishCount + bootstrapResult.publishCount,
  upstreamPins: upstreamPinCount,
  registryVerifierChecks,
  githubReleaseScriptChecks: workflowResult.releaseScriptChecks,
  currentPolicyBlockersWhenPackageAbsent: policyResult.blockers,
  negativeChecks,
  status: "passed"
}, null, 2));
