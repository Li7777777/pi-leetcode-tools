#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "pi-leetcode-tools";
const apiOrigin = "https://api.github.com";
const apiVersion = "2022-11-28";
const stableSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableVersionParts(value, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value ?? "");
  assert(match !== null, `${label} must be a stable semantic version`);
  return match.slice(1).map((part) => BigInt(part));
}

function compareStableVersions(left, right) {
  const leftParts = stableVersionParts(left, "Left version");
  const rightParts = stableVersionParts(right, "Right version");
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function expectedAssetNames(version) {
  return new Set([
    `${packageName}-${version}.tgz`,
    `${packageName}-${version}-formal-registry-evidence.json`,
    `${packageName}-${version}-dist-tag-evidence.json`,
    `${packageName}-${version}-pi-activation.json`,
    `${packageName}-${version}-release-evidence.json`,
    `${packageName}-${version}-sbom.cdx.json`,
    "SHA256SUMS.txt"
  ]);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertManifest(manifest) {
  assert(manifest?.schemaVersion === 1, "GitHub Release manifest must use schemaVersion 1");
  assert(manifest.bundleType === "pi-leetcode-tools-github-release", "GitHub Release manifest has the wrong type");
  assert(manifest.package === packageName, "GitHub Release manifest has the wrong package");
  assert(stableSemverPattern.test(manifest.version ?? ""), "GitHub Release manifest version is not stable semantic version");
  const tag = `${packageName}-v${manifest.version}`;
  assert(manifest.release?.tag === tag, "GitHub Release manifest has the wrong tag");
  assert(manifest.release.title === `${packageName} ${manifest.version}`, "GitHub Release manifest has the wrong title");
  stableVersionParts(manifest.release.previousVersion, "Previous release version");
  assert(compareStableVersions(manifest.version, manifest.release.previousVersion) > 0, "GitHub Release manifest would move latest backwards");
  assert(manifest.release.previousTag === `${packageName}-v${manifest.release.previousVersion}`, "GitHub Release manifest has the wrong previous tag");
  assert(manifest.release.bodyFile === "release-notes.md", "GitHub Release manifest has the wrong body file");
  assert(digestPattern.test(manifest.release.bodySha256 ?? ""), "GitHub Release manifest has an invalid body digest");
  assert(manifest.release.draftFirst === true, "GitHub Release manifest must require draft-first publication");
  assert(manifest.release.prerelease === false, "GitHub Release manifest must not be a prerelease");
  assert(manifest.release.makeLatest === true, "GitHub Release manifest must be marked latest");
  assert(repositoryPattern.test(manifest.source?.repository ?? ""), "GitHub Release manifest has an invalid repository");
  assert(manifest.source.ref === `refs/tags/${tag}`, "GitHub Release manifest has the wrong source ref");
  assert(commitPattern.test(manifest.source.commit ?? ""), "GitHub Release manifest has an invalid source commit");
  assert(manifest.source.workflow === ".github/workflows/release-tools.yml", "GitHub Release manifest has the wrong source workflow");
  assert(manifest.npm?.registry === "https://registry.npmjs.org", "GitHub Release manifest has the wrong npm registry");
  assert(manifest.npm.distTag === "latest", "GitHub Release manifest has the wrong npm dist-tag");
  assert(digestPattern.test(manifest.npm.tarballSha256 ?? ""), "GitHub Release manifest has an invalid tgz digest");
  assert(digestPattern.test(manifest.npm.candidateRecordDigest ?? ""), "GitHub Release manifest has an invalid CandidateRecord digest");
  assert(Array.isArray(manifest.assets) && manifest.assets.length === 7, "GitHub Release manifest must list exactly seven public assets");

  const requiredNames = expectedAssetNames(manifest.version);
  const names = new Set();
  for (const asset of manifest.assets) {
    assert(typeof asset?.name === "string" && basename(asset.name) === asset.name, "GitHub Release manifest contains an unsafe asset name");
    assert(requiredNames.has(asset.name), `GitHub Release manifest contains unexpected asset ${asset.name}`);
    assert(!names.has(asset.name), `GitHub Release manifest repeats asset ${asset.name}`);
    names.add(asset.name);
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, `GitHub Release manifest has an invalid size for ${asset.name}`);
    assert(digestPattern.test(asset.sha256 ?? ""), `GitHub Release manifest has an invalid digest for ${asset.name}`);
    assert(typeof asset.contentType === "string" && asset.contentType.length > 0, `GitHub Release manifest has no content type for ${asset.name}`);
  }
  assert(names.size === requiredNames.size, "GitHub Release manifest asset inventory is incomplete");
}

async function readRegularFile(path, label) {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be one regular non-symbolic-link file`);
  return readFile(path);
}

export async function loadGitHubReleaseBundle(bundleDirectory) {
  const directory = resolve(bundleDirectory);
  const manifestBytes = await readRegularFile(join(directory, "manifest.json"), "GitHub Release manifest");
  const manifest = parseJson(manifestBytes, "GitHub Release manifest");
  assertManifest(manifest);
  const expectedEntries = new Set([
    "manifest.json",
    "release-notes.md",
    ...manifest.assets.map((asset) => asset.name)
  ]);
  const entries = await readdir(directory, { withFileTypes: true });
  assert(entries.length === expectedEntries.size, "GitHub Release bundle contains an unexpected number of files");
  for (const entry of entries) {
    assert(entry.isFile() && !entry.isSymbolicLink(), `GitHub Release bundle contains unsafe entry ${entry.name}`);
    assert(expectedEntries.has(entry.name), `GitHub Release bundle contains unexpected entry ${entry.name}`);
  }

  const releaseNotesBytes = await readRegularFile(join(directory, manifest.release.bodyFile), "GitHub Release notes");
  assert(sha256(releaseNotesBytes) === manifest.release.bodySha256, "GitHub Release notes differ from the manifest digest");
  const assets = [];
  for (const expected of manifest.assets) {
    const bytes = await readRegularFile(join(directory, expected.name), `GitHub Release asset ${expected.name}`);
    assert(bytes.length === expected.size, `GitHub Release asset ${expected.name} differs from the manifest size`);
    assert(sha256(bytes) === expected.sha256, `GitHub Release asset ${expected.name} differs from the manifest digest`);
    assets.push(Object.freeze({ ...expected, bytes }));
  }

  const checksumAsset = assets.find((asset) => asset.name === "SHA256SUMS.txt");
  const checksumLines = checksumAsset.bytes.toString("utf8").trimEnd().split("\n");
  const expectedChecksumLines = assets
    .filter((asset) => asset.name !== "SHA256SUMS.txt")
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((asset) => `${asset.sha256.slice("sha256:".length)}  ${asset.name}`);
  assert(JSON.stringify(checksumLines) === JSON.stringify(expectedChecksumLines), "SHA256SUMS does not cover the exact six non-checksum assets");

  return Object.freeze({
    directory,
    manifest,
    body: releaseNotesBytes.toString("utf8"),
    assets: Object.freeze(assets)
  });
}

function assertReleaseMetadata(release, bundle) {
  const { manifest, body } = bundle;
  assert(Number.isSafeInteger(release?.id) && release.id > 0, "Existing GitHub Release has no stable numeric id");
  assert(release.tag_name === manifest.release.tag, "Existing GitHub Release tag differs from the manifest");
  assert(release.name === manifest.release.title, "Existing GitHub Release title differs from the manifest");
  assert((release.body ?? "") === body, "Existing GitHub Release body differs from the manifest");
  assert(release.prerelease === false, "Existing GitHub Release is unexpectedly a prerelease");
  assert(typeof release.draft === "boolean", "Existing GitHub Release has no draft state");
}

function assertExpectedPredecessor(manifest, repositoryLatestRelease) {
  assert(repositoryLatestRelease !== null, `Repository latest release must be ${manifest.release.previousTag}`);
  assert(repositoryLatestRelease.tag_name === manifest.release.previousTag, "Repository latest release differs from the expected predecessor");
  assert(repositoryLatestRelease.draft === false && repositoryLatestRelease.prerelease === false, "Repository latest predecessor is not a stable published release");
}

export function planGitHubRelease({ bundle, existingRelease, existingAssets = [], repositoryLatestRelease = null }) {
  assertManifest(bundle?.manifest);
  assert(typeof bundle.body === "string" && sha256(Buffer.from(bundle.body, "utf8")) === bundle.manifest.release.bodySha256, "Planner received release notes that differ from the manifest");
  const expected = new Map(bundle.manifest.assets.map((asset) => [asset.name, asset]));
  if (existingRelease === null) {
    assert(existingAssets.length === 0, "Assets cannot exist without a GitHub Release");
    assertExpectedPredecessor(bundle.manifest, repositoryLatestRelease);
    return Object.freeze({ action: "create-draft", upload: Object.freeze([...expected.keys()].sort()) });
  }

  assertReleaseMetadata(existingRelease, bundle);
  const seen = new Set();
  for (const asset of existingAssets) {
    assert(typeof asset?.name === "string", "Existing GitHub Release asset has no name");
    assert(!seen.has(asset.name), `Existing GitHub Release repeats asset ${asset.name}`);
    seen.add(asset.name);
    const wanted = expected.get(asset.name);
    assert(wanted !== undefined, `Existing GitHub Release contains unexpected asset ${asset.name}`);
    assert(asset.state === undefined || asset.state === "uploaded", `Existing GitHub Release asset ${asset.name} is not fully uploaded`);
    assert(asset.size === wanted.size, `Existing GitHub Release asset ${asset.name} has a different size`);
    assert(asset.sha256 === wanted.sha256, `Existing GitHub Release asset ${asset.name} has a different SHA-256`);
  }
  const missing = [...expected.keys()].filter((name) => !seen.has(name)).sort();

  if (existingRelease.draft) {
    assertExpectedPredecessor(bundle.manifest, repositoryLatestRelease);
    return Object.freeze({ action: "resume-draft", upload: Object.freeze(missing) });
  }
  assert(missing.length === 0, `Published GitHub Release is missing assets: ${missing.join(", ")}`);
  assert(repositoryLatestRelease?.id === existingRelease.id, "Published GitHub Release is not the repository latest release");
  return Object.freeze({ action: "no-op", upload: Object.freeze([]) });
}

export async function peelGitTagReference(reference, readAnnotatedTag) {
  assert(reference?.object !== null && typeof reference?.object === "object", "Git tag reference has no target object");
  let object = reference.object;
  const seen = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    assert(typeof object?.type === "string" && /^[0-9a-f]{40}$/u.test(object?.sha ?? ""), "Git tag target object is invalid");
    if (object.type === "commit") return object.sha;
    assert(object.type === "tag", `Git tag points to unsupported object type ${object.type}`);
    assert(!seen.has(object.sha), "Annotated Git tag chain contains a cycle");
    seen.add(object.sha);
    const tag = await readAnnotatedTag(object.sha);
    assert(tag?.sha === object.sha && tag.object !== undefined, "Annotated Git tag response does not match the requested object");
    object = tag.object;
  }
  throw new Error("Annotated Git tag chain is too deep");
}

class GitHubHttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function apiUrl(path) {
  const url = new URL(path, apiOrigin);
  assert(url.origin === apiOrigin, "GitHub API request left api.github.com");
  return url;
}

function apiHeaders(token, accept = "application/vnd.github+json") {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "pi-leetcode-tools-github-release-publisher/1",
    "x-github-api-version": apiVersion
  };
}

async function githubRequest(url, { token, method = "GET", body, accept, contentType, allowed = [200] }) {
  const target = typeof url === "string" && url.startsWith("/") ? apiUrl(url) : new URL(url);
  assert(target.protocol === "https:" && ["api.github.com", "uploads.github.com"].includes(target.hostname), "Unsafe GitHub API URL");
  const response = await fetch(target, {
    method,
    redirect: "error",
    headers: {
      ...apiHeaders(token, accept),
      ...(body === undefined || Buffer.isBuffer(body) ? {} : { "content-type": "application/json" }),
      ...(Buffer.isBuffer(body) ? { "content-type": contentType ?? "application/octet-stream" } : {})
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
  });
  if (!allowed.includes(response.status)) {
    const responseBody = await response.text();
    throw new GitHubHttpError(`GitHub API ${method} ${target.pathname} failed with HTTP ${response.status}`, response.status, responseBody);
  }
  return response;
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

async function getReleaseByTag(repository, tag, token) {
  const response = await githubRequest(
    `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    { token, allowed: [200, 404] }
  );
  return response.status === 404 ? null : responseJson(response, "GitHub Release lookup");
}

async function getLatestRelease(repository, token) {
  const response = await githubRequest(`/repos/${repository}/releases/latest`, { token, allowed: [200, 404] });
  return response.status === 404 ? null : responseJson(response, "Latest GitHub Release lookup");
}

async function verifyTagCommit(repository, bundle, token) {
  const tag = bundle.manifest.release.tag;
  const response = await githubRequest(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, { token });
  const reference = await responseJson(response, "Git tag reference lookup");
  assert(reference.ref === `refs/tags/${tag}`, "Git tag reference lookup returned the wrong ref");
  const commit = await peelGitTagReference(reference, async (sha) => {
    const tagResponse = await githubRequest(`/repos/${repository}/git/tags/${sha}`, { token });
    return responseJson(tagResponse, "Annotated Git tag lookup");
  });
  assert(commit === bundle.manifest.source.commit, "Git release tag no longer peels to the manifest commit");
}

async function listAssets(repository, releaseId, token) {
  const response = await githubRequest(`/repos/${repository}/releases/${releaseId}/assets?per_page=100`, { token });
  const assets = await responseJson(response, "GitHub Release asset listing");
  assert(Array.isArray(assets) && assets.length < 100, "GitHub Release asset listing is invalid or unexpectedly paginated");
  return assets;
}

function safeAssetDownloadLocation(value) {
  const url = new URL(value);
  assert(url.protocol === "https:", "GitHub Release asset redirect must use HTTPS");
  assert(
    url.hostname === "github.com" ||
      url.hostname.endsWith(".github.com") ||
      url.hostname === "githubusercontent.com" ||
      url.hostname.endsWith(".githubusercontent.com"),
    `GitHub Release asset redirect used unexpected host ${url.hostname}`
  );
  return url;
}

async function downloadAsset(asset, token) {
  assert(typeof asset?.url === "string" && asset.url.startsWith(`${apiOrigin}/`), `GitHub Release asset ${asset?.name ?? "<unknown>"} has an unsafe API URL`);
  const initial = await fetch(asset.url, {
    redirect: "manual",
    headers: apiHeaders(token, "application/octet-stream")
  });
  let response = initial;
  if ([301, 302, 303, 307, 308].includes(initial.status)) {
    const location = initial.headers.get("location");
    assert(location !== null, `GitHub Release asset ${asset.name} redirect has no location`);
    response = await fetch(safeAssetDownloadLocation(location), {
      redirect: "follow",
      headers: { "user-agent": "pi-leetcode-tools-github-release-publisher/1" }
    });
    safeAssetDownloadLocation(response.url);
  }
  assert(response.ok, `GitHub Release asset ${asset.name} download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function materializeAssetIdentities(apiAssets, bundle, token) {
  const expectedNames = new Set(bundle.manifest.assets.map((asset) => asset.name));
  const seen = new Set();
  for (const asset of apiAssets) {
    assert(expectedNames.has(asset?.name), `Existing GitHub Release contains unexpected asset ${asset?.name ?? "<unnamed>"}`);
    assert(!seen.has(asset.name), `Existing GitHub Release repeats asset ${asset.name}`);
    seen.add(asset.name);
  }
  return Promise.all(apiAssets.map(async (asset) => {
    assert(asset.state === "uploaded", `Existing GitHub Release asset ${asset.name} is not fully uploaded`);
    const bytes = await downloadAsset(asset, token);
    assert(bytes.length === asset.size, `Existing GitHub Release asset ${asset.name} API size differs from downloaded bytes`);
    return Object.freeze({
      id: asset.id,
      name: asset.name,
      state: asset.state,
      size: bytes.length,
      sha256: sha256(bytes)
    });
  }));
}

async function createDraft(repository, bundle, token) {
  const { manifest, body } = bundle;
  const response = await githubRequest(`/repos/${repository}/releases`, {
    token,
    method: "POST",
    allowed: [201],
    body: {
      tag_name: manifest.release.tag,
      target_commitish: manifest.source.commit,
      name: manifest.release.title,
      body,
      draft: true,
      prerelease: false,
      generate_release_notes: false,
      make_latest: "false"
    }
  });
  return responseJson(response, "GitHub Release draft creation");
}

async function uploadAsset(release, asset, token) {
  assert(typeof release.upload_url === "string", "GitHub Release has no upload URL");
  const uploadUrl = new URL(release.upload_url.replace("{?name,label}", ""));
  assert(uploadUrl.protocol === "https:" && uploadUrl.hostname === "uploads.github.com", "GitHub Release upload URL is unsafe");
  uploadUrl.searchParams.set("name", asset.name);
  const response = await githubRequest(uploadUrl.href, {
    token,
    method: "POST",
    contentType: asset.contentType,
    allowed: [201],
    body: asset.bytes
  });
  return responseJson(response, `GitHub Release asset upload ${asset.name}`);
}

async function publishDraft(repository, releaseId, bundle, token) {
  const response = await githubRequest(`/repos/${repository}/releases/${releaseId}`, {
    token,
    method: "PATCH",
    body: {
      tag_name: bundle.manifest.release.tag,
      name: bundle.manifest.release.title,
      body: bundle.body,
      draft: false,
      prerelease: false,
      make_latest: "true"
    }
  });
  return responseJson(response, "GitHub Release publication");
}

function assertCredentialBoundary() {
  assert(!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "GitHub Release publication must not receive OIDC authority");
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const upper = name.toUpperCase();
    assert(!["NPM_TOKEN", "NODE_AUTH_TOKEN"].includes(upper), `${name} is forbidden in the GitHub Release job`);
    assert(!(upper.startsWith("NPM_CONFIG_") && /(?:AUTH|TOKEN|PASSWORD|USERNAME)/u.test(upper)), `${name} is forbidden in the GitHub Release job`);
  }
}

async function verifyCurrentState(repository, release, bundle, token, repositoryLatestRelease) {
  const apiAssets = await listAssets(repository, release.id, token);
  const assets = await materializeAssetIdentities(apiAssets, bundle, token);
  return planGitHubRelease({
    bundle,
    existingRelease: release,
    existingAssets: assets,
    repositoryLatestRelease
  });
}

export async function publishGitHubRelease({ repository, bundleDirectory, token }) {
  assert(repositoryPattern.test(repository ?? ""), "GitHub repository must be one owner/name pair");
  assert(typeof token === "string" && token.length > 0, "GITHUB_TOKEN is required");
  assertCredentialBoundary();
  const bundle = await loadGitHubReleaseBundle(bundleDirectory);
  assert(bundle.manifest.source.repository === repository, "GitHub Release bundle repository differs from GITHUB_REPOSITORY");
  if (process.env.GITHUB_ACTIONS === "true") {
    assert(process.env.GITHUB_REF === bundle.manifest.source.ref, "GitHub Release job ref differs from the manifest");
    assert((process.env.GITHUB_SHA ?? "").toLowerCase() === bundle.manifest.source.commit, "GitHub Release job commit differs from the manifest");
    assert(
      (process.env.GITHUB_WORKFLOW_REF ?? "").includes(`/${bundle.manifest.source.workflow}@${bundle.manifest.source.ref}`),
      "GitHub Release job workflow ref differs from the manifest"
    );
  }

  await verifyTagCommit(repository, bundle, token);
  const initialRepositoryLatest = await getLatestRelease(repository, token);

  let release = await getReleaseByTag(repository, bundle.manifest.release.tag, token);
  if (release === null) {
    planGitHubRelease({
      bundle,
      existingRelease: null,
      existingAssets: [],
      repositoryLatestRelease: initialRepositoryLatest
    });
    try {
      release = await createDraft(repository, bundle, token);
    } catch (error) {
      if (!(error instanceof GitHubHttpError) || error.status !== 422) throw error;
      release = await getReleaseByTag(repository, bundle.manifest.release.tag, token);
      assert(release !== null, "Concurrent GitHub Release creation failed closed without a retrievable release");
    }
  }

  const initialPlan = await verifyCurrentState(repository, release, bundle, token, initialRepositoryLatest);
  if (initialPlan.action === "no-op") {
    return { action: "no-op", releaseId: release.id, tag: release.tag_name };
  }
  assert(release.draft === true && initialPlan.action === "resume-draft", "GitHub Release publication can continue only from a matching draft");
  const byName = new Map(bundle.assets.map((asset) => [asset.name, asset]));
  for (const name of initialPlan.upload) {
    await uploadAsset(release, byName.get(name), token);
  }

  release = await getReleaseByTag(repository, bundle.manifest.release.tag, token);
  assert(release !== null && release.draft === true, "GitHub Release draft disappeared before publication");
  await verifyTagCommit(repository, bundle, token);
  const prePublishRepositoryLatest = await getLatestRelease(repository, token);
  const readyPlan = await verifyCurrentState(repository, release, bundle, token, prePublishRepositoryLatest);
  assert(readyPlan.action === "resume-draft" && readyPlan.upload.length === 0, "GitHub Release draft assets are not complete and exact");
  await publishDraft(repository, release.id, bundle, token);

  let finalRelease;
  let finalPlan;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    finalRelease = await getReleaseByTag(repository, bundle.manifest.release.tag, token);
    if (finalRelease !== null && finalRelease.draft === false) {
      try {
        finalPlan = await verifyCurrentState(repository, finalRelease, bundle, token, await getLatestRelease(repository, token));
        if (finalPlan.action === "no-op") break;
      } catch (error) {
        if (attempt === 6) throw error;
      }
    }
    if (attempt < 6) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  assert(finalRelease !== null && finalPlan?.action === "no-op", "Published GitHub Release did not converge to the exact latest release");
  return { action: "published", releaseId: finalRelease.id, tag: finalRelease.tag_name };
}

function parseArgs(argv) {
  const allowed = new Set(["repository", "bundle"]);
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
  const result = await publishGitHubRelease({
    repository: args.repository,
    bundleDirectory: args.bundle,
    token: process.env.GITHUB_TOKEN
  });
  console.log(JSON.stringify({ ...result, status: "verified" }, null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
