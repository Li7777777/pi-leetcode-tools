import { access, readFile } from "node:fs/promises";

import {
  BEHAVIOR_MANIFEST,
  BEHAVIOR_MANIFEST_DIGEST,
  CAPABILITY_MANIFEST_DIGEST,
  CONTRACT_VERSION,
  DIGEST_ALGORITHM,
  DIGEST_CANONICALIZATION,
  DIGEST_ENCODING,
  DISCOVERY_CHANNEL,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  RESOURCE_CATALOG_DIGEST,
  RPC_CHANNEL,
  SCHEMA_DIGEST,
  STATIC_CAPABILITY_MANIFEST,
  STATIC_RESOURCE_CATALOG,
  TOOL_CONTRACT_DOCUMENT,
  TOOL_NAMES
} from "../dist/src/tool-calls/contract.js";
import {
  assertJcsGoldenVectors,
  canonicalJson,
  JCS_DIGEST_ALGORITHM,
  sha256Jcs
} from "./release-utils.mjs";
import { verifyUpstreamParity } from "./verify-upstream-parity.mjs";

assertJcsGoldenVectors();
const contractDigestAlgorithm =
  `${DIGEST_CANONICALIZATION}+${DIGEST_ENCODING}+${DIGEST_ALGORITHM}`;
assert(
  contractDigestAlgorithm === JCS_DIGEST_ALGORITHM,
  "contract digest algorithm declaration is stale"
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

const packageJson = await readJson(new URL("../package.json", import.meta.url));
const schema = await readJson(new URL("../contract/schema.json", import.meta.url));
const manifest = await readJson(new URL("../contract/manifest.json", import.meta.url));
const capabilities = await readJson(
  new URL("../contract/capabilities.json", import.meta.url)
);
const catalogs = await readJson(new URL("../contract/catalogs.json", import.meta.url));

assert(packageJson.name === PACKAGE_NAME, "dist package name is stale");
assert(packageJson.version === PACKAGE_VERSION, "dist package version is stale");
assert(
  JSON.stringify(packageJson.dependencies) ===
    JSON.stringify({
      "@napi-rs/keyring": "^1.3.0",
      "html-to-text": "^9.0.5",
      "playwright-core": "^1.61.1"
    }),
  "Tools runtime dependency allowlist changed"
);
assert(
  packageJson.optionalDependencies === undefined,
  "Tools must not use optional runtime dependencies"
);
assert(
  JSON.stringify(packageJson.peerDependencies) ===
    JSON.stringify({
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*"
    }),
  "Tools Pi/typebox peer dependency boundary is stale"
);
assert(
  packageJson.devDependencies?.typebox === "1.1.38" &&
    packageJson.devDependencies?.["@earendil-works/pi-coding-agent"] === "0.80.7",
  "Tools development peer baselines are stale"
);
assert(
  packageJson.exports?.["./embedded"]?.import === "./dist/src/embedded.js",
  "Tools embedded runtime export is stale"
);
assert(sha256Jcs(TOOL_CONTRACT_DOCUMENT) === SCHEMA_DIGEST, "schema digest is not RFC 8785/JCS");
assert(
  sha256Jcs(BEHAVIOR_MANIFEST) === BEHAVIOR_MANIFEST_DIGEST,
  "behavior digest is not RFC 8785/JCS"
);
assert(
  sha256Jcs(STATIC_CAPABILITY_MANIFEST) === CAPABILITY_MANIFEST_DIGEST,
  "capability digest is not RFC 8785/JCS"
);
assert(
  canonicalJson(schema) === canonicalJson(TOOL_CONTRACT_DOCUMENT),
  "contract/schema.json is stale; run the release build before packing"
);
assert(manifest.packageName === PACKAGE_NAME, "contract manifest packageName is stale");
assert(manifest.packageVersion === PACKAGE_VERSION, "contract manifest packageVersion is stale");
assert(manifest.contractVersion === CONTRACT_VERSION, "contract manifest version is stale");
assert(manifest.protocolVersion === PROTOCOL_VERSION, "protocol manifest version is stale");
assert(manifest.schemaDigest === SCHEMA_DIGEST, "contract manifest schema digest is stale");
assert(
  manifest.behaviorDigestAlgorithm === contractDigestAlgorithm,
  "contract manifest behavior digest algorithm is stale"
);
assert(
  manifest.behaviorManifestDigest === BEHAVIOR_MANIFEST_DIGEST,
  "contract manifest behavior digest is stale"
);
assert(
  canonicalJson(manifest.behaviorManifest) === canonicalJson(BEHAVIOR_MANIFEST),
  "contract manifest behavior semantics are stale"
);
assert(
  manifest.capabilityManifestDigest === CAPABILITY_MANIFEST_DIGEST,
  "contract manifest capability digest is stale"
);
assert(
  manifest.resourceCatalogDigest === RESOURCE_CATALOG_DIGEST,
  "contract manifest resource catalog digest is stale"
);
assert(manifest.artifacts?.catalogs === "catalogs.json", "contract manifest catalogs artifact is stale");
assert(manifest.discoveryChannel === DISCOVERY_CHANNEL, "discovery channel is stale");
assert(manifest.rpcChannel === RPC_CHANNEL, "RPC channel is stale");
assert(
  canonicalJson(manifest.tools) === canonicalJson(TOOL_NAMES),
  "contract manifest tool list is stale"
);

const expectedCapabilities = {
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  contractVersion: CONTRACT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  schemaDigest: SCHEMA_DIGEST,
  behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
  capabilityManifestDigest: CAPABILITY_MANIFEST_DIGEST,
  supportedRegions: STATIC_CAPABILITY_MANIFEST.supportedRegions,
  tools: STATIC_CAPABILITY_MANIFEST.tools,
  notesPort: STATIC_CAPABILITY_MANIFEST.notesPort
};
assert(
  canonicalJson(capabilities) === canonicalJson(expectedCapabilities),
  "contract/capabilities.json is stale"
);
assert(
  canonicalJson(catalogs) === canonicalJson(STATIC_RESOURCE_CATALOG),
  "contract/catalogs.json is stale"
);
assert(
  sha256Jcs(catalogs) === RESOURCE_CATALOG_DIGEST,
  "contract resource catalog digest is stale"
);

for (const relativePath of [
  "../dist/extensions/index.js",
  "../dist/src/embedded.js",
  "../dist/src/types.js",
  "../upstream/reference-surface.json",
  "../upstream/reference-semantics.json",
  "../upstream/semantic-case-bindings.json",
  "../upstream/parity.json",
  "../contract/catalogs.json",
  "../README.md",
  "../README.zh-CN.md",
  "../SECURITY.md",
  "../LICENSE"
]) {
  await access(new URL(relativePath, import.meta.url));
}

const upstreamReport = await verifyUpstreamParity();

console.log(
  `Release artifact verified without rebuilding: ${PACKAGE_NAME}@${PACKAGE_VERSION}`
);
console.log(
  `Upstream parity report validated: ${upstreamReport.fullyVerified}/${upstreamReport.totalUpstream} fully verified, ${upstreamReport.strictBlockers.length} strict blockers`
);
