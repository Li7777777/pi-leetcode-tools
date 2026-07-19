import { access, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assert,
  canonicalJson,
  readJson,
  REPOSITORY_ROOT,
  sha256Jcs
} from "./release-utils.mjs";

function assertObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`
  );
}

function resolveObjectPath(root, dottedPath, label) {
  let current = root;
  for (const segment of dottedPath.split(".")) {
    assertObject(current, `${label} parent`);
    assert(
      Object.prototype.hasOwnProperty.call(current, segment),
      `${label} does not exist`
    );
    current = current[segment];
  }
  return current;
}

function decodePointer(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

async function resolveArtifactPointer(packageDirectory, target) {
  const hash = target.indexOf("#");
  assert(hash > 0, `Packed static target is invalid: ${target}`);
  const document = await readJson(join(packageDirectory, target.slice(0, hash)));
  const pointer = target.slice(hash + 1);
  let current = document;
  if (pointer !== "") {
    assert(pointer.startsWith("/"), `Packed static target pointer is invalid: ${target}`);
    for (const rawSegment of pointer.slice(1).split("/")) {
      const segment = decodePointer(rawSegment);
      assertObject(current, `Packed static target ${target}`);
      assert(
        Object.prototype.hasOwnProperty.call(current, segment),
        `Packed static target does not exist: ${target}`
      );
      current = current[segment];
    }
  }
  return current;
}

async function makeContractDependencyVisible(packageDirectory) {
  const source = join(REPOSITORY_ROOT, "node_modules", "typebox");
  await access(source);
  const target = join(packageDirectory, "node_modules", "typebox");
  await mkdir(dirname(target), { recursive: true });
  try {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function packedIdentity(module, manifest, packageJson) {
  return {
    package: module.PACKAGE_NAME,
    packageVersion: module.PACKAGE_VERSION,
    contractVersion: module.CONTRACT_VERSION,
    protocolVersion: module.PROTOCOL_VERSION,
    schemaDigest: module.SCHEMA_DIGEST,
    behaviorManifestDigest: module.BEHAVIOR_MANIFEST_DIGEST,
    capabilityManifestDigest: module.CAPABILITY_MANIFEST_DIGEST,
    resourceCatalogDigest: module.RESOURCE_CATALOG_DIGEST,
    manifestPackage: manifest.packageName,
    packageJsonName: packageJson.name,
    packageJsonVersion: packageJson.version
  };
}

/**
 * Loads JavaScript from the extracted tgz instead of trusting source JSON.
 * This is deliberately a small load/dispatch-surface probe; full behavior is
 * still proven by the separately required packed semantic execution receipt.
 */
export async function probePackedUpstreamBehavior(packageDirectory, parityReport) {
  const packageJson = await readJson(join(packageDirectory, "package.json"));
  const manifest = await readJson(join(packageDirectory, "contract", "manifest.json"));
  const parity = await readJson(join(packageDirectory, "upstream", "parity.json"));
  const semanticSurface = await readJson(
    join(packageDirectory, "upstream", "reference-semantics.json")
  );
  await makeContractDependencyVisible(packageDirectory);
  const contractPath = join(
    packageDirectory,
    "dist",
    "src",
    "tool-calls",
    "contract.js"
  );
  await access(contractPath);
  const contractModule = await import(
    `${pathToFileURL(contractPath).href}?packedProbe=${encodeURIComponent(
      parityReport.semanticSurfaceDigest
    )}`
  );

  const identity = packedIdentity(contractModule, manifest, packageJson);
  assert(
    canonicalJson(identity) ===
      canonicalJson({
        package: parityReport.targetIdentity.package,
        packageVersion: parityReport.targetIdentity.packageVersion,
        contractVersion: parityReport.targetIdentity.contractVersion,
        protocolVersion: parityReport.targetIdentity.protocolVersion,
        schemaDigest: parityReport.targetIdentity.schemaDigest,
        behaviorManifestDigest:
          parityReport.targetIdentity.behaviorManifestDigest,
        capabilityManifestDigest:
          parityReport.targetIdentity.capabilityManifestDigest,
        resourceCatalogDigest:
          parityReport.targetIdentity.resourceCatalogDigest,
        manifestPackage: parityReport.targetIdentity.package,
        packageJsonName: parityReport.targetIdentity.package,
        packageJsonVersion: parityReport.targetIdentity.packageVersion
      }),
    "Packed JavaScript identity does not match the packed contract/parity target"
  );
  assert(
    canonicalJson([...contractModule.TOOL_NAMES].sort()) ===
      canonicalJson([...manifest.tools].sort()),
    "Packed JavaScript tool names do not match contract/manifest.json"
  );

  const semanticIds = new Set(
    semanticSurface.interfaces.map((entry) => entry.sourceId)
  );
  const checks = [];
  for (const mapping of parity.mappings) {
    assert(
      semanticIds.has(mapping.sourceId),
      `Packed parity target is absent from semantic surface: ${mapping.sourceId}`
    );
    assert(
      ["native_tool", "gateway_capability", "static_contract_resource"].includes(
        mapping.status
      ),
      `Packed behavior cannot pass an incomplete mapping: ${mapping.sourceId}`
    );
    if (mapping.status === "native_tool") {
      for (const target of mapping.targets) {
        assert(
          contractModule.TOOL_INPUT_SCHEMAS[target] !== undefined &&
            contractModule.TOOL_OUTPUT_SCHEMAS[target] !== undefined,
          `Packed JavaScript does not expose schemas for ${mapping.sourceId}: ${target}`
        );
      }
    } else if (mapping.status === "gateway_capability") {
      for (const target of mapping.targets) {
        assert(
          target.startsWith("gateway:"),
          `Packed gateway target is invalid: ${target}`
        );
        resolveObjectPath(
          contractModule.TOOL_CONTRACT_DOCUMENT,
          target.slice("gateway:".length),
          `Packed gateway target ${target}`
        );
      }
    } else {
      for (const target of mapping.targets) {
        await resolveArtifactPointer(packageDirectory, target);
      }
    }
    checks.push({
      checkId: `packed/${mapping.sourceId}/target-resolves`,
      status: "passed",
      evidenceDigest: sha256Jcs({
        sourceId: mapping.sourceId,
        status: mapping.status,
        targets: mapping.targets
      })
    });
  }

  assert(
    checks.length === 24,
    "Packed JavaScript behavior probe must resolve all 24 interfaces"
  );
  const receipt = {
    schemaVersion: 1,
    receiptType: "packed-upstream-js-probe",
    reference: {
      inventoryDigest: parityReport.inventoryDigest,
      semanticSurfaceDigest: parityReport.semanticSurfaceDigest
    },
    target: parityReport.targetIdentity,
    checks: checks.sort((left, right) => left.checkId.localeCompare(right.checkId))
  };
  return { ...receipt, receiptDigest: sha256Jcs(receipt) };
}
