import { readFile, writeFile } from "node:fs/promises";

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
  JCS_DIGEST_ALGORITHM,
  sha256Jcs
} from "./release-utils.mjs";

assertJcsGoldenVectors();
const contractDigestAlgorithm =
  `${DIGEST_CANONICALIZATION}+${DIGEST_ENCODING}+${DIGEST_ALGORITHM}`;
if (contractDigestAlgorithm !== JCS_DIGEST_ALGORITHM) {
  throw new Error("Contract digest algorithm declaration is not RFC 8785/JCS + UTF-8 + SHA-256");
}
if (sha256Jcs(TOOL_CONTRACT_DOCUMENT) !== SCHEMA_DIGEST) {
  throw new Error("Contract SCHEMA_DIGEST does not use RFC 8785/JCS");
}
if (sha256Jcs(STATIC_CAPABILITY_MANIFEST) !== CAPABILITY_MANIFEST_DIGEST) {
  throw new Error("Contract CAPABILITY_MANIFEST_DIGEST does not use RFC 8785/JCS");
}
if (sha256Jcs(BEHAVIOR_MANIFEST) !== BEHAVIOR_MANIFEST_DIGEST) {
  throw new Error("Contract BEHAVIOR_MANIFEST_DIGEST does not use RFC 8785/JCS");
}

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);

if (packageJson.name !== PACKAGE_NAME) {
  throw new Error(
    `Package name ${String(packageJson.name)} does not match contract package ${PACKAGE_NAME}`
  );
}
if (packageJson.version !== PACKAGE_VERSION) {
  throw new Error(
    `Package version ${String(packageJson.version)} does not match contract package version ${PACKAGE_VERSION}`
  );
}

const manifest = {
  packageName: PACKAGE_NAME,
  packageVersion: packageJson.version,
  contractVersion: CONTRACT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  schemaDigest: SCHEMA_DIGEST,
  behaviorDigestAlgorithm: contractDigestAlgorithm,
  behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
  capabilityManifestDigest: CAPABILITY_MANIFEST_DIGEST,
  resourceCatalogDigest: RESOURCE_CATALOG_DIGEST,
  behaviorManifest: BEHAVIOR_MANIFEST,
  discoveryChannel: DISCOVERY_CHANNEL,
  rpcChannel: RPC_CHANNEL,
  artifacts: {
    schema: "schema.json",
    capabilities: "capabilities.json",
    catalogs: "catalogs.json"
  },
  tools: TOOL_NAMES
};

const capabilities = {
  packageName: PACKAGE_NAME,
  packageVersion: packageJson.version,
  contractVersion: CONTRACT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  schemaDigest: SCHEMA_DIGEST,
  behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
  capabilityManifestDigest: CAPABILITY_MANIFEST_DIGEST,
  supportedRegions: STATIC_CAPABILITY_MANIFEST.supportedRegions,
  tools: STATIC_CAPABILITY_MANIFEST.tools,
  notesPort: STATIC_CAPABILITY_MANIFEST.notesPort
};

await Promise.all([
  writeFile(
    new URL("../contract/schema.json", import.meta.url),
    `${JSON.stringify(TOOL_CONTRACT_DOCUMENT, null, 2)}\n`,
    "utf8"
  ),
  writeFile(
    new URL("../contract/manifest.json", import.meta.url),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  ),
  writeFile(
    new URL("../contract/capabilities.json", import.meta.url),
    `${JSON.stringify(capabilities, null, 2)}\n`,
    "utf8"
  ),
  writeFile(
    new URL("../contract/catalogs.json", import.meta.url),
    `${JSON.stringify(STATIC_RESOURCE_CATALOG, null, 2)}\n`,
    "utf8"
  )
]);
