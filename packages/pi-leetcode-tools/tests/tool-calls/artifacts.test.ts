import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
  PROTOCOL_VERSION,
  RESOURCE_CATALOG_DIGEST,
  RPC_CHANNEL,
  SCHEMA_DIGEST,
  STATIC_CAPABILITY_MANIFEST,
  STATIC_RESOURCE_CATALOG,
  TOOL_CONTRACT_DOCUMENT,
  TOOL_NAMES
} from "../../src/tool-calls/contract.js";

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

describe("published package contract", () => {
  it("exposes only side-effect-free contract and type entry points", async () => {
    const packageJson = await readJson("package.json");

    expect(packageJson.files).toEqual([
      "dist",
      "contract",
      "upstream",
      "README.md",
      "docs/README.zh-CN.md",
      "SECURITY.md",
      "LICENSE",
      "NOTICE"
    ]);
    expect(packageJson.exports).toEqual({
      "./embedded": {
        types: "./dist/src/embedded.d.ts",
        import: "./dist/src/embedded.js"
      },
      "./types": {
        types: "./dist/src/types.d.ts",
        import: "./dist/src/types.js"
      },
      "./contract": {
        types: "./dist/src/tool-calls/contract.d.ts",
        import: "./dist/src/tool-calls/contract.js"
      }
    });
    expect(packageJson.dependencies).toEqual({
      "@napi-rs/keyring": "^1.3.0",
      "html-to-text": "^9.0.5",
      "playwright-core": "^1.61.1"
    });
    expect(packageJson.optionalDependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toEqual({
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*"
    });
    expect(packageJson.devDependencies).toMatchObject({
      "@earendil-works/pi-coding-agent": "0.80.7",
      typebox: "1.1.38"
    });
  });

  it("keeps generated schema, manifest, capabilities, and catalogs mutually consistent", async () => {
    const packageJson = await readJson("package.json");
    const schema = await readJson("contract/schema.json");
    const manifest = await readJson("contract/manifest.json");
    const capabilities = await readJson("contract/capabilities.json");
    const catalogs = await readJson("contract/catalogs.json");

    expect(schema).toEqual(TOOL_CONTRACT_DOCUMENT);
    expect(manifest).toEqual({
      packageName: PACKAGE_NAME,
      packageVersion: packageJson.version,
      contractVersion: CONTRACT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest: SCHEMA_DIGEST,
      behaviorDigestAlgorithm: `${DIGEST_CANONICALIZATION}+${DIGEST_ENCODING}+${DIGEST_ALGORITHM}`,
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
    });
    expect(capabilities).toEqual({
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
    });
    expect(catalogs).toEqual(STATIC_RESOURCE_CATALOG);
  });
});
