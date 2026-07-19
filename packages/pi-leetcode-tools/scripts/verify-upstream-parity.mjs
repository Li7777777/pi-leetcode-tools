import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assert,
  canonicalJson,
  readJson,
  resolveInside,
  sha256Jcs
} from "./release-utils.mjs";
import {
  extractLeetCodeQueryReference,
  extractUpstreamInventory
} from "./upstream-inventory.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_REFERENCE_TARBALL = resolve(
  DEFAULT_PACKAGE_DIRECTORY,
  "..",
  "..",
  ".artifacts",
  "upstream-reference",
  "jinzcdev-leetcode-mcp-server-1.4.0.tgz"
);
const DEFAULT_QUERY_TARBALL = resolve(
  DEFAULT_PACKAGE_DIRECTORY,
  "..",
  "..",
  ".artifacts",
  "upstream-reference",
  "leetcode-query-2.0.1.tgz"
);
const EXPECTED_REFERENCE = Object.freeze({
  package: "@jinzcdev/leetcode-mcp-server",
  version: "1.4.0",
  researchCommit: "126115fc",
  repository: "https://github.com/jinzcdev/leetcode-mcp-server",
  license: "MIT",
  tarballIntegrity: "sha512-9DewGzg265ob+ld0dq8R2yzK7/k9RCPE/KNKB/3cDAeiIuONPi1OopAzAcAkHpYnXG/xgxDwuy8tokZjX3BTpw==",
  tarballSha256: "976ffafb49f1a3d2132a119e71af28b2911b4c56480bcb58097fa9d1c9657b56",
  tarballSizeBytes: 46005,
  inventoryDigest: "sha256:9a89de5f253c3e9c7e4ef476690d477ed8aa4c6ca43399150a16b0d09b1ca4b2",
  tools: 19,
  resources: 5,
  total: 24
});
const EXPECTED_INTERFACE_IDS = Object.freeze([
  "tool:get_daily_challenge",
  "tool:get_problem",
  "tool:search_problems",
  "tool:run_code",
  "tool:submit_solution",
  "tool:get_user_profile",
  "tool:get_recent_submissions",
  "tool:get_recent_ac_submissions",
  "tool:get_user_status",
  "tool:get_problem_submission_report",
  "tool:get_problem_progress",
  "tool:get_all_submissions",
  "tool:get_user_contest_ranking",
  "tool:search_notes",
  "tool:get_note",
  "tool:create_note",
  "tool:update_note",
  "tool:list_problem_solutions",
  "tool:get_problem_solution",
  "resource:problem-categories",
  "resource:problem-tags",
  "resource:problem-langs",
  "resource:problem-detail",
  "resource:problem-solution"
]);
const ALLOWED_STATUSES = new Set([
  "native_tool",
  "gateway_capability",
  "static_contract_resource",
  "explicitly_unsupported",
  "missing",
  "partial",
  "superseded"
]);
const IMPLEMENTED_STATUSES = new Set([
  "native_tool",
  "gateway_capability",
  "static_contract_resource"
]);
const INCOMPLETE_STATUSES = new Set(["missing", "partial", "superseded"]);
const SEMANTIC_DIMENSIONS = Object.freeze([
  "inputSchema",
  "outputSchema",
  "authentication",
  "regions",
  "capability",
  "paginationDefaults",
  "sensitiveData",
  "errorSemantics"
]);
const SEMANTIC_CASE_DIMENSIONS = Object.freeze([
  "input_contract",
  "output_contract",
  "auth_subject_scope",
  "region_endpoint",
  "pagination_defaults_filters",
  "capability_side_effect",
  "sensitive_data",
  "error_semantics"
]);
const EVIDENCE_REFERENCE_DIMENSIONS = Object.freeze([
  "tests",
  "documentation"
]);
const EVIDENCE_DIMENSIONS = Object.freeze([
  ...SEMANTIC_DIMENSIONS,
  ...EVIDENCE_REFERENCE_DIMENSIONS
]);
const ALLOWED_EVIDENCE_STATUSES = new Set([
  "verified",
  "missing",
  "partial",
  "superseded"
]);
const ALLOWED_REGIONS = new Set(["global", "cn"]);
const ALLOWED_AUTH = new Set(["public", "required"]);
const ALLOWED_CONSEQUENCES = new Set([
  "read",
  "sensitive_read",
  "answer_read",
  "execution",
  "external_write"
]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

function assertObject(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertString(value, label) {
  assert(typeof value === "string" && value.trim().length > 0, `${label} must be a non-empty string`);
}

function assertUniqueStrings(value, label, { allowEmpty = false } = {}) {
  assert(Array.isArray(value), `${label} must be an array`);
  if (!allowEmpty) {
    assert(value.length > 0, `${label} must not be empty`);
  }
  for (const [index, item] of value.entries()) {
    assertString(item, `${label}[${index}]`);
  }
  assert(new Set(value).size === value.length, `${label} contains duplicates`);
}

function assertExactSet(actual, expected, label) {
  assertUniqueStrings(actual, label, { allowEmpty: expected.length === 0 });
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  assert(canonicalJson(sortedActual) === canonicalJson(sortedExpected), `${label} is not the fixed reference set`);
}

function resolveObjectPath(root, dottedPath, label) {
  const segments = dottedPath.split(".");
  assert(segments.every((segment) => segment.length > 0), `${label} contains an empty path segment`);
  let current = root;
  for (const segment of segments) {
    assertObject(current, `${label} parent`);
    assert(Object.prototype.hasOwnProperty.call(current, segment), `${label} does not exist`);
    current = current[segment];
  }
  return current;
}

function decodeJsonPointerSegment(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

async function resolveArtifactPointer(packageDirectory, target) {
  assertString(target, "static_contract_resource target");
  const hashIndex = target.indexOf("#");
  assert(hashIndex > 0, `Static resource target must use <file>#<JSON pointer>: ${target}`);
  const relativePath = target.slice(0, hashIndex);
  const pointer = target.slice(hashIndex + 1);
  assert(pointer === "" || pointer.startsWith("/"), `Static resource target must use an RFC 6901 pointer: ${target}`);

  const absolutePath = resolveInside(packageDirectory, relativePath, "Static resource artifact");
  const document = await readJson(absolutePath);
  let current = document;
  if (pointer !== "") {
    for (const rawSegment of pointer.slice(1).split("/")) {
      const segment = decodeJsonPointerSegment(rawSegment);
      assert(current !== null && typeof current === "object", `Static resource pointer is not traversable: ${target}`);
      assert(Object.prototype.hasOwnProperty.call(current, segment), `Static resource pointer does not exist: ${target}`);
      current = current[segment];
    }
  }
  assert(current !== undefined, `Static resource target resolves to undefined: ${target}`);
  return current;
}

function referenceArchiveInterface(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    inputFields: [...entry.inputFields].sort(),
    ...(entry.kind === "resource" ? { uriTemplates: [...entry.uriTemplates].sort() } : {})
  };
}

async function validateReferenceArchive(reference, referenceTarball) {
  const extracted = await extractUpstreamInventory(referenceTarball);
  assert(extracted.sizeBytes === reference.source.tarball.sizeBytes, "Pinned upstream archive size does not match the receipt");
  assert(extracted.sha256 === reference.source.tarball.sha256, "Pinned upstream archive SHA-256 does not match the receipt");
  assert(extracted.integrity === reference.source.tarball.integrity, "Pinned upstream archive SHA-512 integrity does not match the receipt");
  assert(extracted.surface.package === reference.source.package, "Extracted upstream package name does not match the reference surface");
  assert(extracted.surface.version === reference.source.version, "Extracted upstream package version does not match the reference surface");
  assert(extracted.surface.counts.tools === reference.expectedCounts.tools, "Extracted upstream tool count does not match the reference surface");
  assert(extracted.surface.counts.resources === reference.expectedCounts.resources, "Extracted upstream resource count does not match the reference surface");
  assert(extracted.surface.counts.total === reference.expectedCounts.total, "Extracted upstream interface count does not match the reference surface");

  const extractedSurface = extracted.surface.interfaces.map((entry) => referenceArchiveInterface(entry));
  const declaredSurface = reference.interfaces
    .map((entry) => referenceArchiveInterface(entry))
    .sort((left, right) => left.id.localeCompare(right.id));
  assert(
    canonicalJson(extractedSurface) === canonicalJson(declaredSurface),
    "reference-surface.json does not exactly match the interfaces and input fields extracted from the pinned upstream archive"
  );
  return extracted;
}

function jsonSchemaProperties(schemaNode, label) {
  assertObject(schemaNode, label);
  if (schemaNode.properties !== undefined) {
    assertObject(schemaNode.properties, `${label}.properties`);
    return schemaNode.properties;
  }
  throw new Error(`${label} does not expose object properties for input-field verification`);
}

function schemaAllowedRegions(schemaNode) {
  const properties = jsonSchemaProperties(schemaNode, "input schema");
  const region = properties.region;
  if (region === undefined) return [];
  const values = new Set();
  function collect(node) {
    if (node === null || typeof node !== "object") return;
    if (typeof node.const === "string") values.add(node.const);
    if (Array.isArray(node.enum)) {
      for (const value of node.enum) if (typeof value === "string") values.add(value);
    }
    if (Array.isArray(node.anyOf)) for (const item of node.anyOf) collect(item);
    if (Array.isArray(node.oneOf)) for (const item of node.oneOf) collect(item);
  }
  collect(region);
  return [...values];
}

function assertReadmeAnchor(readme, anchor, label) {
  assertString(anchor, label);
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`<a\\s+id=["']${escaped}["']\\s*><\\/a>`, "u");
  assert(pattern.test(readme), `${label} is missing from README.md`);
}

function capabilityByName(capabilities, target, sourceId) {
  assert(Array.isArray(capabilities.tools), "contract capabilities tools must be an array");
  const matches = capabilities.tools.filter((tool) => tool?.name === target);
  assert(matches.length === 1, `${sourceId} target must have exactly one capability entry: ${target}`);
  return matches[0];
}

function expectedSubjectScope(referenceEntry) {
  if (referenceEntry.authentication === "required") return "current_user";
  if (referenceEntry.inputFields.includes("username")) return "arbitrary_user";
  return "none";
}

function expectedSideEffect(consequence) {
  if (consequence === "execution") return "remote_execution";
  if (consequence === "external_write") return "remote_write";
  return "none";
}

function expectedSensitiveClassification(referenceEntry) {
  if (referenceEntry.consequence === "answer_read") return "answer_bearing";
  if (referenceEntry.category === "notes") return "personal_notes";
  if (referenceEntry.consequence === "sensitive_read") return "source_code";
  if (referenceEntry.authentication === "required") return "account_private";
  return "public";
}

function assertJsonScalar(value, label) {
  assert(
    value === null || ["string", "number", "boolean"].includes(typeof value),
    `${label} must be a JSON scalar`
  );
}

function validateReference(reference) {
  assertObject(reference, "reference surface");
  assert(reference.schemaVersion === 2, "reference surface schemaVersion must be 2");
  assert(reference.surfaceType === "reference-mcp-surface", "reference surfaceType is invalid");
  assertObject(reference.source, "reference source");
  assert(reference.source.package === EXPECTED_REFERENCE.package, "reference package is not pinned");
  assert(reference.source.version === EXPECTED_REFERENCE.version, "reference version is not pinned");
  assert(reference.source.researchCommit === EXPECTED_REFERENCE.researchCommit, "reference commit is not pinned");
  assert(reference.source.license === EXPECTED_REFERENCE.license, "reference license is not MIT");
  assert(reference.source.repository === EXPECTED_REFERENCE.repository, "reference repository is not pinned");
  assertObject(reference.source.tarball, "reference tarball receipt");
  assert(SHA512_INTEGRITY_PATTERN.test(reference.source.tarball.integrity), "reference tarball integrity is invalid");
  assert(/^[0-9a-f]{64}$/u.test(reference.source.tarball.sha256), "reference tarball SHA-256 is invalid");
  assert(Number.isSafeInteger(reference.source.tarball.sizeBytes) && reference.source.tarball.sizeBytes > 0, "reference tarball size is invalid");
  assert(reference.source.tarball.integrity === EXPECTED_REFERENCE.tarballIntegrity, "reference tarball integrity is not pinned");
  assert(reference.source.tarball.sha256 === EXPECTED_REFERENCE.tarballSha256, "reference tarball SHA-256 is not pinned");
  assert(reference.source.tarball.sizeBytes === EXPECTED_REFERENCE.tarballSizeBytes, "reference tarball size is not pinned");

  assertObject(reference.expectedCounts, "reference expectedCounts");
  assert(reference.expectedCounts.tools === EXPECTED_REFERENCE.tools, "reference tool count must be 19");
  assert(reference.expectedCounts.resources === EXPECTED_REFERENCE.resources, "reference resource count must be 5");
  assert(reference.expectedCounts.total === EXPECTED_REFERENCE.total, "reference total count must be 24");
  assert(Array.isArray(reference.interfaces), "reference interfaces must be an array");
  assert(reference.interfaces.length === EXPECTED_REFERENCE.total, "reference interfaces must contain 24 entries");

  const interfaceIds = [];
  let toolCount = 0;
  let resourceCount = 0;
  for (const [index, entry] of reference.interfaces.entries()) {
    const label = `reference.interfaces[${index}]`;
    assertObject(entry, label);
    assertString(entry.id, `${label}.id`);
    assert(entry.kind === "tool" || entry.kind === "resource", `${label}.kind is invalid`);
    assert(entry.id.startsWith(`${entry.kind}:`), `${label}.id does not match kind`);
    assertString(entry.name, `${label}.name`);
    assert(entry.id === `${entry.kind}:${entry.name}`, `${label}.name does not match id`);
    assertString(entry.category, `${label}.category`);
    assertUniqueStrings(entry.regions, `${label}.regions`);
    assert(entry.regions.every((region) => ALLOWED_REGIONS.has(region)), `${label}.regions contains an unsupported region`);
    assert(ALLOWED_AUTH.has(entry.authentication), `${label}.authentication is invalid`);
    assert(ALLOWED_CONSEQUENCES.has(entry.consequence), `${label}.consequence is invalid`);
    assertUniqueStrings(entry.inputFields, `${label}.inputFields`, { allowEmpty: true });
    if (entry.kind === "resource") {
      assertUniqueStrings(entry.uriTemplates, `${label}.uriTemplates`);
      for (const template of entry.uriTemplates) {
        const templateFields = [...template.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]);
        assert(
          canonicalJson([...templateFields].sort()) ===
            canonicalJson(entry.inputFields.filter((field) => templateFields.includes(field)).sort()),
          `${label}.uriTemplates and inputFields disagree`
        );
      }
    } else {
      assert(entry.uriTemplates === undefined, `${label}.uriTemplates is only valid for resources`);
    }
    interfaceIds.push(entry.id);
    if (entry.kind === "tool") toolCount += 1;
    else resourceCount += 1;
  }
  assertExactSet(interfaceIds, EXPECTED_INTERFACE_IDS, "reference interface IDs");
  assert(toolCount === EXPECTED_REFERENCE.tools, "computed reference tool count is not 19");
  assert(resourceCount === EXPECTED_REFERENCE.resources, "computed reference resource count is not 5");

  const computedInventoryDigest = sha256Jcs({
    source: reference.source,
    expectedCounts: reference.expectedCounts,
    interfaces: reference.interfaces
  });
  assert(DIGEST_PATTERN.test(reference.inventoryDigest), "reference inventoryDigest is invalid");
  assert(reference.inventoryDigest === EXPECTED_REFERENCE.inventoryDigest, "reference inventoryDigest is not pinned");
  assert(reference.inventoryDigest === computedInventoryDigest, "reference inventoryDigest is stale");
  return { interfaceIds, computedInventoryDigest };
}

function semanticSurfacePayload(surface) {
  const { semanticSurfaceDigest: _digest, ...payload } = surface;
  return payload;
}

function queryDependencyIdentity(reference) {
  return {
    package: reference.package,
    version: reference.version,
    license: reference.license,
    tarball: {
      sizeBytes: reference.sizeBytes,
      sha256: reference.sha256,
      integrity: reference.integrity
    },
    library: reference.library,
    graphqlQueryCount: reference.graphqlQueryCount,
    graphqlCatalogDigest: reference.graphqlCatalogDigest
  };
}

function validateSourcePointer(pointer, archiveInventory, queryReference, label) {
  assertString(pointer, label);
  const hash = pointer.indexOf("#");
  const path = hash === -1 ? pointer : pointer.slice(0, hash);
  const symbol = hash === -1 ? undefined : pointer.slice(hash + 1);
  let source;
  if (path === "leetcode-query/lib/index.js") {
    source = queryReference.librarySource;
  } else {
    source = archiveInventory.sourceTextByPath[path];
  }
  assertString(source, `${label} source file`);
  if (symbol !== undefined) {
    assertString(symbol, `${label} symbol`);
    assert(source.includes(symbol), `${label} symbol is absent from the pinned source`);
  }
}

function validateSemanticSurface(
  surface,
  reference,
  archiveInventory,
  queryReference
) {
  assertObject(surface, "reference semantic surface");
  assert(surface.schemaVersion === 1, "reference semantic surface schemaVersion must be 1");
  assert(
    surface.surfaceType === "reference-mcp-semantic-surface",
    "reference semantic surfaceType is invalid"
  );
  assertObject(surface.source, "reference semantic source");
  assertObject(surface.source.mcp, "reference semantic MCP source");
  assert(
    surface.source.mcp.package === reference.source.package &&
      surface.source.mcp.version === reference.source.version &&
      surface.source.mcp.inventoryDigest === reference.inventoryDigest,
    "reference semantic MCP identity is stale"
  );
  assertObject(
    surface.source.queryDependency,
    "reference semantic query dependency"
  );
  assert(
    canonicalJson(surface.source.queryDependency) ===
      canonicalJson(queryDependencyIdentity(queryReference)),
    "Pinned leetcode-query receipt or GraphQL catalog does not match reference-semantics.json"
  );
  assertExactSet(
    surface.semanticDimensions,
    SEMANTIC_CASE_DIMENSIONS,
    "reference semantic dimensions"
  );
  assertString(surface.caseIdFormat, "reference semantic caseIdFormat");
  assert(
    surface.caseIdFormat ===
      "upstream/<sourceId>/<variantId>/<semanticDimension>",
    "reference semantic caseIdFormat is not pinned"
  );
  assert(Array.isArray(surface.interfaces), "reference semantic interfaces must be an array");
  assert(
    surface.interfaces.length === EXPECTED_REFERENCE.total,
    "reference semantic surface must contain 24 interfaces"
  );
  assertExactSet(
    surface.interfaces.map((entry) => entry?.sourceId),
    reference.interfaces.map((entry) => entry.id),
    "reference semantic interface IDs"
  );

  const referenceById = new Map(reference.interfaces.map((entry) => [entry.id, entry]));
  for (const [index, entry] of surface.interfaces.entries()) {
    const label = `reference semantic interfaces[${index}]`;
    assertObject(entry, label);
    const referenceEntry = referenceById.get(entry.sourceId);
    assert(referenceEntry !== undefined, `${label}.sourceId is not in the inventory`);
    assertObject(entry.inputContract, `${label}.inputContract`);
    assertString(entry.outputContract, `${label}.outputContract`);
    assertUniqueStrings(entry.sourcePointers, `${label}.sourcePointers`);
    for (const [pointerIndex, pointer] of entry.sourcePointers.entries()) {
      validateSourcePointer(
        pointer,
        archiveInventory,
        queryReference,
        `${label}.sourcePointers[${pointerIndex}]`
      );
    }
    assertString(entry.documentationAnchor, `${label}.documentationAnchor`);
    assert(entry.behaviorCaseRequired === true, `${label} must require behavior cases`);
    assert(entry.packedBehaviorRequired === true, `${label} must require packed behavior`);
    assert(Array.isArray(entry.variants) && entry.variants.length > 0, `${label}.variants must not be empty`);
    const variantIds = [];
    const variantRegions = [];
    for (const [variantIndex, variant] of entry.variants.entries()) {
      const variantLabel = `${label}.variants[${variantIndex}]`;
      assertObject(variant, variantLabel);
      assertString(variant.id, `${variantLabel}.id`);
      assert(ALLOWED_REGIONS.has(variant.region), `${variantLabel}.region is invalid`);
      assert(
        variant.auth === referenceEntry.authentication,
        `${variantLabel}.auth does not match the inventory`
      );
      assertString(variant.endpoint, `${variantLabel}.endpoint`);
      assertString(variant.operation, `${variantLabel}.operation`);
      assertObject(variant.defaults, `${variantLabel}.defaults`);
      variantIds.push(variant.id);
      variantRegions.push(variant.region);
    }
    assertUniqueStrings(variantIds, `${label} variant IDs`);
    assertExactSet(
      variantRegions,
      referenceEntry.regions,
      `${label} variant regions`
    );
  }

  assert(DIGEST_PATTERN.test(surface.semanticSurfaceDigest), "reference semantic digest is invalid");
  const computedDigest = sha256Jcs(semanticSurfacePayload(surface));
  assert(
    surface.semanticSurfaceDigest === computedDigest,
    "reference semantic surface digest is stale"
  );
  return {
    semanticSurfaceDigest: computedDigest,
    queryDependency: queryDependencyIdentity(queryReference)
  };
}

function validateTargetBinding(parity, packageJson, manifest) {
  assertObject(parity.target, "parity target");
  const expectedTarget = {
    package: packageJson.name,
    packageVersion: packageJson.version,
    contractVersion: manifest.contractVersion,
    protocolVersion: manifest.protocolVersion,
    schemaDigest: manifest.schemaDigest,
    behaviorManifestDigest: manifest.behaviorManifestDigest,
    capabilityManifestDigest: manifest.capabilityManifestDigest,
    resourceCatalogDigest: manifest.resourceCatalogDigest
  };
  assert(canonicalJson(parity.target) === canonicalJson(expectedTarget), "parity target binding is stale for the current contract");
}

function evidenceDimension(mapping, dimension, blockers) {
  assertObject(mapping.evidence, `${mapping.sourceId}.evidence`);
  const evidence = mapping.evidence[dimension];
  assertObject(evidence, `${mapping.sourceId}.evidence.${dimension}`);
  assert(
    ALLOWED_EVIDENCE_STATUSES.has(evidence.status),
    `${mapping.sourceId}.evidence.${dimension}.status is invalid`
  );
  if (evidence.status !== "verified") {
    assertString(evidence.reason, `${mapping.sourceId}.evidence.${dimension}.reason`);
    blockers.push({ sourceId: mapping.sourceId, dimension, status: evidence.status });
    return undefined;
  }
  return evidence;
}

async function validateTestEvidence(packageDirectory, mapping, evidence, requireTestFiles) {
  assertUniqueStrings(evidence.files, `${mapping.sourceId}.evidence.tests.files`);
  for (const relativePath of evidence.files) {
    assert(!relativePath.includes("\\"), `${mapping.sourceId} test evidence must use portable paths`);
    assert(relativePath.startsWith("tests/"), `${mapping.sourceId} test evidence must be under tests/`);
    const absolutePath = resolveInside(packageDirectory, relativePath, `${mapping.sourceId} test evidence`);
    if (requireTestFiles) {
      await access(absolutePath);
      const source = await readFile(absolutePath, "utf8");
      assert(
        /\b(?:describe|it|test)\s*\(/u.test(source),
        `${mapping.sourceId} test evidence contains no executable test cases: ${relativePath}`
      );
    }
  }
}

async function validateImplementedEvidence({
  packageDirectory,
  mapping,
  referenceEntry,
  schema,
  capabilities,
  readme,
  requireTestFiles,
  blockers
}) {
  const dimensions = Object.fromEntries(
    EVIDENCE_DIMENSIONS.map((dimension) => [
      dimension,
      evidenceDimension(mapping, dimension, blockers)
    ])
  );

  const inputEvidence = dimensions.inputSchema;
  let inputSchema;
  if (inputEvidence !== undefined) {
    assertString(inputEvidence.target, `${mapping.sourceId}.evidence.inputSchema.target`);
    assertObject(inputEvidence.fieldMap, `${mapping.sourceId}.evidence.inputSchema.fieldMap`);
    assertExactSet(
      Object.keys(inputEvidence.fieldMap),
      referenceEntry.inputFields,
      `${mapping.sourceId}.evidence.inputSchema.fieldMap source fields`
    );
    if (inputEvidence.target === "none") {
      assert(mapping.status === "static_contract_resource", `${mapping.sourceId} may use input target none only for a static resource`);
      assert(referenceEntry.inputFields.length === 0, `${mapping.sourceId} cannot omit a non-empty upstream input schema`);
    } else {
      inputSchema = resolveObjectPath(schema, inputEvidence.target, `${mapping.sourceId} input schema target`);
      const properties = jsonSchemaProperties(inputSchema, `${mapping.sourceId} input schema target`);
      for (const [sourceField, targetField] of Object.entries(inputEvidence.fieldMap)) {
        assertString(targetField, `${mapping.sourceId}.evidence.inputSchema.fieldMap.${sourceField}`);
        assert(
          Object.prototype.hasOwnProperty.call(properties, targetField),
          `${mapping.sourceId} input field ${sourceField} maps to a missing target field: ${targetField}`
        );
      }
      if (mapping.status === "native_tool") {
        assert(mapping.targets.length === 1, `${mapping.sourceId} native input evidence currently requires one target`);
        assert(
          inputEvidence.target === `tools.${mapping.targets[0]}.input`,
          `${mapping.sourceId} input schema target is not bound to its native tool`
        );
      }
    }
  }

  const outputEvidence = dimensions.outputSchema;
  if (outputEvidence !== undefined) {
    assertString(outputEvidence.target, `${mapping.sourceId}.evidence.outputSchema.target`);
    if (mapping.status === "static_contract_resource") {
      assert(
        mapping.targets.includes(outputEvidence.target),
        `${mapping.sourceId} output evidence is not one of its static resource targets`
      );
      await resolveArtifactPointer(packageDirectory, outputEvidence.target);
    } else {
      resolveObjectPath(schema, outputEvidence.target, `${mapping.sourceId} output schema target`);
      if (mapping.status === "native_tool") {
        assert(mapping.targets.length === 1, `${mapping.sourceId} native output evidence currently requires one target`);
        assert(
          outputEvidence.target === `tools.${mapping.targets[0]}.output`,
          `${mapping.sourceId} output schema target is not bound to its native tool`
        );
      }
    }
  }

  const authenticationEvidence = dimensions.authentication;
  if (authenticationEvidence !== undefined) {
    assert(
      authenticationEvidence.mode === referenceEntry.authentication,
      `${mapping.sourceId} authentication evidence does not match upstream`
    );
    assert(
      authenticationEvidence.subject === expectedSubjectScope(referenceEntry),
      `${mapping.sourceId} authentication subject scope does not match upstream semantics`
    );
    if (mapping.status === "native_tool") {
      for (const target of mapping.targets) {
        const capability = capabilityByName(capabilities, target, mapping.sourceId);
        assert(
          capability.requiresAuth === (referenceEntry.authentication === "required"),
          `${mapping.sourceId} target authentication does not match upstream: ${target}`
        );
      }
    } else if (mapping.status === "static_contract_resource") {
      assert(referenceEntry.authentication === "public", `${mapping.sourceId} static resource cannot satisfy authenticated access`);
    }
  }

  const regionsEvidence = dimensions.regions;
  if (regionsEvidence !== undefined) {
    assertExactSet(regionsEvidence.values, referenceEntry.regions, `${mapping.sourceId}.evidence.regions.values`);
    assertObject(regionsEvidence.endpoints, `${mapping.sourceId}.evidence.regions.endpoints`);
    assertExactSet(
      Object.keys(regionsEvidence.endpoints),
      referenceEntry.regions,
      `${mapping.sourceId}.evidence.regions.endpoints regions`
    );
    for (const region of referenceEntry.regions) {
      const regionalEvidence = regionsEvidence.endpoints[region];
      assertObject(regionalEvidence, `${mapping.sourceId}.evidence.regions.endpoints.${region}`);
      assertString(regionalEvidence.endpoint, `${mapping.sourceId}.evidence.regions.endpoints.${region}.endpoint`);
      assertString(regionalEvidence.operation, `${mapping.sourceId}.evidence.regions.endpoints.${region}.operation`);
    }
    if (mapping.status !== "static_contract_resource") {
      assertUniqueStrings(
        regionsEvidence.implementationFiles,
        `${mapping.sourceId}.evidence.regions.implementationFiles`
      );
      if (requireTestFiles) {
        const implementationSources = [];
        for (const relativePath of regionsEvidence.implementationFiles) {
          assert(!relativePath.includes("\\"), `${mapping.sourceId} region implementation evidence must use portable paths`);
          const absolutePath = resolveInside(
            packageDirectory,
            relativePath,
            `${mapping.sourceId} region implementation evidence`
          );
          await access(absolutePath);
          implementationSources.push(await readFile(absolutePath, "utf8"));
        }
        const combinedSource = implementationSources.join("\n");
        for (const region of referenceEntry.regions) {
          const regionalEvidence = regionsEvidence.endpoints[region];
          assert(
            combinedSource.includes(regionalEvidence.endpoint),
            `${mapping.sourceId} endpoint is absent from implementation evidence: ${regionalEvidence.endpoint}`
          );
          assert(
            combinedSource.includes(regionalEvidence.operation),
            `${mapping.sourceId} operation is absent from implementation evidence: ${regionalEvidence.operation}`
          );
        }
      }
    }
    const targetRegions = inputSchema === undefined
      ? capabilities.supportedRegions
      : schemaAllowedRegions(inputSchema);
    assertUniqueStrings(targetRegions, `${mapping.sourceId} target regions`);
    for (const region of referenceEntry.regions) {
      assert(targetRegions.includes(region), `${mapping.sourceId} target does not support upstream region ${region}`);
    }
  }

  const capabilityEvidence = dimensions.capability;
  if (capabilityEvidence !== undefined) {
    assert(
      capabilityEvidence.consequence === referenceEntry.consequence,
      `${mapping.sourceId} consequence evidence does not match upstream`
    );
    assert(
      capabilityEvidence.sideEffect === expectedSideEffect(referenceEntry.consequence),
      `${mapping.sourceId} side-effect evidence does not match upstream consequence`
    );
    if (mapping.status === "native_tool") {
      for (const target of mapping.targets) {
        const capability = capabilityByName(capabilities, target, mapping.sourceId);
        assert(
          capability.consequence === referenceEntry.consequence,
          `${mapping.sourceId} target consequence does not match upstream: ${target}`
        );
      }
    }
  }

  const paginationEvidence = dimensions.paginationDefaults;
  if (paginationEvidence !== undefined) {
    assertString(paginationEvidence.mode, `${mapping.sourceId}.evidence.paginationDefaults.mode`);
    assertObject(paginationEvidence.defaults, `${mapping.sourceId}.evidence.paginationDefaults.defaults`);
    const paginationFields = referenceEntry.inputFields.filter((field) =>
      ["limit", "offset", "skip", "lastKey"].includes(field)
    );
    if (paginationFields.length === 0) {
      assert(paginationEvidence.mode === "none", `${mapping.sourceId} pagination mode must be none`);
      assert(
        Object.keys(paginationEvidence.defaults).length === 0,
        `${mapping.sourceId} non-paginated mapping must not declare pagination defaults`
      );
    } else {
      assert(paginationEvidence.mode !== "none", `${mapping.sourceId} must declare its pagination mode`);
    }
    for (const [sourceField, expectedDefault] of Object.entries(paginationEvidence.defaults)) {
      assert(
        referenceEntry.inputFields.includes(sourceField),
        `${mapping.sourceId} pagination default is not an upstream input field: ${sourceField}`
      );
      assertJsonScalar(expectedDefault, `${mapping.sourceId}.evidence.paginationDefaults.defaults.${sourceField}`);
      assert(inputEvidence !== undefined && inputSchema !== undefined, `${mapping.sourceId} pagination defaults require a target input schema`);
      const targetField = inputEvidence.fieldMap[sourceField];
      assertString(targetField, `${mapping.sourceId} pagination default target for ${sourceField}`);
      const targetProperties = jsonSchemaProperties(inputSchema, `${mapping.sourceId} pagination input schema`);
      const targetProperty = targetProperties[targetField];
      assertObject(targetProperty, `${mapping.sourceId} pagination target field ${targetField}`);
      assert(
        Object.prototype.hasOwnProperty.call(targetProperty, "default"),
        `${mapping.sourceId} pagination target field has no explicit default: ${targetField}`
      );
      assert(
        canonicalJson(targetProperty.default) === canonicalJson(expectedDefault),
        `${mapping.sourceId} pagination default differs for ${sourceField}`
      );
    }
  }

  const sensitiveDataEvidence = dimensions.sensitiveData;
  if (sensitiveDataEvidence !== undefined) {
    assert(
      sensitiveDataEvidence.classification === expectedSensitiveClassification(referenceEntry),
      `${mapping.sourceId} sensitive-data classification does not match upstream semantics`
    );
    assertUniqueStrings(
      sensitiveDataEvidence.controls,
      `${mapping.sourceId}.evidence.sensitiveData.controls`
    );
    if (sensitiveDataEvidence.classification === "source_code") {
      assert(inputSchema !== undefined, `${mapping.sourceId} source-code access requires a target input schema`);
      const properties = jsonSchemaProperties(inputSchema, `${mapping.sourceId} source-code input schema`);
      assertObject(properties.includeCode, `${mapping.sourceId} source-code includeCode control`);
      assert(properties.includeCode.default === false, `${mapping.sourceId} source code must be hidden by default`);
      assert(
        sensitiveDataEvidence.controls.includes("explicit-source-code-opt-in"),
        `${mapping.sourceId} source-code evidence must name the explicit opt-in control`
      );
    }
  }

  const errorEvidence = dimensions.errorSemantics;
  if (errorEvidence !== undefined) {
    const expectedMode = mapping.status === "static_contract_resource"
      ? "immutable_contract"
      : "normalized_tool_error";
    assert(errorEvidence.mode === expectedMode, `${mapping.sourceId} error-semantics mode is invalid`);
    assertUniqueStrings(errorEvidence.codes, `${mapping.sourceId}.evidence.errorSemantics.codes`);
    assertUniqueStrings(schema.errors, "contract error codes");
    for (const code of errorEvidence.codes) {
      assert(schema.errors.includes(code), `${mapping.sourceId} declares an unknown target error code: ${code}`);
    }
    const requiredCodes = mapping.status === "static_contract_resource"
      ? ["CONTRACT_MISMATCH"]
      : [
          "VALIDATION_ERROR",
          "REMOTE_UNAVAILABLE",
          "REMOTE_SCHEMA_CHANGED",
          ...(referenceEntry.authentication === "required" ? ["AUTH_REQUIRED", "AUTH_EXPIRED"] : [])
        ];
    for (const code of requiredCodes) {
      assert(errorEvidence.codes.includes(code), `${mapping.sourceId} error evidence is missing ${code}`);
    }
  }

  if (dimensions.tests !== undefined) {
    await validateTestEvidence(packageDirectory, mapping, dimensions.tests, requireTestFiles);
  }

  if (dimensions.documentation !== undefined) {
    assertUniqueStrings(
      dimensions.documentation.anchors,
      `${mapping.sourceId}.evidence.documentation.anchors`
    );
    for (const anchor of dimensions.documentation.anchors) {
      assertReadmeAnchor(readme, anchor, `${mapping.sourceId} README anchor ${anchor}`);
    }
  }
}

function validateUnsupportedApproval(mapping) {
  assertObject(mapping.approval, `${mapping.sourceId}.approval`);
  for (const field of ["decisionId", "reviewer", "approvedAt", "reason", "alternative"]) {
    assertString(mapping.approval[field], `${mapping.sourceId}.approval.${field}`);
  }
  assert(!Number.isNaN(Date.parse(mapping.approval.approvedAt)), `${mapping.sourceId}.approval.approvedAt is invalid`);
}

export async function verifyUpstreamParity(options = {}) {
  const packageDirectory = resolve(options.packageDirectory ?? DEFAULT_PACKAGE_DIRECTORY);
  const referenceTarball = resolve(options.referenceTarball ?? DEFAULT_REFERENCE_TARBALL);
  const queryTarball = resolve(options.queryTarball ?? DEFAULT_QUERY_TARBALL);
  const requireTestFiles = options.requireTestFiles ?? true;
  const reference = await readJson(resolve(packageDirectory, "upstream", "reference-surface.json"));
  const semanticSurface = await readJson(
    resolve(packageDirectory, "upstream", "reference-semantics.json")
  );
  const parity = await readJson(resolve(packageDirectory, "upstream", "parity.json"));
  const packageJson = await readJson(resolve(packageDirectory, "package.json"));
  const manifest = await readJson(resolve(packageDirectory, "contract", "manifest.json"));
  const schema = await readJson(resolve(packageDirectory, "contract", "schema.json"));
  const capabilities = await readJson(resolve(packageDirectory, "contract", "capabilities.json"));
  const readme = await readFile(resolve(packageDirectory, "README.md"), "utf8");

  const { interfaceIds, computedInventoryDigest } = validateReference(reference);
  const archiveInventory = await validateReferenceArchive(reference, referenceTarball);
  const queryReference = await extractLeetCodeQueryReference(queryTarball);
  const semanticIdentity = validateSemanticSurface(
    semanticSurface,
    reference,
    archiveInventory,
    queryReference
  );
  assertObject(parity, "parity map");
  assert(parity.schemaVersion === 2, "parity schemaVersion must be 2");
  assert(parity.mappingType === "reference-mcp-parity", "parity mappingType is invalid");
  assertObject(parity.reference, "parity reference");
  assert(parity.reference.package === reference.source.package, "parity reference package is stale");
  assert(parity.reference.version === reference.source.version, "parity reference version is stale");
  assert(parity.reference.researchCommit === reference.source.researchCommit, "parity reference commit is stale");
  assert(parity.reference.inventoryDigest === computedInventoryDigest, "parity reference inventoryDigest is stale");
  assert(
    parity.reference.semanticSurfaceDigest ===
      semanticIdentity.semanticSurfaceDigest,
    "parity reference semanticSurfaceDigest is stale"
  );
  assertObject(parity.reference.queryDependency, "parity query dependency");
  assert(
    canonicalJson(parity.reference.queryDependency) ===
      canonicalJson({
        package: semanticIdentity.queryDependency.package,
        version: semanticIdentity.queryDependency.version,
        tarballSha256: semanticIdentity.queryDependency.tarball.sha256,
        graphqlCatalogDigest:
          semanticIdentity.queryDependency.graphqlCatalogDigest
      }),
    "parity query dependency binding is stale"
  );
  validateTargetBinding(parity, packageJson, manifest);

  assert(Array.isArray(parity.mappings), "parity mappings must be an array");
  assert(parity.mappings.length === EXPECTED_REFERENCE.total, "parity mappings must contain exactly 24 entries");
  const sourceIds = parity.mappings.map((mapping) => mapping?.sourceId);
  assertExactSet(sourceIds, interfaceIds, "parity source IDs");
  const referenceById = new Map(reference.interfaces.map((entry) => [entry.id, entry]));

  const report = {
    reference: `${reference.source.package}@${reference.source.version}`,
    researchCommit: reference.source.researchCommit,
    inventoryDigest: computedInventoryDigest,
    semanticSurfaceDigest: semanticIdentity.semanticSurfaceDigest,
    target: `${packageJson.name}@${packageJson.version}`,
    targetIdentity: { ...parity.target },
    contractVersion: manifest.contractVersion,
    totalUpstream: EXPECTED_REFERENCE.total,
    tools: EXPECTED_REFERENCE.tools,
    resources: EXPECTED_REFERENCE.resources,
    archive: {
      path: referenceTarball,
      sha256: archiveInventory.sha256,
      sizeBytes: archiveInventory.sizeBytes,
      toolRegistrations: archiveInventory.surface.counts.toolRegistrations,
      resourceRegistrations: archiveInventory.surface.counts.resourceRegistrations
    },
    queryDependency: {
      package: semanticIdentity.queryDependency.package,
      version: semanticIdentity.queryDependency.version,
      archivePath: queryTarball,
      sha256: semanticIdentity.queryDependency.tarball.sha256,
      sizeBytes: semanticIdentity.queryDependency.tarball.sizeBytes,
      librarySha256: semanticIdentity.queryDependency.library.sha256,
      graphqlQueryCount: semanticIdentity.queryDependency.graphqlQueryCount,
      graphqlCatalogDigest:
        semanticIdentity.queryDependency.graphqlCatalogDigest
    },
    coveredNative: 0,
    coveredGateway: 0,
    coveredStatic: 0,
    approvedUnsupported: 0,
    missing: 0,
    partial: 0,
    superseded: 0,
    partialCandidates: 0,
    missingIds: [],
    partialIds: [],
    supersededIds: [],
    fullyVerified: 0,
    implemented: 0,
    strictBlockers: [],
    dimensions: {
      semantic: [...SEMANTIC_DIMENSIONS],
      evidenceReferences: [...EVIDENCE_REFERENCE_DIMENSIONS]
    },
    checks: {
      interfaceInventory: {
        status: "pass",
        declared: interfaceIds.length,
        extracted: archiveInventory.surface.counts.total,
        tools: archiveInventory.surface.counts.tools,
        resources: archiveInventory.surface.counts.resources
      },
      mappingCoverage: {
        status: "pass",
        declared: parity.mappings.length,
        unique: new Set(sourceIds).size
      },
      mappingStatus: {
        implemented: 0,
        missing: 0,
        partial: 0,
        superseded: 0,
        unsupported: 0
      },
      ...Object.fromEntries(
        EVIDENCE_DIMENSIONS.map((dimension) => [dimension, { verified: 0, blockers: [] }])
      )
    },
    complete: false
  };

  for (const [index, mapping] of parity.mappings.entries()) {
    const label = `parity.mappings[${index}]`;
    assertObject(mapping, label);
    assertString(mapping.sourceId, `${label}.sourceId`);
    assert(ALLOWED_STATUSES.has(mapping.status), `${mapping.sourceId}.status is invalid`);
    const referenceEntry = referenceById.get(mapping.sourceId);
    assert(referenceEntry !== undefined, `${mapping.sourceId} does not exist in the reference inventory`);

    if (mapping.partialTargets !== undefined) {
      assertUniqueStrings(mapping.partialTargets, `${mapping.sourceId}.partialTargets`);
    }

    if (INCOMPLETE_STATUSES.has(mapping.status)) {
      assertString(mapping.reason, `${mapping.sourceId}.reason`);
      if (mapping.status === "missing") {
        assertUniqueStrings(mapping.plannedTargets, `${mapping.sourceId}.plannedTargets`);
        assert(mapping.targets === undefined, `${mapping.sourceId} must not declare covered targets while missing`);
        report.missing += 1;
        report.missingIds.push(mapping.sourceId);
      } else if (mapping.status === "partial") {
        assertUniqueStrings(mapping.partialTargets, `${mapping.sourceId}.partialTargets`);
        assert(mapping.targets === undefined, `${mapping.sourceId} must not declare covered targets while partial`);
        report.partial += 1;
        report.partialIds.push(mapping.sourceId);
      } else {
        assertUniqueStrings(mapping.supersededBy, `${mapping.sourceId}.supersededBy`);
        assert(mapping.targets === undefined, `${mapping.sourceId} must not declare covered targets while superseded`);
        report.superseded += 1;
        report.supersededIds.push(mapping.sourceId);
      }
      if (Array.isArray(mapping.partialTargets) && mapping.partialTargets.length > 0) {
        report.partialCandidates += 1;
      }
      report.checks.mappingStatus[mapping.status] += 1;
      report.strictBlockers.push({
        sourceId: mapping.sourceId,
        dimension: "mappingStatus",
        status: mapping.status
      });
      for (const dimension of EVIDENCE_DIMENSIONS) {
        report.checks[dimension].blockers.push({ sourceId: mapping.sourceId, status: mapping.status });
      }
      continue;
    }

    if (mapping.status === "explicitly_unsupported") {
      validateUnsupportedApproval(mapping);
      assert(mapping.targets === undefined, `${mapping.sourceId} unsupported mapping must not declare targets`);
      report.approvedUnsupported += 1;
      report.checks.mappingStatus.unsupported += 1;
      report.strictBlockers.push({
        sourceId: mapping.sourceId,
        dimension: "mappingStatus",
        status: "unsupported"
      });
      for (const dimension of EVIDENCE_DIMENSIONS) {
        report.checks[dimension].blockers.push({ sourceId: mapping.sourceId, status: "unsupported" });
      }
      continue;
    }

    assertUniqueStrings(mapping.targets, `${mapping.sourceId}.targets`);

    if (mapping.status === "native_tool") {
      for (const target of mapping.targets) {
        assert(manifest.tools.includes(target), `${mapping.sourceId} target is not a contract tool: ${target}`);
      }
      report.coveredNative += 1;
    } else if (mapping.status === "gateway_capability") {
      for (const target of mapping.targets) {
        assert(target.startsWith("gateway:"), `${mapping.sourceId} gateway target must start with gateway:`);
        resolveObjectPath(schema, target.slice("gateway:".length), `${mapping.sourceId} gateway target`);
      }
      report.coveredGateway += 1;
    } else if (mapping.status === "static_contract_resource") {
      for (const target of mapping.targets) {
        await resolveArtifactPointer(packageDirectory, target);
      }
      report.coveredStatic += 1;
    }

    report.checks.mappingStatus.implemented += 1;
    const blockerStart = report.strictBlockers.length;
    await validateImplementedEvidence({
      packageDirectory,
      mapping,
      referenceEntry,
      schema,
      capabilities,
      readme,
      requireTestFiles,
      blockers: report.strictBlockers
    });
    for (const dimension of EVIDENCE_DIMENSIONS) {
      const status = mapping.evidence[dimension].status;
      if (status === "verified") report.checks[dimension].verified += 1;
      else report.checks[dimension].blockers.push({ sourceId: mapping.sourceId, status });
    }
    if (report.strictBlockers.length === blockerStart) report.fullyVerified += 1;
  }

  const accountedFor =
    report.coveredNative +
    report.coveredGateway +
    report.coveredStatic +
    report.approvedUnsupported +
    report.missing +
    report.partial +
    report.superseded;
  assert(accountedFor === report.totalUpstream, "parity coverage does not account for all upstream interfaces");
  report.complete =
    report.fullyVerified === report.totalUpstream && report.strictBlockers.length === 0;
  report.implemented = report.fullyVerified;
  return report;
}

function parseArguments(argv) {
  const options = {
    packageDirectory: DEFAULT_PACKAGE_DIRECTORY,
    referenceTarball: DEFAULT_REFERENCE_TARBALL,
    queryTarball: DEFAULT_QUERY_TARBALL,
    requireComplete: false,
    requireTestFiles: true,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-complete") options.requireComplete = true;
    else if (argument === "--skip-test-files") options.requireTestFiles = false;
    else if (argument === "--json") options.json = true;
    else if (argument === "--reference-tarball") {
      index += 1;
      assert(index < argv.length, "--reference-tarball requires a path");
      options.referenceTarball = resolve(argv[index]);
    }
    else if (argument === "--query-tarball") {
      index += 1;
      assert(index < argv.length, "--query-tarball requires a path");
      options.queryTarball = resolve(argv[index]);
    }
    else if (argument === "--package-root") {
      index += 1;
      assert(index < argv.length, "--package-root requires a path");
      options.packageDirectory = resolve(argv[index]);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  assert(
    !(options.requireComplete && !options.requireTestFiles),
    "Strict upstream parity cannot skip test-evidence files"
  );
  return options;
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Upstream parity: ${report.fullyVerified}/${report.totalUpstream} fully verified`);
  console.log(`Native ${report.coveredNative}, Gateway ${report.coveredGateway}, Static ${report.coveredStatic}, Unsupported ${report.approvedUnsupported}, Missing ${report.missing}, Partial ${report.partial}, Superseded ${report.superseded}`);
  console.log(`Pinned archive inventory: ${report.archive.sha256}, ${report.tools} tools, ${report.resources} resources`);
  if (report.missing > 0) {
    console.log(`Missing: ${report.missingIds.join(", ")}`);
  }
  if (report.strictBlockers.length > 0) {
    console.log(`Strict blockers: ${report.strictBlockers.length}`);
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await verifyUpstreamParity(options);
    printReport(report, options.json);
    if (options.requireComplete && !report.complete) {
      throw new Error(
        `Upstream parity is incomplete: ${report.fullyVerified} of ${report.totalUpstream} interfaces are fully verified; ${report.strictBlockers.length} strict blockers remain`
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
