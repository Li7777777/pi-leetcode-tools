import { join } from "node:path";

import {
  assert,
  assertJcsGoldenVectors,
  canonicalJson,
  JCS_DIGEST_ALGORITHM,
  readJson,
  resolveTarball,
  sha256Jcs,
  withExtractedPackage
} from "./release-utils.mjs";
import { verifyUpstreamParity } from "./verify-upstream-parity.mjs";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

assertJcsGoldenVectors();

function assertJsonEqual(actual, expected, label) {
  assert(canonicalJson(actual) === canonicalJson(expected), `${label} does not match`);
}

const tarball = await resolveTarball();

await withExtractedPackage(tarball, async ({ packageDirectory }) => {
  const packageJson = await readJson(join(packageDirectory, "package.json"));
  const manifest = await readJson(join(packageDirectory, "contract", "manifest.json"));
  const schema = await readJson(join(packageDirectory, "contract", "schema.json"));
  const capabilities = await readJson(
    join(packageDirectory, "contract", "capabilities.json")
  );
  const catalogs = await readJson(join(packageDirectory, "contract", "catalogs.json"));

  assert(manifest.packageName === packageJson.name, "Manifest packageName does not match package.json");
  assert(
    manifest.packageVersion === packageJson.version,
    "Manifest packageVersion does not match package.json"
  );
  assert(SEMVER_PATTERN.test(manifest.contractVersion), "contractVersion is not strict SemVer");
  assert(SEMVER_PATTERN.test(manifest.protocolVersion), "protocolVersion is not strict SemVer");
  assert(DIGEST_PATTERN.test(manifest.schemaDigest), "schemaDigest is not a SHA-256 digest");
  assert(
    manifest.behaviorDigestAlgorithm === JCS_DIGEST_ALGORITHM,
    "behaviorDigestAlgorithm is not the fixed RFC 8785/JCS algorithm"
  );
  assert(
    DIGEST_PATTERN.test(manifest.behaviorManifestDigest),
    "behaviorManifestDigest is not a SHA-256 digest"
  );
  assert(
    DIGEST_PATTERN.test(manifest.capabilityManifestDigest),
    "capabilityManifestDigest is not a SHA-256 digest"
  );
  assert(
    DIGEST_PATTERN.test(manifest.resourceCatalogDigest),
    "resourceCatalogDigest is not a SHA-256 digest"
  );

  assert(schema.packageName === manifest.packageName, "Schema packageName does not match manifest");
  assert(
    schema.contractVersion === manifest.contractVersion,
    "Schema contractVersion does not match manifest"
  );
  assert(
    schema.protocolVersion === manifest.protocolVersion,
    "Schema protocolVersion does not match manifest"
  );

  const computedSchemaDigest = sha256Jcs(schema);
  assert(
    computedSchemaDigest === manifest.schemaDigest,
    `Schema digest mismatch: expected ${manifest.schemaDigest}, computed ${computedSchemaDigest}`
  );

  const computedBehaviorDigest = sha256Jcs(manifest.behaviorManifest);
  assert(
    computedBehaviorDigest === manifest.behaviorManifestDigest,
    `Behavior digest mismatch: expected ${manifest.behaviorManifestDigest}, computed ${computedBehaviorDigest}`
  );

  const staticCapabilities = {
    packageName: capabilities.packageName,
    supportedRegions: capabilities.supportedRegions,
    tools: capabilities.tools,
    notesPort: capabilities.notesPort
  };
  const computedCapabilityDigest = sha256Jcs(staticCapabilities);
  assert(
    computedCapabilityDigest === manifest.capabilityManifestDigest,
    `Capability digest mismatch: expected ${manifest.capabilityManifestDigest}, computed ${computedCapabilityDigest}`
  );
  const computedResourceCatalogDigest = sha256Jcs(catalogs);
  assert(
    computedResourceCatalogDigest === manifest.resourceCatalogDigest,
    `Resource catalog digest mismatch: expected ${manifest.resourceCatalogDigest}, computed ${computedResourceCatalogDigest}`
  );

  for (const field of [
    "packageName",
    "packageVersion",
    "contractVersion",
    "protocolVersion",
    "schemaDigest",
    "behaviorManifestDigest",
    "capabilityManifestDigest"
  ]) {
    assert(
      capabilities[field] === manifest[field],
      `Capabilities ${field} does not match manifest`
    );
  }

  const schemaTools = Object.keys(schema.tools ?? {});
  const capabilityTools = (capabilities.tools ?? []).map((tool) => tool.name);
  assertJsonEqual(manifest.tools, schemaTools, "Manifest tools and schema tools");
  assertJsonEqual(manifest.tools, capabilityTools, "Manifest tools and capability tools");
  assert(
    new Set(manifest.tools).size === manifest.tools.length,
    "Manifest contains duplicate tool names"
  );

  const upstreamReport = await verifyUpstreamParity({
    packageDirectory,
    requireTestFiles: false
  });
  assert(
    upstreamReport.complete && upstreamReport.implemented === upstreamReport.totalUpstream,
    `Packaged upstream completeness failed: ${upstreamReport.implemented}/${upstreamReport.totalUpstream} interfaces implemented`
  );

  assert(manifest.artifacts?.schema === "schema.json", "Manifest schema artifact is invalid");
  assert(
    manifest.artifacts?.capabilities === "capabilities.json",
    "Manifest capabilities artifact is invalid"
  );
  assert(
    manifest.artifacts?.catalogs === "catalogs.json",
    "Manifest catalogs artifact is invalid"
  );

  console.log(
    `Contract verified: ${manifest.packageName}@${manifest.packageVersion}, contract ${manifest.contractVersion}`
  );
  console.log(`Schema digest: ${manifest.schemaDigest}`);
  console.log(`Behavior digest: ${manifest.behaviorManifestDigest}`);
  console.log(`Capability digest: ${manifest.capabilityManifestDigest}`);
  console.log(`Resource catalog digest: ${manifest.resourceCatalogDigest}`);
  console.log(
    `Packaged upstream parity report: ${upstreamReport.fullyVerified}/${upstreamReport.totalUpstream} fully verified, ${upstreamReport.strictBlockers.length} strict blockers`
  );
});
