import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assert,
  canonicalJson,
  PACKAGE_DIRECTORY,
  readJson,
  REPOSITORY_ROOT,
  resolveInside,
  sha256Bytes,
  sha256Jcs
} from "./release-utils.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_BINDINGS_PATH = join(
  PACKAGE_DIRECTORY,
  "upstream",
  "semantic-case-bindings.json"
);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXPECTED_BINDING_DIGEST =
  "sha256:f5d37da80251b2cc5fc3272b4afd6cf1dcc7b7649a258cbc6eb8813efb43c900";
const RECEIPT_MODES = new Set(["source", "packed"]);
const IMPLEMENTED_STATUSES = new Set([
  "native_tool",
  "gateway_capability",
  "static_contract_resource"
]);
const EXPECTED_DIMENSIONS = Object.freeze([
  "input_contract",
  "output_contract",
  "auth_subject_scope",
  "region_endpoint",
  "pagination_defaults_filters",
  "capability_side_effect",
  "sensitive_data",
  "error_semantics"
]);

function assertObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`
  );
}

function assertString(value, label) {
  assert(
    typeof value === "string" && value.trim().length > 0,
    `${label} must be a non-empty string`
  );
}

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(allowEmpty || value.length > 0, `${label} must not be empty`);
  for (const [index, item] of value.entries()) {
    assertString(item, `${label}[${index}]`);
  }
  assert(new Set(value).size === value.length, `${label} contains duplicates`);
}

function assertExactSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(
    new Set(actual).size === actual.length,
    `${label} contains duplicate values`
  );
  assert(
    canonicalJson([...actual].sort()) === canonicalJson([...expected].sort()),
    `${label} does not match the required semantic case set`
  );
}

function normalizeEndpoint(value) {
  try {
    const url = new URL(value);
    const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/u, "");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return value.replace(/\/+$/u, "");
  }
}

function endpointTokens(value) {
  try {
    const url = new URL(value);
    return [
      url.host,
      ...url.pathname
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .filter((segment) => segment.length > 2 && !segment.startsWith("{"))
    ];
  } catch {
    return value.split(/[^A-Za-z0-9_.-]+/u).filter((token) => token.length > 2);
  }
}

function operationTokens(value) {
  const ignored = new Set(["POST", "GET", "then", "read"]);
  return (value.match(/[A-Za-z_][A-Za-z0-9_-]*/gu) ?? []).filter(
    (token) => !ignored.has(token)
  );
}

function resolveObjectPath(root, dottedPath, label) {
  assertString(dottedPath, label);
  let current = root;
  for (const segment of dottedPath.split(".")) {
    assertObject(current, `${label} parent`);
    assert(
      Object.prototype.hasOwnProperty.call(current, segment),
      `${label} does not exist: ${dottedPath}`
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
  assert(hash > 0, `Static semantic target is invalid: ${target}`);
  const document = await readJson(
    resolveInside(packageDirectory, target.slice(0, hash), "Static semantic target")
  );
  const pointer = target.slice(hash + 1);
  let current = document;
  if (pointer !== "") {
    assert(pointer.startsWith("/"), `Static target pointer is invalid: ${target}`);
    for (const rawSegment of pointer.slice(1).split("/")) {
      const segment = decodePointer(rawSegment);
      assert(
        current !== null && typeof current === "object",
        `Static target is not traversable: ${target}`
      );
      assert(
        Object.prototype.hasOwnProperty.call(current, segment),
        `Static target does not exist: ${target}`
      );
      current = current[segment];
    }
  }
  return current;
}

function expandSchemaNodes(nodes) {
  const expanded = [];
  const seen = new Set();
  function visit(node) {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    expanded.push(node);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(node[key])) {
        for (const child of node[key]) visit(child);
      }
    }
  }
  for (const node of nodes) visit(node);
  return expanded;
}

function schemaNodesAtPath(schema, dottedPath) {
  let nodes = [schema];
  for (const rawSegment of dottedPath.split(".")) {
    const arraySegment = rawSegment.endsWith("[]");
    const segment = arraySegment ? rawSegment.slice(0, -2) : rawSegment;
    const next = [];
    for (const node of expandSchemaNodes(nodes)) {
      const property = node?.properties?.[segment];
      if (property !== undefined) {
        if (arraySegment) {
          if (property.items !== undefined) next.push(property.items);
        } else {
          next.push(property);
        }
      }
    }
    nodes = next;
    if (nodes.length === 0) return [];
  }
  return expandSchemaNodes(nodes);
}

function schemaProperties(schema, label) {
  const candidates = expandSchemaNodes([schema]).filter(
    (node) => node.properties !== undefined
  );
  assert(candidates.length > 0, `${label} has no object properties`);
  const properties = {};
  for (const candidate of candidates) Object.assign(properties, candidate.properties);
  return properties;
}

function schemaRequiredFields(schema) {
  const fields = new Set();
  for (const node of expandSchemaNodes([schema])) {
    for (const field of node.required ?? []) fields.add(field);
  }
  return fields;
}

function schemaRegionValues(schema) {
  const region = schemaProperties(schema, "input schema").region;
  if (region === undefined) return [];
  const values = new Set();
  for (const node of expandSchemaNodes([region])) {
    if (typeof node.const === "string") values.add(node.const);
    for (const value of node.enum ?? []) {
      if (typeof value === "string") values.add(value);
    }
  }
  return [...values].sort();
}

function sourceFields(inputContract, variant) {
  const required = Array.isArray(inputContract.required)
    ? inputContract.required
    : inputContract.requiredByVariant?.[variant.id] ?? [];
  return {
    required,
    optional: inputContract.optional ?? [],
    defaults: { ...(inputContract.defaults ?? {}), ...(variant.defaults ?? {}) }
  };
}

function allSourceFields(inputContract) {
  return [
    ...(inputContract.required ?? []),
    ...Object.values(inputContract.requiredByVariant ?? {}).flat(),
    ...(inputContract.optional ?? [])
  ];
}

function expectedSubject(referenceEntry) {
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

function capabilityByName(capabilities, name, sourceId) {
  const matches = capabilities.tools.filter((entry) => entry?.name === name);
  assert(matches.length === 1, `${sourceId} has no unique capability for ${name}`);
  return matches[0];
}

function gatewayConsequence(target) {
  if (target === "gateway:user.status") return "read";
  if (["gateway:notes.search", "gateway:notes.get"].includes(target)) {
    return "sensitive_read";
  }
  if (["gateway:notes.create", "gateway:notes.update"].includes(target)) {
    return "external_write";
  }
  throw new Error(`Unbound gateway consequence: ${target}`);
}

function targetCodePath(mode, implementationPath) {
  if (mode === "source") return implementationPath;
  assert(
    implementationPath.startsWith("src/") && extname(implementationPath) === ".ts",
    `Packed implementation binding must originate from src/*.ts: ${implementationPath}`
  );
  return `dist/${implementationPath.slice(0, -3)}.js`;
}

async function readImplementationSources(packageDirectory, mode, mapping) {
  if (mapping.status === "static_contract_resource") {
    return { files: [], text: "", digests: [] };
  }
  const files = mapping.evidence.regions.implementationFiles.map((path) =>
    targetCodePath(mode, path)
  );
  const chunks = [];
  const digests = [];
  for (const path of files) {
    const absolutePath = resolveInside(
      packageDirectory,
      path,
      `${mapping.sourceId} ${mode} implementation`
    );
    const bytes = await readFile(absolutePath);
    chunks.push(bytes.toString("utf8"));
    digests.push({ path, digest: sha256Bytes(bytes) });
  }
  return { files, text: chunks.join("\n"), digests };
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

async function loadContractModule(packageDirectory, cacheKey) {
  await makeContractDependencyVisible(packageDirectory);
  const path = join(packageDirectory, "dist", "src", "tool-calls", "contract.js");
  await access(path);
  return import(
    `${pathToFileURL(path).href}?semanticReceipt=${encodeURIComponent(cacheKey)}`
  );
}

async function loadSecurityCode(packageDirectory, mode) {
  const sourcePaths = [
    "src/runtime/redaction.ts",
    "src/runtime/logger.ts",
    "src/tool-calls/gateway.ts",
    "src/leetcode/adapters/read-normalization.ts"
  ];
  const paths = sourcePaths.map((path) => targetCodePath(mode, path));
  const chunks = [];
  const digests = [];
  for (const path of paths) {
    const bytes = await readFile(resolveInside(packageDirectory, path, "Security implementation"));
    chunks.push(bytes.toString("utf8"));
    digests.push({ path, digest: sha256Bytes(bytes) });
  }
  return { text: chunks.join("\n"), digests };
}

export function validateSemanticBindings(
  bindings,
  surface,
  { requirePinnedDigest = false } = {}
) {
  assertObject(bindings, "semantic case bindings");
  assert(bindings.schemaVersion === 1, "semantic case bindings schemaVersion must be 1");
  assert(
    bindings.bindingType === "upstream-semantic-case-bindings",
    "semantic case bindings type is invalid"
  );
  assertExactSet(
    bindings.semanticDimensions,
    EXPECTED_DIMENSIONS,
    "semantic binding dimensions"
  );
  assert(
    bindings.semanticSurfaceDigest === surface.semanticSurfaceDigest,
    "semantic case bindings are stale for reference-semantics.json"
  );
  if (requirePinnedDigest) {
    assert(
      sha256Jcs(bindings) === EXPECTED_BINDING_DIGEST,
      "semantic case binding digest is not pinned by the execution runner"
    );
  }
  assert(Array.isArray(bindings.interfaces), "semantic bindings interfaces must be an array");
  assertExactSet(
    bindings.interfaces.map((entry) => entry?.sourceId),
    surface.interfaces.map((entry) => entry.sourceId),
    "semantic binding source IDs"
  );
  const byId = new Map();
  for (const entry of bindings.interfaces) {
    assertObject(entry, `${entry?.sourceId ?? "unknown"} binding`);
    assertString(entry.sourceId, "semantic binding sourceId");
    assert(Array.isArray(entry.outputPathGroups), `${entry.sourceId}.outputPathGroups must be an array`);
    for (const [index, group] of entry.outputPathGroups.entries()) {
      assertStringArray(group, `${entry.sourceId}.outputPathGroups[${index}]`);
    }
    if (entry.staticValueDigest !== undefined) {
      assert(
        DIGEST_PATTERN.test(entry.staticValueDigest),
        `${entry.sourceId}.staticValueDigest is invalid`
      );
    }
    if (entry.defaultBindings !== undefined) {
      assertObject(entry.defaultBindings, `${entry.sourceId}.defaultBindings`);
      for (const [variantId, fields] of Object.entries(entry.defaultBindings)) {
        assertString(variantId, `${entry.sourceId}.defaultBindings variant`);
        assertObject(fields, `${entry.sourceId}.defaultBindings.${variantId}`);
        for (const [field, target] of Object.entries(fields)) {
          assertString(field, `${entry.sourceId}.defaultBindings.${variantId} field`);
          assertString(target, `${entry.sourceId}.defaultBindings.${variantId}.${field}`);
        }
      }
    }
    byId.set(entry.sourceId, entry);
  }
  return { document: bindings, byId };
}

async function loadBindings(bindingsPath, surface) {
  return validateSemanticBindings(await readJson(bindingsPath), surface, {
    requirePinnedDigest: true
  });
}

async function loadSubject({ packageDirectory, mode, parityReport, bindingsPath }) {
  assert(RECEIPT_MODES.has(mode), `Unsupported semantic receipt mode: ${mode}`);
  const [surface, reference, parity, schema, manifest, capabilities, catalogs] =
    await Promise.all([
      readJson(join(packageDirectory, "upstream", "reference-semantics.json")),
      readJson(join(packageDirectory, "upstream", "reference-surface.json")),
      readJson(join(packageDirectory, "upstream", "parity.json")),
      readJson(join(packageDirectory, "contract", "schema.json")),
      readJson(join(packageDirectory, "contract", "manifest.json")),
      readJson(join(packageDirectory, "contract", "capabilities.json")),
      readJson(join(packageDirectory, "contract", "catalogs.json"))
    ]);
  const resolvedBindingsPath = bindingsPath ?? join(
    packageDirectory,
    "upstream",
    "semantic-case-bindings.json"
  );
  const bindings = await loadBindings(resolvedBindingsPath, surface);
  const contractModule = await loadContractModule(
    packageDirectory,
    `${mode}-${parityReport.targetIdentity.schemaDigest}`
  );
  assert(
    canonicalJson(contractModule.TOOL_CONTRACT_DOCUMENT) === canonicalJson(schema),
    `${mode} JavaScript contract does not match contract/schema.json`
  );
  assert(
    canonicalJson(contractModule.BEHAVIOR_MANIFEST) ===
      canonicalJson(manifest.behaviorManifest),
    `${mode} JavaScript behavior manifest does not match contract/manifest.json`
  );
  assert(
    canonicalJson([...contractModule.TOOL_ERROR_CODES]) === canonicalJson(schema.errors),
    `${mode} JavaScript error codes do not match contract/schema.json`
  );
  assert(
    canonicalJson([...contractModule.TOOL_NAMES].sort()) ===
      canonicalJson([...manifest.tools].sort()),
    `${mode} JavaScript tool registry does not match contract/manifest.json`
  );
  const contractCodePath =
    mode === "source"
      ? join(packageDirectory, "src", "tool-calls", "contract.ts")
      : join(packageDirectory, "dist", "src", "tool-calls", "contract.js");
  const contractCode = await readFile(contractCodePath);
  const securityCode = await loadSecurityCode(packageDirectory, mode);
  return {
    packageDirectory,
    mode,
    surface,
    reference,
    parity,
    schema,
    manifest,
    capabilities,
    catalogs,
    contractModule,
    contractCodeText: contractCode.toString("utf8"),
    contractCodeDigest: sha256Bytes(contractCode),
    securityCode,
    bindings
  };
}

function makeCase(caseId) {
  let assertionCount = 0;
  const facts = [];
  return {
    check(condition, message, fact) {
      assertionCount += 1;
      assert(condition, `${caseId}: ${message}`);
      if (fact !== undefined) facts.push(fact);
    },
    finish() {
      assert(assertionCount > 0, `${caseId}: no assertions executed`);
      return {
        caseId,
        status: "passed",
        assertionCount,
        evidenceDigest: sha256Jcs({ caseId, facts })
      };
    }
  };
}

function mappingInputSchema(subject, mapping) {
  const target = mapping.evidence.inputSchema.target;
  if (target === "none") return undefined;
  return resolveObjectPath(subject.schema, target, `${mapping.sourceId} input target`);
}

async function mappingOutputSubject(subject, mapping) {
  const target = mapping.evidence.outputSchema.target;
  if (mapping.status === "static_contract_resource") {
    return { target, value: await resolveArtifactPointer(subject.packageDirectory, target) };
  }
  return {
    target,
    schema: resolveObjectPath(subject.schema, target, `${mapping.sourceId} output target`)
  };
}

function compareDefault(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

function resolvedDefault({ subject, binding, variant, field, property }) {
  if (property !== undefined && Object.prototype.hasOwnProperty.call(property, "default")) {
    return { source: "generated-schema", value: property.default };
  }
  const target = binding.defaultBindings?.[variant.id]?.[field];
  if (target === undefined) return undefined;
  return {
    source: target,
    value: resolveObjectPath(subject, target, `${binding.sourceId} default binding`)
  };
}

function assertInputCase({ caseState, subject, mapping, semanticEntry, variant, binding }) {
  const evidence = mapping.evidence.inputSchema;
  const inputSchema = mappingInputSchema(subject, mapping);
  const fields = sourceFields(semanticEntry.inputContract, variant);
  const allFields = [...new Set(allSourceFields(semanticEntry.inputContract))].sort();
  caseState.check(evidence.status === "verified", "input evidence is not verified");
  caseState.check(
    canonicalJson(Object.keys(evidence.fieldMap).sort()) === canonicalJson(allFields),
    "input field map does not bind the semantic input contract",
    { fieldMap: evidence.fieldMap }
  );
  if (inputSchema === undefined) {
    caseState.check(allFields.length === 0, "static target omits a non-empty input contract");
    return;
  }
  const properties = schemaProperties(inputSchema, `${mapping.sourceId} input schema`);
  const required = schemaRequiredFields(inputSchema);
  for (const field of allFields) {
    const targetField = evidence.fieldMap[field];
    caseState.check(
      typeof targetField === "string" && properties[targetField] !== undefined,
      `input field ${field} is not present in the generated schema`,
      { sourceField: field, targetField }
    );
  }
  for (const field of fields.required) {
    const targetField = evidence.fieldMap[field];
    caseState.check(
      required.has(targetField),
      `required field ${field} is not required by the generated schema`,
      { requiredField: field, targetField }
    );
  }
  for (const [field, expected] of Object.entries(fields.defaults)) {
    const targetField = evidence.fieldMap[field];
    caseState.check(
      typeof targetField === "string",
      `defaulted field ${field} has no field mapping`
    );
    const property = properties[targetField];
    const actualDefault = resolvedDefault({
      subject,
      binding,
      variant,
      field,
      property
    });
    caseState.check(
      actualDefault !== undefined,
      `defaulted field ${field} has no generated schema or behavior binding`
    );
    caseState.check(
      compareDefault(actualDefault.value, expected),
      `default for ${field} differs from the ${variant.id} reference behavior`,
      {
        sourceField: field,
        targetField,
        defaultSource: actualDefault.source,
        actual: actualDefault.value,
        expected
      }
    );
  }
}

async function assertOutputCase({ caseState, subject, mapping, binding }) {
  const output = await mappingOutputSubject(subject, mapping);
  caseState.check(
    mapping.evidence.outputSchema.status === "verified",
    "output evidence is not verified"
  );
  caseState.check(
    output.target === mapping.evidence.outputSchema.target,
    "resolved output target changed",
    { target: output.target }
  );
  if (output.value !== undefined) {
    caseState.check(
      binding.staticValueDigest !== undefined,
      "static output has no pinned value digest"
    );
    caseState.check(
      sha256Jcs(output.value) === binding.staticValueDigest,
      "static output value differs from the pinned semantic value",
      { valueDigest: sha256Jcs(output.value) }
    );
    return;
  }
  caseState.check(
    binding.outputPathGroups.length > 0,
    "output schema has no key-field bindings"
  );
  for (const alternatives of binding.outputPathGroups) {
    const matched = alternatives.find(
      (path) => schemaNodesAtPath(output.schema, path).length > 0
    );
    caseState.check(
      matched !== undefined,
      `output schema is missing key-field group: ${alternatives.join(" | ")}`,
      { alternatives, matched }
    );
  }
}

function assertAuthCase({ caseState, subject, mapping, referenceEntry, variant, inputSchema, implementation }) {
  const evidence = mapping.evidence.authentication;
  const expected = expectedSubject(referenceEntry);
  caseState.check(variant.auth === referenceEntry.authentication, "variant auth differs from inventory auth");
  caseState.check(evidence.mode === variant.auth, "target auth mode differs from reference", {
    mode: evidence.mode
  });
  caseState.check(evidence.subject === expected, "target auth subject differs from reference", {
    subject: evidence.subject
  });
  if (mapping.status === "native_tool") {
    const capability = capabilityByName(subject.capabilities, mapping.targets[0], mapping.sourceId);
    caseState.check(
      capability.requiresAuth === (variant.auth === "required"),
      "native capability auth flag differs from reference",
      { requiresAuth: capability.requiresAuth }
    );
  } else if (mapping.status === "gateway_capability") {
    caseState.check(
      inputSchema !== undefined,
      "gateway auth subject has no generated input schema"
    );
    if (variant.auth === "required") {
      caseState.check(
        /credential|csrf|authenticated|profileId|cookie/iu.test(implementation.text),
        "authenticated gateway implementation has no credential subject binding"
      );
    }
  } else {
    caseState.check(variant.auth === "public", "static resource cannot bind authenticated semantics");
  }
  if (expected === "arbitrary_user") {
    const usernameField = mapping.evidence.inputSchema.fieldMap.username;
    caseState.check(
      inputSchema !== undefined && schemaProperties(inputSchema, "arbitrary-user input")[usernameField] !== undefined,
      "arbitrary-user subject has no username input"
    );
  }
}

function assertRegionCase({ caseState, subject, mapping, semanticEntry, variant, inputSchema, implementation }) {
  const evidence = mapping.evidence.regions;
  const regional = evidence.endpoints[variant.region];
  caseState.check(evidence.status === "verified", "region evidence is not verified");
  caseState.check(
    evidence.values.includes(variant.region),
    `target omits ${variant.region} region`
  );
  caseState.check(regional !== undefined, `target has no ${variant.region} endpoint binding`);
  if (mapping.status === "static_contract_resource") {
    caseState.check(
      regional.endpoint.startsWith("contract/"),
      "static resource endpoint is not a packaged contract artifact",
      { endpoint: regional.endpoint, operation: regional.operation }
    );
    return;
  }
  caseState.check(
    normalizeEndpoint(regional.endpoint) === normalizeEndpoint(variant.endpoint),
    "implemented endpoint differs from the pinned regional endpoint",
    { endpoint: regional.endpoint, referenceEndpoint: variant.endpoint }
  );
  const supportedRegions = schemaRegionValues(inputSchema);
  caseState.check(
    supportedRegions.includes(variant.region),
    `generated input schema omits ${variant.region}`,
    { supportedRegions }
  );
  for (const token of endpointTokens(regional.endpoint)) {
    caseState.check(
      implementation.text.includes(token),
      `implementation does not contain endpoint token ${token}`
    );
  }
  for (const token of operationTokens(variant.operation)) {
    caseState.check(
      implementation.text.toLowerCase().includes(token.toLowerCase()),
      `implementation does not contain reference operation token ${token}`
    );
  }
  for (const token of operationTokens(regional.operation)) {
    caseState.check(
      implementation.text.toLowerCase().includes(token.toLowerCase()),
      `implementation does not contain mapped operation token ${token}`
    );
  }
  caseState.check(
    semanticEntry.variants.some((entry) => entry.id === variant.id),
    "variant is not bound to the semantic interface"
  );
}

function assertPaginationCase({
  caseState,
  subject,
  mapping,
  semanticEntry,
  variant,
  inputSchema,
  binding
}) {
  const evidence = mapping.evidence.paginationDefaults;
  const fields = sourceFields(semanticEntry.inputContract, variant);
  const paginationFields = ["limit", "offset", "skip", "lastKey"].filter((field) =>
    [...fields.required, ...fields.optional].includes(field)
  );
  caseState.check(evidence.status === "verified", "pagination evidence is not verified");
  caseState.check(
    paginationFields.length === 0 ? evidence.mode === "none" : evidence.mode !== "none",
    "pagination mode does not match the semantic input fields",
    { mode: evidence.mode, paginationFields }
  );
  if (inputSchema === undefined) {
    caseState.check(paginationFields.length === 0, "static target cannot implement pagination");
    return;
  }
  const properties = schemaProperties(inputSchema, `${mapping.sourceId} pagination input`);
  for (const field of [...fields.required, ...fields.optional]) {
    const targetField = mapping.evidence.inputSchema.fieldMap[field];
    caseState.check(
      properties[targetField] !== undefined,
      `filter or pagination field ${field} is absent from generated schema`,
      { field, targetField }
    );
  }
  for (const [field, expected] of Object.entries(fields.defaults)) {
    const targetField = mapping.evidence.inputSchema.fieldMap[field];
    const property = properties[targetField];
    const actualDefault = resolvedDefault({
      subject,
      binding,
      variant,
      field,
      property
    });
    caseState.check(
      actualDefault !== undefined,
      `defaulted filter ${field} has no schema or behavior default`
    );
    caseState.check(
      compareDefault(actualDefault.value, expected),
      `defaulted filter ${field} differs from reference`,
      { field, defaultSource: actualDefault.source, actual: actualDefault.value, expected }
    );
  }
  for (const [field, expected] of Object.entries(evidence.defaults)) {
    caseState.check(
      compareDefault(fields.defaults[field], expected),
      `declared pagination default for ${field} differs from reference`,
      { field, declared: expected, reference: fields.defaults[field] }
    );
  }
}

function assertCapabilityCase({ caseState, subject, mapping, referenceEntry, implementation }) {
  const evidence = mapping.evidence.capability;
  const expectedEffect = expectedSideEffect(referenceEntry.consequence);
  caseState.check(evidence.status === "verified", "capability evidence is not verified");
  caseState.check(
    evidence.consequence === referenceEntry.consequence,
    "capability consequence differs from reference",
    { consequence: evidence.consequence }
  );
  caseState.check(
    evidence.sideEffect === expectedEffect,
    "capability side effect differs from reference",
    { sideEffect: evidence.sideEffect }
  );
  if (mapping.status === "native_tool") {
    const capability = capabilityByName(subject.capabilities, mapping.targets[0], mapping.sourceId);
    caseState.check(
      capability.consequence === referenceEntry.consequence,
      "generated native capability consequence differs from reference"
    );
  } else if (mapping.status === "gateway_capability") {
    caseState.check(
      gatewayConsequence(mapping.targets[0]) === referenceEntry.consequence,
      "gateway target is not bound to the declared consequence"
    );
  } else {
    caseState.check(referenceEntry.consequence === "read", "static resource is not read-only");
  }
  if (expectedEffect === "remote_execution") {
    caseState.check(
      /interpret_solution|runCode|remote_execution/iu.test(implementation.text),
      "execution capability has no remote execution implementation"
    );
  }
  if (expectedEffect === "remote_write") {
    caseState.check(
      /submit|mutation|create|update/iu.test(implementation.text),
      "write capability has no remote write implementation"
    );
  }
}

function assertSensitiveControl({
  control,
  caseState,
  subject,
  mapping,
  referenceEntry,
  inputSchema,
  outputSchema,
  implementation
}) {
  const behavior = subject.manifest.behaviorManifest;
  const properties = inputSchema === undefined ? {} : schemaProperties(inputSchema, "sensitive input");
  switch (control) {
    case "public-data-only":
      caseState.check(referenceEntry.authentication === "public", "public control is attached to authenticated data");
      break;
    case "authenticated-current-user":
      caseState.check(
        referenceEntry.authentication === "required" && expectedSubject(referenceEntry) === "current_user",
        "current-user control has the wrong auth subject"
      );
      break;
    case "credentials-redacted":
      caseState.check(
        /Redactor|redactText|isSensitiveKey/iu.test(subject.securityCode.text),
        "credential redaction has no executable security implementation",
        { securityCode: subject.securityCode.digests }
      );
      break;
    case "bounded-page":
      caseState.check(
        Object.values(properties).some(
          (property) => Number.isFinite(property?.maximum) || Number.isFinite(property?.maxItems)
        ),
        "bounded-page control has no generated input bound"
      );
      break;
    case "content-hash-only-confirmation":
      caseState.check(
        behavior.userNotes.writeConfirmation === "required-per-call" &&
          /contentHash|Content SHA-256/iu.test(implementation.text),
        "content-hash confirmation is not implemented per call"
      );
      break;
    case "source-code-input-not-logged":
      caseState.check(
        /"code"|SENSITIVE_KEYS/iu.test(subject.securityCode.text) &&
          schemaNodesAtPath(outputSchema, "data.code").length === 0,
        "source-code input is not protected from logs/results"
      );
      break;
    case "unauthenticated-complete-regional-payload":
      caseState.check(
        referenceEntry.authentication === "public" &&
          schemaNodesAtPath(outputSchema, "data.regionalPayload").length > 0,
        "daily regional payload is not complete and publicly accessible"
      );
      break;
    case "strict-bounded-dto": {
      const serialized = canonicalJson(outputSchema);
      caseState.check(
        serialized.includes('"additionalProperties":false') &&
          /"(?:maxItems|maxLength|maxProperties)":/u.test(serialized),
        "regional DTO is not structurally closed and bounded"
      );
      break;
    }
    case "sanitized-problem-content":
      caseState.check(
        schemaNodesAtPath(outputSchema, "data.content").length > 0 &&
          /sanitizeHtml|html-to-text|convert\(/iu.test(subject.securityCode.text),
        "problem content has no executable sanitization path"
      );
      break;
    case "bounded-hints-similar-and-snippets":
      for (const path of ["data.hints", "data.similarQuestions", "data.codeSnippets"]) {
        caseState.check(
          schemaNodesAtPath(outputSchema, path).some((node) => Number.isFinite(node.maxItems)),
          `${path} has no generated item bound`
        );
      }
      break;
    case "explicit-public-username": {
      const username = properties[mapping.evidence.inputSchema.fieldMap.username];
      caseState.check(
        referenceEntry.authentication === "public" && username !== undefined,
        "public profile lookup has no explicit username subject"
      );
      break;
    }
    case "bounded-social-and-skill-facets":
      for (const path of ["data.socialAccounts", "data.skillTopics", "data.topicAreaScores"]) {
        caseState.check(
          schemaNodesAtPath(outputSchema, path).some((node) => Number.isFinite(node.maxItems)),
          `${path} has no generated item bound`
        );
      }
      break;
    case "region-scoped-session": {
      const regions = inputSchema === undefined ? [] : schemaRegionValues(inputSchema);
      caseState.check(
        referenceEntry.authentication === "required" &&
          expectedSubject(referenceEntry) === "current_user" &&
          regions.includes("global") &&
          regions.includes("cn"),
        "authenticated progress is not explicitly scoped to a regional current-user session",
        { regions }
      );
      caseState.check(
        /credential|profileId|session/iu.test(implementation.text),
        "regional session control has no credential/profile implementation binding"
      );
      break;
    }
    case "bounded-progress-facets": {
      const itemNodes = schemaNodesAtPath(outputSchema, "data.items");
      const tagNodes = schemaNodesAtPath(outputSchema, "data.items[].topicTags");
      caseState.check(
        itemNodes.some(
          (node) => Number.isFinite(node.maxItems) && node.maxItems <= 100
        ),
        "progress result is not bounded to 100 records"
      );
      caseState.check(
        tagNodes.some(
          (node) => Number.isFinite(node.maxItems) && node.maxItems <= 100
        ),
        "progress topic facets are not bounded"
      );
      caseState.check(
        Number.isFinite(properties.limit?.maximum) &&
          properties.limit.maximum <= 100,
        "progress input limit is not bounded to 100"
      );
      break;
    }
    case "bounded-50-record-page":
      caseState.check(
        schemaNodesAtPath(outputSchema, "data.history").some(
          (node) => Number.isFinite(node.maxItems) && node.maxItems <= 50
        ) &&
          Number.isFinite(properties.limit?.maximum) &&
          properties.limit.maximum <= 50,
        "contest history page is not bounded to 50 records"
      );
      break;
    case "remote-history-input-cap-2000":
      caseState.check(
        /MAX_CONTEST_HISTORY_INPUT\s*=\s*2_000|rawHistory\.length\s*>\s*MAX_CONTEST_HISTORY_INPUT/iu.test(
          implementation.text
        ),
        "contest normalization has no fail-closed 2000-record remote input cap"
      );
      break;
    case "explicit-resource-payload-opt-in":
      caseState.check(
        properties.includeResourcePayload?.default === false &&
          schemaNodesAtPath(outputSchema, "data.resourcePayload").length > 0 &&
          /includeResourcePayload/iu.test(implementation.text),
        "problem resource payload is not protected by an explicit default-off opt-in"
      );
      break;
    case "additional-properties-false": {
      const resourceNodes = schemaNodesAtPath(outputSchema, "data.resourcePayload");
      caseState.check(
        resourceNodes.length > 0 &&
          resourceNodes.every((node) => node.additionalProperties === false),
        "problem resource payload accepts undeclared future fields"
      );
      break;
    }
    case "transient-upstream-envelope-never-persisted": {
      const transient = behavior.execution.transientUpstreamEnvelope;
      const envelopeNodes = [
        ...schemaNodesAtPath(outputSchema, "data.start"),
        ...schemaNodesAtPath(outputSchema, "data.check")
      ];
      caseState.check(
        transient.persistence === "never" &&
          envelopeNodes.length >= 2 &&
          envelopeNodes.every((node) => node["x-persistence"] === "never"),
        "upstream judge envelopes are not explicitly transient"
      );
      break;
    }
    case "durable-code-hash-only":
      caseState.check(
        schemaNodesAtPath(outputSchema, "data.codeHash").length > 0 &&
          schemaNodesAtPath(outputSchema, "data.code").length === 0 &&
          /codeHash|ledger/iu.test(implementation.text),
        "durable operation state is not restricted to the code hash"
      );
      break;
    case "pi-ui-confirmation-per-call":
      caseState.check(
        /Submitting a solution requires interactive confirmation/iu.test(
          subject.securityCode.text
        ) && /Code SHA-256/iu.test(subject.securityCode.text),
        "submit does not have a per-call Pi UI hash confirmation"
      );
      break;
    case "explicit-source-code-opt-in":
      caseState.check(
        properties.includeCode?.default === false,
        "source code is not excluded by default"
      );
      break;
    case "source-code-excluded":
      caseState.check(
        properties.includeCode === undefined &&
          schemaNodesAtPath(outputSchema, "data.items[].code").length === 0,
        "list output exposes source code or a source-code opt-in"
      );
      break;
    case "immutable-contract-artifact":
      caseState.check(mapping.status === "static_contract_resource", "immutable control is not a static artifact");
      break;
    case "interactive-confirmation":
      caseState.check(
        behavior.userNotes.writeConfirmation === "required-per-call" ||
          mapping.targets.includes("lc_submit"),
        "external write has no interactive-confirmation policy"
      );
      caseState.check(
        /interactive confirmation|interaction|confirm/iu.test(implementation.text),
        "external write has no executable confirmation path"
      );
      break;
    case "no-note-content-logging":
      caseState.check(
        behavior.userNotes.persistence === "never" &&
          behavior.userNotes.sensitiveFields.includes("content"),
        "note content is not marked non-persistent and sensitive"
      );
      break;
    case "no-solution-persistence":
      caseState.check(
        behavior.solutionArticles.persistence === "never" &&
          behavior.solutionArticles.evidenceBodyStorage === "forbidden",
        "solution content persistence is not forbidden"
      );
      break;
    case "no-source-code-persistence":
      caseState.check(
        behavior.submissionDetail.persistence === "never",
        "source-code persistence is not forbidden"
      );
      break;
    case "non-model-gateway":
      caseState.check(mapping.status === "gateway_capability", "non-model control is not a gateway capability");
      break;
    case "explicit-user-request":
      caseState.check(
        referenceEntry.consequence === "answer_read" &&
          behavior.solutionArticles.disclosureRisk === "solution",
        "answer-bearing access is not explicitly classified"
      );
      break;
    case "single-article-only":
      caseState.check(
        !Object.keys(properties).some((field) => ["limit", "offset", "skip", "cursor"].includes(field)),
        "single-article control exposes pagination"
      );
      break;
    case "untrusted-content":
      caseState.check(
        behavior.solutionArticles.contentTrust === "untrusted-answer-bearing",
        "solution body is not marked untrusted"
      );
      break;
    default:
      throw new Error(`${mapping.sourceId}: unbound sensitive control: ${control}`);
  }
}

function assertSensitiveCase({
  caseState,
  subject,
  mapping,
  referenceEntry,
  inputSchema,
  outputSchema,
  implementation
}) {
  const evidence = mapping.evidence.sensitiveData;
  caseState.check(evidence.status === "verified", "sensitive-data evidence is not verified");
  caseState.check(
    evidence.classification === expectedSensitiveClassification(referenceEntry),
    "sensitive-data classification differs from reference",
    { classification: evidence.classification }
  );
  caseState.check(
    Array.isArray(evidence.controls) && evidence.controls.length > 0,
    "sensitive-data case has no concrete controls"
  );
  if (evidence.classification === "answer_bearing") {
    const contentNodes = [
      ...schemaNodesAtPath(outputSchema, "data.content"),
      ...schemaNodesAtPath(outputSchema, "data.items[].summary")
    ];
    caseState.check(contentNodes.length > 0, "answer-bearing output has no content or summary field");
    caseState.check(
      contentNodes.some(
        (node) =>
          node["x-sensitive"] === true &&
          (node["x-untrusted"] === true ||
            node["x-disclosureRisk"] === "solution") &&
          node["x-persistence"] === "never"
      ),
      "answer-bearing content lacks sensitive, untrusted, non-persistent annotations"
    );
  }
  if (evidence.classification === "personal_notes") {
    const noteContentNodes = [
      ...schemaNodesAtPath(outputSchema, "data.notes[].content"),
      ...schemaNodesAtPath(outputSchema, "data.note.content")
    ];
    caseState.check(noteContentNodes.length > 0, "personal-note output has no content field");
    caseState.check(
      noteContentNodes.some(
        (node) => node["x-sensitive"] === true && node["x-persistence"] === "never"
      ),
      "personal-note content lacks sensitive and non-persistent annotations"
    );
  }
  if (evidence.classification === "source_code") {
    caseState.check(
      schemaNodesAtPath(outputSchema, "data.code").length > 0,
      "source-code result has no opt-in code field"
    );
  }
  for (const control of evidence.controls) {
    assertSensitiveControl({
      control,
      caseState,
      subject,
      mapping,
      referenceEntry,
      inputSchema,
      outputSchema,
      implementation
    });
  }
}

function assertErrorCase({ caseState, subject, mapping, referenceEntry }) {
  const evidence = mapping.evidence.errorSemantics;
  const expectedMode =
    mapping.status === "static_contract_resource"
      ? "immutable_contract"
      : "normalized_tool_error";
  caseState.check(evidence.status === "verified", "error evidence is not verified");
  caseState.check(evidence.mode === expectedMode, "error mode differs from target kind");
  const requiredCodes = [
    ...(mapping.status === "static_contract_resource"
      ? ["CONTRACT_MISMATCH"]
      : ["VALIDATION_ERROR", "REMOTE_UNAVAILABLE", "REMOTE_SCHEMA_CHANGED"]),
    ...(referenceEntry.authentication === "required"
      ? ["AUTH_REQUIRED", "AUTH_EXPIRED"]
      : [])
  ];
  for (const code of requiredCodes) {
    caseState.check(evidence.codes.includes(code), `error evidence omits ${code}`);
  }
  for (const code of evidence.codes) {
    caseState.check(subject.schema.errors.includes(code), `generated schema omits error ${code}`);
    caseState.check(
      subject.contractModule.TOOL_ERROR_CODES.includes(code),
      `JavaScript contract omits error ${code}`,
      { code }
    );
  }
}

async function executeSemanticCases(subject) {
  const mappingById = new Map(subject.parity.mappings.map((entry) => [entry.sourceId, entry]));
  const referenceById = new Map(subject.reference.interfaces.map((entry) => [entry.id, entry]));
  const cases = [];
  for (const semanticEntry of subject.surface.interfaces) {
    const mapping = mappingById.get(semanticEntry.sourceId);
    const referenceEntry = referenceById.get(semanticEntry.sourceId);
    const binding = subject.bindings.byId.get(semanticEntry.sourceId);
    assert(mapping !== undefined, `Semantic mapping is missing: ${semanticEntry.sourceId}`);
    assert(referenceEntry !== undefined, `Reference interface is missing: ${semanticEntry.sourceId}`);
    assert(binding !== undefined, `Semantic binding is missing: ${semanticEntry.sourceId}`);
    assert(
      IMPLEMENTED_STATUSES.has(mapping.status),
      `Semantic execution refuses incomplete mapping ${semanticEntry.sourceId}: ${mapping.status}`
    );
    const implementation = await readImplementationSources(
      subject.packageDirectory,
      subject.mode,
      mapping
    );
    const inputSchema = mappingInputSchema(subject, mapping);
    const outputSchema =
      mapping.status === "static_contract_resource"
        ? undefined
        : resolveObjectPath(
            subject.schema,
            mapping.evidence.outputSchema.target,
            `${mapping.sourceId} output schema`
          );
    for (const variant of semanticEntry.variants) {
      for (const dimension of subject.surface.semanticDimensions) {
        const caseId = `upstream/${semanticEntry.sourceId}/${variant.id}/${dimension}`;
        const caseState = makeCase(caseId);
        caseState.check(
          DIGEST_PATTERN.test(subject.contractCodeDigest),
          "generated contract implementation is not digest-bound",
          { contractCodeDigest: subject.contractCodeDigest }
        );
        caseState.check(
          mapping.status === "static_contract_resource" || implementation.digests.length > 0,
          "semantic implementation subject is not digest-bound",
          { implementationDigests: implementation.digests }
        );
        if (dimension === "input_contract") {
          assertInputCase({
            caseState,
            subject,
            mapping,
            semanticEntry,
            variant,
            binding
          });
        } else if (dimension === "output_contract") {
          await assertOutputCase({ caseState, subject, mapping, binding });
        } else if (dimension === "auth_subject_scope") {
          assertAuthCase({
            caseState,
            subject,
            mapping,
            referenceEntry,
            variant,
            inputSchema,
            implementation
          });
        } else if (dimension === "region_endpoint") {
          assertRegionCase({
            caseState,
            subject,
            mapping,
            semanticEntry,
            variant,
            inputSchema,
            implementation
          });
        } else if (dimension === "pagination_defaults_filters") {
          assertPaginationCase({
            caseState,
            subject,
            mapping,
            semanticEntry,
            variant,
            inputSchema,
            binding
          });
        } else if (dimension === "capability_side_effect") {
          assertCapabilityCase({
            caseState,
            subject,
            mapping,
            referenceEntry,
            implementation
          });
        } else if (dimension === "sensitive_data") {
          assertSensitiveCase({
            caseState,
            subject,
            mapping,
            referenceEntry,
            inputSchema,
            outputSchema,
            implementation
          });
        } else if (dimension === "error_semantics") {
          assertErrorCase({ caseState, subject, mapping, referenceEntry });
        } else {
          throw new Error(`Unbound semantic dimension: ${dimension}`);
        }
        cases.push(caseState.finish());
      }
    }
  }
  assertExactSet(
    cases.map((entry) => entry.caseId),
    requiredSemanticCaseIds(subject.surface),
    `${subject.mode} executed semantic case IDs`
  );
  return cases;
}

async function runnerIdentity(bindingsDocument) {
  const scriptBytes = await readFile(SCRIPT_PATH);
  const scriptDigest = sha256Bytes(scriptBytes);
  const bindingDigest = sha256Jcs(bindingsDocument);
  const identity = {
    name: "pi-leetcode-upstream-semantic-runner",
    version: "2",
    scriptDigest,
    bindingDigest
  };
  return { ...identity, digest: sha256Jcs(identity) };
}

export function requiredSemanticCaseIds(surface) {
  assertObject(surface, "semantic surface");
  assertStringArray(surface.semanticDimensions, "semantic surface dimensions");
  assert(Array.isArray(surface.interfaces), "semantic interfaces must be an array");
  const caseIds = [];
  for (const entry of surface.interfaces) {
    assertObject(entry, "semantic interface");
    assertString(entry.sourceId, "semantic interface sourceId");
    assert(Array.isArray(entry.variants), `${entry.sourceId}.variants must be an array`);
    for (const variant of entry.variants) {
      assertObject(variant, `${entry.sourceId} variant`);
      assertString(variant.id, `${entry.sourceId} variant id`);
      for (const dimension of surface.semanticDimensions) {
        caseIds.push(`upstream/${entry.sourceId}/${variant.id}/${dimension}`);
      }
    }
  }
  assert(
    new Set(caseIds).size === caseIds.length,
    "Generated semantic case IDs are not unique"
  );
  return caseIds.sort();
}

function receiptPayload(receipt) {
  const { receiptDigest: _digest, ...payload } = receipt;
  return payload;
}

export function buildExecutionReceipt({ mode, surface, parityReport, runner, cases }) {
  assert(RECEIPT_MODES.has(mode), `Unsupported execution receipt mode: ${mode}`);
  const receipt = {
    schemaVersion: 2,
    receiptType: "upstream-semantic-execution",
    mode,
    reference: {
      inventoryDigest: parityReport.inventoryDigest,
      semanticSurfaceDigest: parityReport.semanticSurfaceDigest,
      queryDependency: {
        package: parityReport.queryDependency.package,
        version: parityReport.queryDependency.version,
        tarballSha256: parityReport.queryDependency.sha256,
        graphqlCatalogDigest: parityReport.queryDependency.graphqlCatalogDigest
      }
    },
    target: parityReport.targetIdentity,
    runner,
    cases: [...cases].sort((left, right) => left.caseId.localeCompare(right.caseId))
  };
  return { ...receipt, receiptDigest: sha256Jcs(receipt) };
}

export function validateExecutionReceipt(receipt, { mode, surface, parityReport }) {
  assertObject(receipt, `${mode} execution receipt`);
  assert(receipt.schemaVersion === 2, `${mode} execution receipt schemaVersion must be 2`);
  assert(
    receipt.receiptType === "upstream-semantic-execution",
    `${mode} execution receipt type is invalid`
  );
  assert(receipt.mode === mode, `${mode} execution receipt mode is invalid`);
  assertObject(receipt.reference, `${mode} execution receipt reference`);
  assert(
    receipt.reference.inventoryDigest === parityReport.inventoryDigest &&
      receipt.reference.semanticSurfaceDigest === parityReport.semanticSurfaceDigest,
    `${mode} execution receipt reference identity is stale`
  );
  assertObject(receipt.reference.queryDependency, `${mode} execution receipt query dependency`);
  assert(
    canonicalJson(receipt.reference.queryDependency) ===
      canonicalJson({
        package: parityReport.queryDependency.package,
        version: parityReport.queryDependency.version,
        tarballSha256: parityReport.queryDependency.sha256,
        graphqlCatalogDigest: parityReport.queryDependency.graphqlCatalogDigest
      }),
    `${mode} execution receipt query dependency is stale`
  );
  assertObject(receipt.target, `${mode} execution receipt target`);
  assert(
    canonicalJson(receipt.target) === canonicalJson(parityReport.targetIdentity),
    `${mode} execution receipt target identity is stale`
  );
  assertObject(receipt.runner, `${mode} execution receipt runner`);
  assert(receipt.runner.name === "pi-leetcode-upstream-semantic-runner", `${mode} runner name is invalid`);
  assert(receipt.runner.version === "2", `${mode} runner version is invalid`);
  for (const field of ["scriptDigest", "bindingDigest", "digest"]) {
    assert(DIGEST_PATTERN.test(receipt.runner[field]), `${mode} runner ${field} is invalid`);
  }
  assert(
    receipt.runner.digest ===
      sha256Jcs({
        name: receipt.runner.name,
        version: receipt.runner.version,
        scriptDigest: receipt.runner.scriptDigest,
        bindingDigest: receipt.runner.bindingDigest
      }),
    `${mode} runner digest is stale`
  );
  assert(Array.isArray(receipt.cases), `${mode} execution receipt cases must be an array`);
  const requiredCaseIds = requiredSemanticCaseIds(surface);
  assertExactSet(
    receipt.cases.map((entry) => entry?.caseId),
    requiredCaseIds,
    `${mode} execution receipt case IDs`
  );
  for (const [index, entry] of receipt.cases.entries()) {
    const label = `${mode} execution receipt cases[${index}]`;
    assertObject(entry, label);
    assertString(entry.caseId, `${label}.caseId`);
    assert(entry.status === "passed", `${label}.status must be passed`);
    assert(
      Number.isSafeInteger(entry.assertionCount) && entry.assertionCount > 0,
      `${label}.assertionCount must be a positive integer`
    );
    assert(DIGEST_PATTERN.test(entry.evidenceDigest), `${label}.evidenceDigest is invalid`);
  }
  assert(DIGEST_PATTERN.test(receipt.receiptDigest), `${mode} execution receipt digest is invalid`);
  assert(
    receipt.receiptDigest === sha256Jcs(receiptPayload(receipt)),
    `${mode} execution receipt digest is stale`
  );
  return {
    mode,
    receiptDigest: receipt.receiptDigest,
    runnerDigest: receipt.runner.digest,
    bindingDigest: receipt.runner.bindingDigest,
    passedCases: receipt.cases.length,
    requiredCases: requiredCaseIds.length
  };
}

export async function readExecutionReceipt(path, options) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${options.mode} upstream execution receipt is missing or unreadable: ${path}`,
      { cause: error }
    );
  }
  return validateExecutionReceipt(receipt, options);
}

async function writeReceipt(path, receipt) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporaryPath, path);
}

export async function generateExecutionReceipt({
  mode,
  packageDirectory = PACKAGE_DIRECTORY,
  parityReport,
  bindingsPath,
  outputPath
}) {
  assertObject(parityReport, `${mode} parity report`);
  const subject = await loadSubject({
    packageDirectory: resolve(packageDirectory),
    mode,
    parityReport,
    bindingsPath
  });
  const cases = await executeSemanticCases(subject);
  const runner = await runnerIdentity(subject.bindings.document);
  const receipt = buildExecutionReceipt({
    mode,
    surface: subject.surface,
    parityReport,
    runner,
    cases
  });
  validateExecutionReceipt(receipt, {
    mode,
    surface: subject.surface,
    parityReport
  });
  if (outputPath !== undefined) await writeReceipt(resolve(outputPath), receipt);
  return { receipt, surface: subject.surface };
}

function parseArguments(argv) {
  const options = {
    mode: undefined,
    packageDirectory: PACKAGE_DIRECTORY,
    bindingsPath: DEFAULT_BINDINGS_PATH,
    outputPath: undefined,
    reportPath: undefined,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") options.mode = argv[++index];
    else if (argument === "--package-root") options.packageDirectory = resolve(argv[++index]);
    else if (argument === "--bindings") options.bindingsPath = resolve(argv[++index]);
    else if (argument === "--output") options.outputPath = resolve(argv[++index]);
    else if (argument === "--parity-report") options.reportPath = resolve(argv[++index]);
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  assert(RECEIPT_MODES.has(options.mode), "--mode must be source or packed");
  assert(options.outputPath !== undefined, "--output is required");
  assert(options.reportPath !== undefined, "--parity-report is required");
  return options;
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const parityReport = await readJson(options.reportPath);
    const { receipt } = await generateExecutionReceipt({
      mode: options.mode,
      packageDirectory: options.packageDirectory,
      parityReport,
      bindingsPath: options.bindingsPath,
      outputPath: options.outputPath
    });
    const summary = {
      mode: receipt.mode,
      receiptDigest: receipt.receiptDigest,
      runnerDigest: receipt.runner.digest,
      bindingDigest: receipt.runner.bindingDigest,
      passedCases: receipt.cases.length
    };
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(`${receipt.mode} semantic execution passed: ${receipt.cases.length} cases`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
