import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import ts from "typescript";

import { assert, canonicalJson } from "./release-utils.mjs";

const REGULAR_FILE_TYPES = new Set(["", "0", "\0"]);

function readTarString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero === -1 ? field.length : zero).toString("utf8").trim();
}

function readTarSize(buffer, offset, length, label) {
  const field = buffer.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    assert(value <= BigInt(Number.MAX_SAFE_INTEGER), `${label} exceeds the safe integer range`);
    return Number(value);
  }
  const text = readTarString(buffer, offset, length).replaceAll("\0", "").trim();
  if (text.length === 0) return 0;
  assert(/^[0-7]+$/u.test(text), `${label} is not an octal tar size`);
  return Number.parseInt(text, 8);
}

function parsePaxRecord(data) {
  const values = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(" ", offset);
    assert(space > offset, "PAX record length is malformed");
    const length = Number.parseInt(data.slice(offset, space), 10);
    assert(Number.isSafeInteger(length) && length > 0, "PAX record length is invalid");
    const record = data.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    assert(equals > 0, "PAX record is malformed");
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

function extractTarFiles(tarBuffer) {
  const files = new Map();
  let offset = 0;
  let pendingPax = {};
  let pendingLongName;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = readTarSize(header, 124, 12, `tar entry ${name || "<unnamed>"}`);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataOffset = offset + 512;
    const dataEnd = dataOffset + size;
    assert(dataEnd <= tarBuffer.length, `Tar entry exceeds archive bounds: ${name}`);
    const data = tarBuffer.subarray(dataOffset, dataEnd);
    let path = prefix.length > 0 ? `${prefix}/${name}` : name;

    if (type === "x") {
      pendingPax = parsePaxRecord(data.toString("utf8"));
    } else if (type === "L") {
      pendingLongName = data.toString("utf8").replace(/\0.*$/su, "").trim();
    } else {
      path = pendingPax.path ?? pendingLongName ?? path;
      if (REGULAR_FILE_TYPES.has(type)) {
        assert(!files.has(path), `Tar archive contains duplicate file: ${path}`);
        files.set(path, Buffer.from(data));
      }
      pendingPax = {};
      pendingLongName = undefined;
    }

    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return files;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha512Integrity(buffer) {
  return `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw new Error(`Unsupported computed schema property in upstream source: ${node.getText()}`);
}

function stringLiteral(node, label) {
  assert(node !== undefined && ts.isStringLiteralLike(node), `${label} must be a static string literal`);
  return node.text;
}

function resourceTemplate(node, label) {
  if (ts.isStringLiteralLike(node)) return node.text;
  assert(ts.isNewExpression(node), `${label} must be a string or ResourceTemplate`);
  assert(
    ts.isIdentifier(node.expression) && node.expression.text === "ResourceTemplate",
    `${label} must construct ResourceTemplate`
  );
  return stringLiteral(node.arguments?.[0], `${label} ResourceTemplate URI`);
}

function toolInputFields(node, label) {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return [];
  const fields = [];
  for (const member of node.properties) {
    assert(
      ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member),
      `${label} contains a non-static input schema member`
    );
    fields.push(propertyName(member.name));
  }
  return fields;
}

function extractRegistrations(path, sourceText) {
  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const registrations = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "tool" || node.expression.name.text === "resource") &&
      node.expression.expression.getText(sourceFile).endsWith(".server")
    ) {
      const kind = node.expression.name.text;
      const name = stringLiteral(node.arguments[0], `${path} ${kind} name`);
      if (kind === "tool") {
        registrations.push({
          kind,
          name,
          inputFields: toolInputFields(node.arguments[2], `${path} tool ${name}`),
          sourceFile: path
        });
      } else {
        const uriTemplate = resourceTemplate(node.arguments[1], `${path} resource ${name}`);
        registrations.push({
          kind,
          name,
          inputFields: [...uriTemplate.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]),
          uriTemplate,
          sourceFile: path
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return registrations;
}

function aggregateRegistrations(registrations) {
  const byId = new Map();
  for (const registration of registrations) {
    const id = `${registration.kind}:${registration.name}`;
    const existing = byId.get(id) ?? {
      id,
      kind: registration.kind,
      name: registration.name,
      inputFields: new Set(),
      uriTemplates: new Set(),
      sourceFiles: new Set(),
      registrationCount: 0
    };
    assert(existing.kind === registration.kind, `Upstream interface kind changed within archive: ${id}`);
    for (const field of registration.inputFields) existing.inputFields.add(field);
    if (registration.uriTemplate !== undefined) existing.uriTemplates.add(registration.uriTemplate);
    existing.sourceFiles.add(registration.sourceFile);
    existing.registrationCount += 1;
    byId.set(id, existing);
  }

  return [...byId.values()]
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      inputFields: [...entry.inputFields].sort(),
      ...(entry.kind === "resource" ? { uriTemplates: [...entry.uriTemplates].sort() } : {}),
      sourceFiles: [...entry.sourceFiles].sort(),
      registrationCount: entry.registrationCount
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function extractUpstreamInventory(tarballPath) {
  const absoluteTarballPath = resolve(tarballPath);
  const archive = await readFile(absoluteTarballPath);
  const files = extractTarFiles(gunzipSync(archive));
  const packageJsonBuffer = files.get("package/package.json");
  assert(packageJsonBuffer !== undefined, "Pinned upstream archive does not contain package/package.json");
  const packageJson = JSON.parse(packageJsonBuffer.toString("utf8"));

  const sourceEntries = [...files.entries()].filter(([path]) =>
    /^package\/build\/mcp\/(?:tools|resources)\/[^/]+\.js$/u.test(path)
  );
  assert(sourceEntries.length > 0, "Pinned upstream archive contains no MCP registration sources");
  const registrations = sourceEntries.flatMap(([path, contents]) =>
    extractRegistrations(path, contents.toString("utf8"))
  );
  const interfaces = aggregateRegistrations(registrations);
  const toolCount = interfaces.filter((entry) => entry.kind === "tool").length;
  const resourceCount = interfaces.filter((entry) => entry.kind === "resource").length;

  const surface = {
    package: packageJson.name,
    version: packageJson.version,
    counts: {
      tools: toolCount,
      resources: resourceCount,
      total: interfaces.length,
      toolRegistrations: registrations.filter((entry) => entry.kind === "tool").length,
      resourceRegistrations: registrations.filter((entry) => entry.kind === "resource").length
    },
    interfaces
  };

  return {
    tarballPath: absoluteTarballPath,
    sizeBytes: archive.length,
    sha256: sha256(archive),
    integrity: sha512Integrity(archive),
    surface,
    surfaceCanonicalJson: canonicalJson(surface),
    sourceTextByPath: Object.fromEntries(
      [...files.entries()]
        .filter(([path]) => /^package\/build\/.+\.js$/u.test(path))
        .map(([path, contents]) => [
          path.slice("package/".length),
          contents.toString("utf8")
        ])
        .sort(([left], [right]) => left.localeCompare(right))
    )
  };
}

function extractGraphqlCatalog(path, sourceText) {
  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const queries = {};

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isStringLiteralLike(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      const value = node.initializer.text;
      if (/\b(?:query|mutation)\b/u.test(value)) {
        queries[node.name.text] = value;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return Object.fromEntries(
    Object.entries(queries).sort(([left], [right]) => left.localeCompare(right))
  );
}

/**
 * Extracts the exact semantic dependency used by the pinned MCP package.
 * The MCP package declares `leetcode-query` with a range, so parity evidence
 * must bind one concrete archive instead of silently following that range.
 */
export async function extractLeetCodeQueryReference(tarballPath) {
  const absoluteTarballPath = resolve(tarballPath);
  const archive = await readFile(absoluteTarballPath);
  const files = extractTarFiles(gunzipSync(archive));
  const packageJsonBuffer = files.get("package/package.json");
  const libraryBuffer = files.get("package/lib/index.js");
  assert(
    packageJsonBuffer !== undefined,
    "Pinned leetcode-query archive does not contain package/package.json"
  );
  assert(
    libraryBuffer !== undefined,
    "Pinned leetcode-query archive does not contain package/lib/index.js"
  );

  const packageJson = JSON.parse(packageJsonBuffer.toString("utf8"));
  const librarySource = libraryBuffer.toString("utf8");
  const graphqlCatalog = extractGraphqlCatalog(
    "package/lib/index.js",
    librarySource
  );
  assert(
    Object.keys(graphqlCatalog).length > 0,
    "Pinned leetcode-query archive exposes no static GraphQL catalog"
  );

  return {
    tarballPath: absoluteTarballPath,
    package: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    sizeBytes: archive.length,
    sha256: sha256(archive),
    integrity: sha512Integrity(archive),
    library: {
      path: "package/lib/index.js",
      sizeBytes: libraryBuffer.length,
      sha256: sha256(libraryBuffer)
    },
    librarySource,
    graphqlCatalog,
    graphqlQueryCount: Object.keys(graphqlCatalog).length,
    graphqlCatalogDigest: `sha256:${createHash("sha256")
      .update(canonicalJson(graphqlCatalog), "utf8")
      .digest("hex")}`
  };
}
