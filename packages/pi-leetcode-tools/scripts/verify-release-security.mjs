import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  REPOSITORY_ROOT,
  assert,
  pathExists,
  readJson,
  resolveTarball,
  runCommand,
  sha256CanonicalJson,
  walkPackageFiles,
  withExtractedPackage
} from "./release-utils.mjs";

const SECURITY_GATE_VERSION = 1;
const SECRET_SCANNER_VERSION = 1;
const MAX_SECRET_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const EXPECTED_PACKAGE_NAME = "pi-leetcode-tools";
const SBOM_FILE_NAME = "pi-leetcode-tools-sbom.cdx.json";
const EVIDENCE_FILE_NAME = "pi-leetcode-tools-release-evidence.json";
const PI_ACTIVATION_EVIDENCE_FILE_NAME =
  "pi-leetcode-tools-pi-activation-evidence.json";
const REMOTE_DEPENDENCY_SPECIFIER = /^(?:workspace:|file:|link:|git(?:\+|:)|github:|https?:)/iu;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/iu;
const HOST_PEER_DEPENDENCIES = Object.freeze({
  "@earendil-works/pi-coding-agent": "*",
  typebox: "*"
});

const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense"
]);
const ALLOWED_LICENSE_EXCEPTIONS = new Set(["LLVM-exception"]);
const INHERITED_LICENSE_TEXT_PACKAGES = [
  {
    packagePattern: /^@napi-rs\/keyring-(?:darwin|linux|win32)-[a-z0-9-]+$/u,
    sourcePackage: "@napi-rs/keyring",
    license: "MIT",
    repository: "https://github.com/Brooooooklyn/keyring-node"
  }
];

const SECRET_RULES = [
  {
    id: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu
  },
  {
    id: "npm-access-token",
    pattern: /\bnpm_[A-Za-z0-9]{36,}\b/gu
  },
  {
    id: "npm-auth-config",
    pattern: /\/\/[^\s:=]+\/:_authToken\s*=\s*(?!<|\$\{|\[REDACTED\])[^\s"']{12,}/giu
  },
  {
    id: "github-access-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/gu
  },
  {
    id: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/gu
  },
  {
    id: "stripe-live-secret",
    pattern: /\b(?:rk|sk)_live_[0-9A-Za-z]{16,}\b/gu
  },
  {
    id: "jwt-bearer-token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu
  },
  {
    id: "leetcode-environment-secret",
    pattern:
      /\bLEETCODE(?:_CN)?_(?:SESSION|CSRF_TOKEN)\s*=\s*["']?(?!<|\$\{|%|\[REDACTED\]|example\b|your[-_])([A-Za-z0-9._%+/=-]{16,})/giu
  },
  {
    id: "authorization-header-secret",
    pattern: /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9+/_=-]{16,}/giu
  }
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha512(value) {
  return createHash("sha512").update(value).digest("hex");
}

function sha512Integrity(value) {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function portablePath(value) {
  return value.split(sep).join("/");
}

function isInside(baseDirectory, candidate) {
  const path = relative(baseDirectory, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

async function scanPackedSecrets(packageDirectory) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files = await walkPackageFiles(packageDirectory);
  const scanned = [];
  const findings = [];

  for (const file of files) {
    assert(
      file.size <= MAX_SECRET_SCAN_FILE_BYTES,
      `Secret scanner refuses oversized file: ${file.path}`
    );
    const contents = await readFile(join(packageDirectory, ...file.path.split("/")));
    let text;
    try {
      text = decoder.decode(contents);
    } catch {
      throw new Error(`Secret scanner cannot decode packed file as UTF-8: ${file.path}`);
    }
    scanned.push({ path: file.path, size: file.size, sha256: sha256(contents) });

    for (const rule of SECRET_RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of text.matchAll(rule.pattern)) {
        findings.push({
          rule: rule.id,
          path: file.path,
          line: lineNumberAt(text, match.index ?? 0)
        });
      }
    }
  }

  assert(
    findings.length === 0,
    `Potential secrets found in tarball:\n${findings
      .map((finding) => `- ${finding.path}:${finding.line} (${finding.rule})`)
      .join("\n")}`
  );

  scanned.sort((left, right) => left.path.localeCompare(right.path));
  return {
    scanner: "built-in-pattern-scanner",
    version: SECRET_SCANNER_VERSION,
    rules: SECRET_RULES.map((rule) => rule.id),
    filesScanned: scanned.length,
    scannedFilesDigest: sha256CanonicalJson(scanned),
    findings: 0
  };
}

function tokenizeLicense(expression) {
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.-]*/gu);
  assert(tokens !== null && tokens.length > 0, `Invalid license expression: ${expression}`);
  const reconstructed = tokens.join("").toLowerCase();
  const compact = expression.replace(/\s+/gu, "").toLowerCase();
  assert(reconstructed === compact, `Unsupported license expression syntax: ${expression}`);
  return tokens;
}

function verifyLicense(name, version, expression) {
  assert(
    typeof expression === "string" && expression.trim().length > 0,
    `${name}@${version} does not declare a license`
  );
  const normalized = expression.trim();
  assert(
    normalized.toUpperCase() !== "UNLICENSED" && !/^SEE LICEN[CS]E IN /iu.test(normalized),
    `${name}@${version} uses a non-verifiable license declaration: ${normalized}`
  );

  let previous;
  for (const token of tokenizeLicense(normalized)) {
    if (["(", ")", "AND", "OR"].includes(token)) {
      previous = token;
      continue;
    }
    if (token === "WITH") {
      previous = token;
      continue;
    }
    if (previous === "WITH") {
      assert(
        ALLOWED_LICENSE_EXCEPTIONS.has(token),
        `${name}@${version} uses an unapproved license exception: ${token}`
      );
    } else {
      assert(
        ALLOWED_LICENSES.has(token),
        `${name}@${version} uses a license outside the release allowlist: ${token}`
      );
    }
    previous = token;
  }
  return normalized;
}

async function hasLicenseText(packageDirectory) {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  return entries.some(
    (entry) =>
      entry.isFile() && /^(?:licen[cs]e|copying)(?:$|[._-])/iu.test(entry.name)
  );
}

function repositoryUrl(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  return typeof value === "string"
    ? value.replace(/^git\+/u, "").replace(/\.git$/u, "")
    : undefined;
}

async function hasApprovedInheritedLicenseText(manifest, packageDirectory) {
  const policy = INHERITED_LICENSE_TEXT_PACKAGES.find((candidate) =>
    candidate.packagePattern.test(manifest.name)
  );
  if (
    policy === undefined ||
    manifest.license !== policy.license ||
    repositoryUrl(manifest.repository) !== policy.repository
  ) {
    return false;
  }

  const sourceDirectory = join(dirname(packageDirectory), "keyring");
  if (!(await pathExists(join(sourceDirectory, "package.json")))) return false;
  const sourceManifest = await readJson(join(sourceDirectory, "package.json"));
  return sourceManifest.name === policy.sourcePackage &&
    sourceManifest.version === manifest.version &&
    sourceManifest.license === policy.license &&
    repositoryUrl(sourceManifest.repository) === policy.repository &&
    await hasLicenseText(sourceDirectory);
}

function dependencySections(manifest) {
  return [
    ["dependencies", manifest.dependencies ?? {}, false],
    ["optionalDependencies", manifest.optionalDependencies ?? {}, true],
    ["peerDependencies", manifest.peerDependencies ?? {}, false]
  ];
}

function verifyProductionSpecifiers(manifest) {
  for (const [section, dependencies] of dependencySections(manifest)) {
    assert(
      dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies),
      `${manifest.name}@${manifest.version} has an invalid ${section} field`
    );
    for (const [name, specifier] of Object.entries(dependencies)) {
      assert(PACKAGE_NAME.test(name), `Invalid production dependency name: ${name}`);
      assert(
        typeof specifier === "string" && specifier.length > 0,
        `${manifest.name}@${manifest.version} has an invalid ${section}.${name}`
      );
      assert(
        !REMOTE_DEPENDENCY_SPECIFIER.test(specifier),
        `${manifest.name}@${manifest.version} uses non-registry ${section}.${name}: ${specifier}`
      );
    }
  }
}

function packageSegments(name) {
  return name.split("/");
}

async function resolveDependency(packageDirectory, installDirectory, name) {
  let cursor = packageDirectory;
  while (isInside(installDirectory, cursor)) {
    if (basename(cursor) !== "node_modules") {
      const candidate = join(cursor, "node_modules", ...packageSegments(name));
      if (await pathExists(join(candidate, "package.json"))) {
        return realpath(candidate);
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return undefined;
}

async function discoverInstalledPackages(nodeModulesDirectory, output = new Set()) {
  if (!(await pathExists(nodeModulesDirectory))) {
    return output;
  }
  const entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = join(nodeModulesDirectory, entry.name);
    const metadata = await lstat(entryPath);
    assert(!metadata.isSymbolicLink(), `Production tree contains a symbolic link: ${entryPath}`);
    if (entry.name.startsWith("@")) {
      assert(metadata.isDirectory(), `Invalid npm scope entry: ${entryPath}`);
      const scopedEntries = await readdir(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        const packageDirectory = join(entryPath, scopedEntry.name);
        const scopedMetadata = await lstat(packageDirectory);
        assert(
          scopedMetadata.isDirectory() && !scopedMetadata.isSymbolicLink(),
          `Invalid scoped package entry: ${packageDirectory}`
        );
        assert(
          await pathExists(join(packageDirectory, "package.json")),
          `Installed package is missing package.json: ${packageDirectory}`
        );
        output.add(await realpath(packageDirectory));
        await discoverInstalledPackages(join(packageDirectory, "node_modules"), output);
      }
      continue;
    }
    assert(metadata.isDirectory(), `Invalid node_modules entry: ${entryPath}`);
    assert(
      await pathExists(join(entryPath, "package.json")),
      `Installed package is missing package.json: ${entryPath}`
    );
    output.add(await realpath(entryPath));
    await discoverInstalledPackages(join(entryPath, "node_modules"), output);
  }
  return output;
}

async function inspectProductionTree(installDirectory, rootPackageDirectory) {
  const rootDirectory = await realpath(rootPackageDirectory);
  const queue = [rootDirectory];
  const nodes = new Map();
  let hostPeerDependencies;

  while (queue.length > 0) {
    const packageDirectory = queue.shift();
    if (nodes.has(packageDirectory)) {
      continue;
    }
    assert(isInside(installDirectory, packageDirectory), `Package escaped install root: ${packageDirectory}`);
    const manifest = await readJson(join(packageDirectory, "package.json"));
    assert(
      typeof manifest.name === "string" && PACKAGE_NAME.test(manifest.name),
      `Installed package has an invalid name: ${packageDirectory}`
    );
    assert(
      typeof manifest.version === "string" && manifest.version.length > 0,
      `Installed package has no version: ${manifest.name}`
    );
    verifyProductionSpecifiers(manifest);
    if (packageDirectory === rootDirectory) {
      const actualHostPeers = Object.fromEntries(
        Object.entries(manifest.peerDependencies ?? {}).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      );
      const expectedHostPeers = Object.fromEntries(
        Object.entries(HOST_PEER_DEPENDENCIES).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      );
      assert(
        JSON.stringify(actualHostPeers) === JSON.stringify(expectedHostPeers),
        "Release artifact host peer dependency contract is stale"
      );
      hostPeerDependencies = actualHostPeers;
    }
    const license = verifyLicense(manifest.name, manifest.version, manifest.license);
    assert(
      await hasLicenseText(packageDirectory) ||
        await hasApprovedInheritedLicenseText(manifest, packageDirectory),
      `${manifest.name}@${manifest.version} does not include a license text file`
    );

    const node = {
      directory: packageDirectory,
      name: manifest.name,
      version: manifest.version,
      license,
      dependencies: new Set()
    };
    nodes.set(packageDirectory, node);

    for (const [section, dependencies, optionalSection] of dependencySections(manifest)) {
      if (packageDirectory === rootDirectory && section === "peerDependencies") {
        // Pi supplies these host contracts. They are validated above but are
        // deliberately outside the package-owned production closure/SBOM.
        continue;
      }
      for (const name of Object.keys(dependencies).sort()) {
        const peerOptional =
          section === "peerDependencies" && manifest.peerDependenciesMeta?.[name]?.optional === true;
        const dependencyDirectory = await resolveDependency(packageDirectory, installDirectory, name);
        if (dependencyDirectory === undefined) {
          assert(
            optionalSection || peerOptional,
            `${manifest.name}@${manifest.version} is missing production dependency ${name}`
          );
          continue;
        }
        node.dependencies.add(dependencyDirectory);
        queue.push(dependencyDirectory);
      }
    }
  }

  const discovered = await discoverInstalledPackages(join(installDirectory, "node_modules"));
  const reachable = new Set(nodes.keys());
  const extraneous = [...discovered].filter((path) => !reachable.has(path));
  assert(
    extraneous.length === 0,
    `Actual production tree contains extraneous packages:\n${extraneous.join("\n")}`
  );
  const missing = [...reachable].filter((path) => !discovered.has(path));
  assert(
    missing.length === 0,
    `Production dependency graph references undiscovered packages:\n${missing.join("\n")}`
  );

  assert(hostPeerDependencies !== undefined, "Root host peer dependency contract was not inspected");
  for (const name of Object.keys(hostPeerDependencies)) {
    assert(
      await resolveDependency(rootDirectory, installDirectory, name) === undefined,
      `Host peer was copied into the package-owned production tree: ${name}`
    );
  }

  return { rootDirectory, nodes, hostPeerDependencies };
}

function npmPurl(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.slice(1).split("/");
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function componentIdentity(node) {
  return `${node.name}\u0000${node.version}`;
}

function componentRef(node) {
  return npmPurl(node.name, node.version);
}

function cycloneComponent(node, occurrenceCount, tarballDigest) {
  const scoped = node.name.startsWith("@");
  const [group, name] = scoped ? node.name.split("/") : [undefined, node.name];
  return {
    type: node.name === EXPECTED_PACKAGE_NAME ? "application" : "library",
    ...(group === undefined ? {} : { group }),
    name,
    version: node.version,
    "bom-ref": componentRef(node),
    purl: componentRef(node),
    scope: "required",
    licenses: [
      /\b(?:AND|OR|WITH)\b|[()]/u.test(node.license)
        ? { expression: node.license }
        : { license: { id: node.license } }
    ],
    ...(node.name === EXPECTED_PACKAGE_NAME
      ? { hashes: [{ alg: "SHA-256", content: tarballDigest }] }
      : {}),
    properties: [
      {
        name: "pi-leetcode-tools:installed-occurrences",
        value: String(occurrenceCount)
      }
    ]
  };
}

function deterministicUuid(hexDigest) {
  const value = hexDigest.slice(0, 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16], 16) & 0x3) | 0x8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createSbom({ tree, tarballDigest, npmVersion }) {
  const aggregates = new Map();
  for (const node of tree.nodes.values()) {
    const identity = componentIdentity(node);
    const existing = aggregates.get(identity);
    if (existing === undefined) {
      aggregates.set(identity, { node, occurrences: 1, dependencies: new Set() });
    } else {
      assert(
        existing.node.license === node.license,
        `Conflicting license metadata for ${node.name}@${node.version}`
      );
      existing.occurrences += 1;
    }
  }
  for (const node of tree.nodes.values()) {
    const aggregate = aggregates.get(componentIdentity(node));
    for (const dependencyDirectory of node.dependencies) {
      const dependency = tree.nodes.get(dependencyDirectory);
      assert(dependency !== undefined, `Missing dependency node: ${dependencyDirectory}`);
      aggregate.dependencies.add(componentRef(dependency));
    }
  }

  const root = tree.nodes.get(tree.rootDirectory);
  assert(root !== undefined, "Production tree root is missing");
  const rootAggregate = aggregates.get(componentIdentity(root));
  const components = [...aggregates.values()]
    .filter((aggregate) => aggregate.node !== root)
    .sort((left, right) => componentRef(left.node).localeCompare(componentRef(right.node)))
    .map((aggregate) =>
      cycloneComponent(aggregate.node, aggregate.occurrences, tarballDigest)
    );
  const dependencies = [...aggregates.values()]
    .sort((left, right) => componentRef(left.node).localeCompare(componentRef(right.node)))
    .map((aggregate) => ({
      ref: componentRef(aggregate.node),
      dependsOn: [...aggregate.dependencies].sort()
    }));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${deterministicUuid(tarballDigest)}`,
    version: 1,
    metadata: {
      tools: {
        components: [
          { type: "application", name: "node", version: process.version },
          { type: "application", name: "npm", version: npmVersion }
        ]
      },
      component: cycloneComponent(root, rootAggregate.occurrences, tarballDigest)
    },
    components,
    dependencies
  };
}

async function workflowFiles(directory) {
  const files = [];
  if (!(await pathExists(directory))) {
    return files;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workflowFiles(path)));
    } else if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

async function verifyPinnedActions() {
  const directory = join(REPOSITORY_ROOT, ".github", "workflows");
  const actions = [];
  for (const file of await workflowFiles(directory)) {
    const text = await readFile(file, "utf8");
    for (const [index, line] of text.split(/\r?\n/gu).entries()) {
      const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/u.exec(line);
      if (match === null) {
        continue;
      }
      const specifier = match[1];
      if (specifier.startsWith("./") || specifier.startsWith("docker://")) {
        continue;
      }
      const separator = specifier.lastIndexOf("@");
      assert(separator > 0, `${portablePath(relative(REPOSITORY_ROOT, file))}:${index + 1} has an invalid action reference`);
      const action = specifier.slice(0, separator);
      const revision = specifier.slice(separator + 1);
      assert(
        FULL_COMMIT_SHA.test(revision),
        `${portablePath(relative(REPOSITORY_ROOT, file))}:${index + 1} must pin ${action} to a full commit SHA`
      );
      actions.push({
        workflow: portablePath(relative(REPOSITORY_ROOT, file)),
        line: index + 1,
        action,
        revision: revision.toLowerCase()
      });
    }
  }
  assert(actions.length > 0, "No pinned CI actions were found");
  assert(actions.some(({ action }) => action === "actions/checkout"), "CI must pin actions/checkout");
  assert(actions.some(({ action }) => action === "actions/setup-node"), "CI must pin actions/setup-node");
  return actions;
}

async function sourceRevision() {
  if (process.env.GITHUB_ACTIONS === "true") {
    assert(FULL_COMMIT_SHA.test(process.env.GITHUB_SHA ?? ""), "GITHUB_SHA must be a full commit SHA in CI");
    return { revision: process.env.GITHUB_SHA.toLowerCase(), source: "GITHUB_SHA" };
  }
  try {
    const { stdout } = await runCommand("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT
    });
    const revision = stdout.trim();
    return FULL_COMMIT_SHA.test(revision)
      ? { revision: revision.toLowerCase(), source: "git" }
      : { revision: null, source: "unavailable" };
  } catch {
    return { revision: null, source: "unavailable" };
  }
}

function assertNoNpmProblems(value, allowedProblems, path = "npm-ls") {
  assert(value !== null && typeof value === "object", `${path} is not an object`);
  const unexpectedProblems = Array.isArray(value.problems)
    ? value.problems.filter((problem) => !allowedProblems.has(problem))
    : [];
  assert(
    unexpectedProblems.length === 0,
    `${path} reports: ${unexpectedProblems.join("; ")}`
  );
  for (const [name, dependency] of Object.entries(value.dependencies ?? {})) {
    assertNoNpmProblems(dependency, allowedProblems, `${path} > ${name}`);
  }
}

async function verifyActualProductionTree(tarball, packageName, packageVersion, tarballDigest) {
  const npmCli = process.env.npm_execpath;
  assert(
    typeof npmCli === "string" && npmCli.length > 0,
    "Supply-chain verification must be launched through an npm script; npm CLI discovery is fail-closed"
  );
  assert(await pathExists(npmCli), `npm CLI does not exist: ${npmCli}`);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-tools-supply-chain-"));
  const installDirectory = join(temporaryDirectory, "install");
  const npmCache = join(temporaryDirectory, "npm-cache");
  const piDirectory = join(temporaryDirectory, "pi");
  const npmUserConfig = join(temporaryDirectory, "user.npmrc");
  const npmGlobalConfig = join(temporaryDirectory, "global.npmrc");
  await Promise.all([
    mkdir(installDirectory, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(piDirectory, { recursive: true }),
    writeFile(npmUserConfig, "", "utf8"),
    writeFile(npmGlobalConfig, "", "utf8"),
    writeFile(
      join(installDirectory, "package.json"),
      `${JSON.stringify({ name: "pi-leetcode-tools-release-probe", version: "0.0.0", private: true }, null, 2)}\n`,
      "utf8"
    )
  ]);

  const isolatedEnvironment = {
    ...process.env,
    NODE_PATH: "",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    PI_CODING_AGENT_DIR: piDirectory
  };

  try {
    const { stdout: npmVersionOutput } = await runCommand(
      process.execPath,
      [npmCli, "--version"],
      { env: isolatedEnvironment }
    );
    const npmVersion = npmVersionOutput.trim();
    assert(npmVersion.length > 0, "npm did not report a version");

    await runCommand(
      process.execPath,
      [
        npmCli,
        "install",
        "--prefix",
        installDirectory,
        "--save-exact",
        "--strict-peer-deps",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=peer",
        "--package-lock=true",
        "--no-audit",
        "--no-fund",
        tarball
      ],
      { stdio: "inherit", env: isolatedEnvironment }
    );

    const packageDirectory = join(installDirectory, "node_modules", ...packageSegments(packageName));
    const installedManifest = await readJson(join(packageDirectory, "package.json"));
    assert(installedManifest.version === packageVersion, "Actual production install version does not match tarball");

    const expectedHostPeerProblems = new Set(
      Object.entries(HOST_PEER_DEPENDENCIES).map(
        ([name, specifier]) =>
          `missing: ${name}@${specifier}, required by ${packageName}@${packageVersion}`
      )
    );
    const { stdout: npmLsOutput } = await runCommand(
      process.execPath,
      [
        npmCli,
        "ls",
        "--prefix",
        installDirectory,
        "--omit=dev",
        "--omit=peer",
        "--all",
        "--json"
      ],
      { acceptedExitCodes: [0, 1], env: isolatedEnvironment }
    );
    const npmLs = JSON.parse(npmLsOutput);
    assert(
      JSON.stringify([...(npmLs.problems ?? [])].sort()) ===
        JSON.stringify([...expectedHostPeerProblems].sort()),
      `npm ls did not report exactly the omitted host peers: ${JSON.stringify(npmLs.problems ?? [])}`
    );
    assertNoNpmProblems(npmLs, expectedHostPeerProblems);
    assert(
      npmLs.dependencies?.[packageName]?.version === packageVersion,
      "npm ls does not contain the installed release artifact"
    );
    for (const name of Object.keys(HOST_PEER_DEPENDENCIES)) {
      assert(
        npmLs.dependencies?.[packageName]?.dependencies?.[name]?.missing === true,
        `npm ls did not classify the omitted host peer as missing: ${name}`
      );
    }

    const { stdout: npmAuditOutput } = await runCommand(
      process.execPath,
      [
        npmCli,
        "audit",
        "--prefix",
        installDirectory,
        "--omit=dev",
        "--omit=peer",
        "--audit-level=low",
        "--json"
      ],
      { env: { ...isolatedEnvironment, NPM_CONFIG_AUDIT: "true" } }
    );
    const npmAudit = JSON.parse(npmAuditOutput);
    const vulnerabilityCounts = npmAudit.metadata?.vulnerabilities;
    assert(
      vulnerabilityCounts !== undefined && vulnerabilityCounts.total === 0,
      `Production dependency audit found vulnerabilities: ${JSON.stringify(vulnerabilityCounts)}`
    );

    const tree = await inspectProductionTree(installDirectory, packageDirectory);
    const sbom = createSbom({ tree, tarballDigest, npmVersion });
    const licenseInventory = [...tree.nodes.values()]
      .map((node) => ({ name: node.name, version: node.version, license: node.license }))
      .sort((left, right) =>
        `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
      );
    const uniqueComponents = new Set(
      [...tree.nodes.values()].map((node) => componentIdentity(node))
    );
    const graphEvidence = [...tree.nodes.values()]
      .map((node) => ({
        name: node.name,
        version: node.version,
        license: node.license,
        dependencies: [...node.dependencies]
          .map((directory) => {
            const dependency = tree.nodes.get(directory);
            assert(dependency !== undefined, `Missing dependency for evidence: ${directory}`);
            return `${dependency.name}@${dependency.version}`;
          })
          .sort()
      }))
      .sort((left, right) =>
        `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
      );

    return {
      npmVersion,
      sbom,
      npmLsDigest: sha256CanonicalJson(npmLs),
      npmAuditDigest: sha256CanonicalJson(npmAudit),
      vulnerabilityCounts,
      productionTreeDigest: sha256CanonicalJson(graphEvidence),
      installedOccurrences: tree.nodes.size,
      uniqueComponents: uniqueComponents.size,
      hostPeerDependencies: tree.hostPeerDependencies,
      licenseInventory
    };
  } finally {
    if (process.env.PI_LEETCODE_KEEP_VERIFY_TEMP === "1") {
      console.log(`Supply-chain verification retained at ${temporaryDirectory}`);
    } else {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      });
    }
  }
}

const tarball = await resolveTarball();
const tarballBytes = await readFile(tarball);
const tarballDigest = sha256(tarballBytes);
const tarballSha512 = `sha512:${sha512(tarballBytes)}`;
const tarballIntegrity = sha512Integrity(tarballBytes);
const tarballStat = await stat(tarball);

const packedEvidence = await withExtractedPackage(tarball, async ({ packageDirectory }) => {
  const manifest = await readJson(join(packageDirectory, "package.json"));
  assert(manifest.name === EXPECTED_PACKAGE_NAME, `Unexpected package name: ${manifest.name}`);
  assert(typeof manifest.version === "string" && manifest.version.length > 0, "Package version is missing");
  assert(await pathExists(join(packageDirectory, "SECURITY.md")), "Final tarball is missing SECURITY.md");
  const securityBytes = await readFile(join(packageDirectory, "SECURITY.md"));
  assert(securityBytes.length > 0, "Packed SECURITY.md is empty");
  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    contractManifest: await readJson(join(packageDirectory, "contract", "manifest.json")),
    securityDocumentSha256: sha256(securityBytes),
    secretScan: await scanPackedSecrets(packageDirectory)
  };
});

const [production, ciActions, revision] = await Promise.all([
  verifyActualProductionTree(
    tarball,
    packedEvidence.packageName,
    packedEvidence.packageVersion,
    tarballDigest
  ),
  verifyPinnedActions(),
  sourceRevision()
]);

const artifactDirectory = dirname(tarball);
const sbomPath = join(artifactDirectory, SBOM_FILE_NAME);
const evidencePath = join(artifactDirectory, EVIDENCE_FILE_NAME);
const activationEvidencePath = join(
  artifactDirectory,
  PI_ACTIVATION_EVIDENCE_FILE_NAME
);
assert(
  await pathExists(activationEvidencePath),
  `Missing independent Pi activation evidence: ${activationEvidencePath}`
);
const piActivation = await readJson(activationEvidencePath);
assert(
  piActivation.evidenceType === "pi-package-activation",
  "Pi activation evidence has an unexpected type"
);
assert(
  piActivation.subject?.name === packedEvidence.packageName &&
    piActivation.subject?.version === packedEvidence.packageVersion &&
    piActivation.subject?.file === basename(tarball) &&
    piActivation.subject?.bytes === tarballStat.size,
  "Pi activation evidence subject does not match the release artifact"
);
assert(
  piActivation.subject?.sha512 === tarballSha512 &&
    piActivation.subject?.distIntegrity === tarballIntegrity,
  "Pi activation evidence is not bound to the release artifact bytes"
);
assert(
  piActivation.registry?.mode === "closed-allowlist" &&
    piActivation.registry?.upstreamFallbackAllowed === false &&
    piActivation.registry?.unexpectedRequests === 0,
  "Pi activation did not use a closed registry allowlist"
);
assert(
  piActivation.installation?.candidateTarballSha512 === tarballSha512 &&
    piActivation.installation?.candidatePackageContentDigest ===
      piActivation.installation?.installedPackageContentDigest,
  "Pi activation installed artifact is not bound to the candidate tarball"
);
for (const field of [
  "contractVersion",
  "protocolVersion",
  "schemaDigest",
  "behaviorDigestAlgorithm",
  "behaviorManifestDigest",
  "capabilityManifestDigest"
]) {
  assert(
    piActivation.contract?.[field] === packedEvidence.contractManifest[field],
    `Pi activation contract ${field} does not match the packed manifest`
  );
}
const sbomText = `${JSON.stringify(production.sbom, null, 2)}\n`;
await writeFile(sbomPath, sbomText, "utf8");
const sbomDigest = sha256(sbomText);

const evidence = {
  schemaVersion: SECURITY_GATE_VERSION,
  evidenceType: "release-supply-chain",
  generatedAt: new Date().toISOString(),
  subject: {
    name: packedEvidence.packageName,
    version: packedEvidence.packageVersion,
    file: basename(tarball),
    bytes: tarballStat.size,
    sha256: tarballDigest,
    sha512: tarballSha512,
    distIntegrity: tarballIntegrity
  },
  source: revision,
  environment: {
    node: process.version,
    npm: production.npmVersion,
    platform: process.platform,
    arch: process.arch
  },
  securityDocument: {
    path: "SECURITY.md",
    sha256: packedEvidence.securityDocumentSha256
  },
  secretScan: packedEvidence.secretScan,
  productionTree: {
    evidenceScope: "pi-package-owned-production-closure",
    isPiPackageActivationEvidence: false,
    lifecycleScripts: "disabled",
    hostPeers: {
      disposition: "validated-and-omitted-from-package-owned-closure",
      dependencies: production.hostPeerDependencies
    },
    npmLsDigest: production.npmLsDigest,
    digest: production.productionTreeDigest,
    installedOccurrences: production.installedOccurrences,
    uniqueComponents: production.uniqueComponents
  },
  vulnerabilityGate: {
    evidenceScope: "pi-package-owned-production-tree-audit",
    isPiPackageActivationEvidence: false,
    audit: "npm audit --omit=dev --omit=peer --audit-level=low",
    counts: production.vulnerabilityCounts,
    reportDigest: production.npmAuditDigest
  },
  licenseGate: {
    policy: "explicit-permissive-allowlist",
    allowedSpdxIdentifiers: [...ALLOWED_LICENSES].sort(),
    allowedExceptions: [...ALLOWED_LICENSE_EXCEPTIONS].sort(),
    inheritedLicenseTextPolicies: INHERITED_LICENSE_TEXT_PACKAGES.map((policy) => ({
      packagePattern: policy.packagePattern.source,
      sourcePackage: policy.sourcePackage,
      license: policy.license,
      repository: policy.repository
    })),
    inventory: production.licenseInventory
  },
  ciActions,
  piActivation,
  artifacts: {
    sbom: {
      file: SBOM_FILE_NAME,
      format: "CycloneDX",
      specVersion: "1.5",
      sha256: sbomDigest
    }
  }
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(
  [
    `Release supply chain verified: ${packedEvidence.packageName}@${packedEvidence.packageVersion}`,
    `Tarball SHA-256: ${tarballDigest}`,
    `Production components: ${production.uniqueComponents} unique (${production.installedOccurrences} installed occurrences)`,
    `Secret scan: ${packedEvidence.secretScan.filesScanned} files, 0 findings`,
    `SBOM: ${sbomPath}`,
    `Evidence: ${evidencePath}`
  ].join("\n")
);
