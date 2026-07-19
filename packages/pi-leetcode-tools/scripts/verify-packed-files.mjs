import { join } from "node:path";

import {
  assert,
  formatBytes,
  readJson,
  resolveTarball,
  walkPackageFiles,
  withExtractedPackage
} from "./release-utils.mjs";
import { stat } from "node:fs/promises";

const DEFAULT_MAX_TARBALL_BYTES = 1024 * 1024;
const DEFAULT_MAX_UNPACKED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILE_COUNT = 500;

function readLimit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

const maxTarballBytes = readLimit(
  "PI_LEETCODE_MAX_TARBALL_BYTES",
  DEFAULT_MAX_TARBALL_BYTES
);
const maxUnpackedBytes = readLimit(
  "PI_LEETCODE_MAX_UNPACKED_BYTES",
  DEFAULT_MAX_UNPACKED_BYTES
);
const maxFileBytes = readLimit("PI_LEETCODE_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
const maxFileCount = readLimit("PI_LEETCODE_MAX_FILE_COUNT", DEFAULT_MAX_FILE_COUNT);

const allowedExactFiles = new Set([
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "package.json",
  "contract/manifest.json",
  "contract/schema.json",
  "contract/capabilities.json",
  "contract/catalogs.json",
  "upstream/reference-surface.json",
  "upstream/reference-semantics.json",
  "upstream/semantic-case-bindings.json",
  "upstream/parity.json"
]);
const requiredFiles = new Set([
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "package.json",
  "contract/manifest.json",
  "contract/schema.json",
  "contract/capabilities.json",
  "contract/catalogs.json",
  "upstream/reference-surface.json",
  "upstream/reference-semantics.json",
  "upstream/semantic-case-bindings.json",
  "upstream/parity.json",
  "dist/extensions/index.js",
  "dist/src/tool-calls/contract.js"
]);
const allowedDeclaredFiles = new Set([
  "dist",
  "contract",
  "upstream",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "NOTICE",
  "SECURITY.md"
]);
const allowedDistFile = /^dist\/.+\.(?:js|js\.map|d\.ts|d\.ts\.map|json)$/u;
const forbiddenDependencyPrefix = /^(?:workspace:|file:|link:|git(?:\+|:)|https?:)/u;

function isAllowedFile(path) {
  return allowedExactFiles.has(path) || allowedDistFile.test(path);
}

function verifyDependencySpecifiers(packageJson) {
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
      assert(typeof version === "string", `${section}.${name} must be a string`);
      assert(version !== "*" && version !== "latest", `${section}.${name} is unbounded`);
      assert(
        !forbiddenDependencyPrefix.test(version),
        `${section}.${name} uses a non-registry dependency: ${version}`
      );
    }
  }

  assert(
    JSON.stringify(packageJson.peerDependencies) ===
      JSON.stringify({
        "@earendil-works/pi-coding-agent": "*",
        typebox: "*"
      }),
    "Published Tools must use the host Pi/typebox peer dependency boundary"
  );

  for (const name of ["@earendil-works/pi-coding-agent", "typebox"]) {
    assert(
      packageJson.dependencies?.[name] === undefined &&
        packageJson.optionalDependencies?.[name] === undefined,
      `Published Tools must not bundle host dependency ${name}`
    );
  }
}

const tarball = await resolveTarball();
const tarballSize = (await stat(tarball)).size;
assert(
  tarballSize <= maxTarballBytes,
  `Tarball is ${formatBytes(tarballSize)}; limit is ${formatBytes(maxTarballBytes)}`
);

await withExtractedPackage(tarball, async ({ packageDirectory }) => {
  const files = await walkPackageFiles(packageDirectory);
  assert(files.length <= maxFileCount, `Tarball contains ${files.length} files; limit is ${maxFileCount}`);

  let unpackedBytes = 0;
  const paths = new Set();
  for (const file of files) {
    assert(isAllowedFile(file.path), `Tarball contains a disallowed file: ${file.path}`);
    assert(file.size <= maxFileBytes, `Tarball file exceeds size limit: ${file.path}`);
    unpackedBytes += file.size;
    paths.add(file.path);
  }

  assert(
    unpackedBytes <= maxUnpackedBytes,
    `Unpacked package is ${formatBytes(unpackedBytes)}; limit is ${formatBytes(maxUnpackedBytes)}`
  );
  for (const required of requiredFiles) {
    assert(paths.has(required), `Tarball is missing required file: ${required}`);
  }

  const packageJson = await readJson(join(packageDirectory, "package.json"));
  assert(packageJson.private !== true, "Published package must not be private");
  assert(Array.isArray(packageJson.files), "package.json must use a files allowlist");
  for (const declared of packageJson.files) {
    assert(allowedDeclaredFiles.has(declared), `package.json files entry is not allowed: ${declared}`);
  }
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    assert(
      packageJson.scripts?.[lifecycle] === undefined,
      `Published package must not define ${lifecycle}`
    );
  }
  verifyDependencySpecifiers(packageJson);

  console.log(
    `Packed files verified: ${files.length} files, ${formatBytes(tarballSize)} compressed, ${formatBytes(unpackedBytes)} unpacked`
  );
});
