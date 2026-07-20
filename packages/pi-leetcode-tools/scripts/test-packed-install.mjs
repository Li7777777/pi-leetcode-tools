import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  createNoAccountEnvironment,
  pathExists,
  readJson,
  resolveTarball,
  runCommand,
  withExtractedPackage
} from "./release-utils.mjs";

const tarball = await resolveTarball();
const sourcePackageJson = await withExtractedPackage(tarball, ({ packageDirectory }) =>
  readJson(join(packageDirectory, "package.json"))
);
const packageName = sourcePackageJson.name;
assert(typeof packageName === "string" && packageName.length > 0, "Package name is missing");

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-tools-install-"));
const installDirectory = join(temporaryDirectory, "install");
const npmCache = join(temporaryDirectory, "npm-cache");
const piDirectory = join(temporaryDirectory, "pi");
const npmUserConfig = join(temporaryDirectory, "npmrc");

try {
  await Promise.all([
    mkdir(installDirectory, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(piDirectory, { recursive: true }),
    writeFile(npmUserConfig, "", "utf8")
  ]);
  const npmCli = process.env.npm_execpath;
  assert(
    typeof npmCli === "string" && npmCli.length > 0,
    "Packed install verification must be launched through an npm script"
  );
  await runCommand(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      installDirectory,
      "--legacy-peer-deps",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      tarball
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_PATH: "",
        NPM_CONFIG_CACHE: npmCache,
        NPM_CONFIG_USERCONFIG: npmUserConfig,
        PI_CODING_AGENT_DIR: piDirectory
      }
    }
  );

  const packageSegments = packageName.split("/");
  const installedPackageDirectory = join(
    installDirectory,
    "node_modules",
    ...packageSegments
  );
  assert(
    await pathExists(join(installedPackageDirectory, "package.json")),
    "npm did not install the packed package"
  );

  const installedPackageJson = await readJson(join(installedPackageDirectory, "package.json"));
  assert(
    installedPackageJson.version === sourcePackageJson.version,
    "Installed package version does not match the tarball"
  );
  assert(
    !(await pathExists(
      join(installDirectory, "node_modules", "@earendil-works", "pi-coding-agent")
    )),
    "Packed install pulled a second Pi runtime into its module root"
  );
  assert(
    !(await pathExists(join(installDirectory, "node_modules", "typebox"))),
    "Packed install pulled a second typebox runtime into its module root"
  );
  assert(
    installedPackageJson.bin?.["pi-leetcode"] === "./dist/src/cli.js",
    "Packed package does not expose the expected pi-leetcode CLI"
  );

  // Pi packages deliberately keep the host runtime and typebox as peers. The
  // isolated npm install above first proves neither peer was copied into the
  // candidate's production tree; these junctions then model the peer surface
  // supplied by a real Pi host for module-loading probes.
  for (const name of ["@earendil-works/pi-coding-agent", "typebox"]) {
    const source = fileURLToPath(
      new URL(`../../../node_modules/${name}/`, import.meta.url)
    );
    const target = join(installDirectory, "node_modules", ...name.split("/"));
    assert(await pathExists(source), `Host peer fixture is missing: ${name}`);
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  }

  const probe = String.raw`
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { isAbsolute, relative, resolve } from "node:path";
    import { pathToFileURL } from "node:url";

    const packageName = process.argv[1];
    const packageDirectory = process.argv[2];
    const packageJson = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8"));
    const manifest = JSON.parse(
      await readFile(resolve(packageDirectory, "contract", "manifest.json"), "utf8")
    );

    const contract = await import(packageName + "/contract");
    await import(packageName + "/types");
    assert.equal(contract.PACKAGE_NAME, packageJson.name);
    assert.equal(contract.PACKAGE_VERSION, packageJson.version);
    assert.equal(contract.CONTRACT_VERSION, manifest.contractVersion);
    assert.equal(contract.PROTOCOL_VERSION, manifest.protocolVersion);
    assert.equal(contract.SCHEMA_DIGEST, manifest.schemaDigest);
    assert.equal(
      contract.DIGEST_CANONICALIZATION + "+" + contract.DIGEST_ENCODING + "+" + contract.DIGEST_ALGORITHM,
      manifest.behaviorDigestAlgorithm
    );
    assert.equal(contract.BEHAVIOR_MANIFEST_DIGEST, manifest.behaviorManifestDigest);
    assert.deepEqual(contract.BEHAVIOR_MANIFEST, manifest.behaviorManifest);
    assert.equal(contract.CAPABILITY_MANIFEST_DIGEST, manifest.capabilityManifestDigest);
    assert.equal(contract.DISCOVERY_CHANNEL, manifest.discoveryChannel);
    assert.equal(contract.RPC_CHANNEL, manifest.rpcChannel);
    assert.deepEqual([...contract.TOOL_NAMES], manifest.tools);

    for (const specifier of [
      packageName,
      packageName + "/tools",
      packageName + "/dist/src/leetcode/default-client.js"
    ]) {
      try {
        await import(specifier);
        assert.fail("Internal package path was exported: " + specifier);
      } catch (error) {
        assert.equal(error?.code, "ERR_PACKAGE_PATH_NOT_EXPORTED", String(error));
      }
    }

    const registeredTools = [];
    const emittedChannels = [];
    const lifecycleHandlers = new Map();
    const fakePi = {
      events: {
        emit(channel) {
          emittedChannels.push(channel);
        },
        on() {
          return () => {};
        }
      },
      registerTool(tool) {
        registeredTools.push(tool);
      },
      getAllTools() {
        return registeredTools;
      },
      on(event, handler) {
        lifecycleHandlers.set(event, handler);
      }
    };

    assert.ok(Array.isArray(packageJson.pi?.extensions));
    assert.ok(packageJson.pi.extensions.length > 0);
    for (const extensionPath of packageJson.pi.extensions) {
      const entry = resolve(packageDirectory, extensionPath);
      const relativeEntry = relative(packageDirectory, entry);
      assert.ok(
        relativeEntry !== "" && !relativeEntry.startsWith("..") && !isAbsolute(relativeEntry),
        "Extension path escapes package root"
      );
      const extension = await import(pathToFileURL(entry).href);
      assert.equal(typeof extension.default, "function");
      await extension.default(fakePi);
    }

    assert.deepEqual(
      registeredTools,
      [],
      "Extension factory registered tools before Pi bound its session APIs"
    );
    const sessionStart = lifecycleHandlers.get("session_start");
    const sessionShutdown = lifecycleHandlers.get("session_shutdown");
    assert.equal(typeof sessionStart, "function");
    assert.equal(typeof sessionShutdown, "function");

    const context = {
      cwd: process.cwd(),
      hasUI: false,
      ui: {
        notify() {},
        confirm: async () => false
      }
    };
    try {
      await sessionStart({ type: "session_start", reason: "startup" }, context);
      assert.deepEqual(registeredTools.map((tool) => tool.name), [...contract.TOOL_NAMES]);
      for (const tool of registeredTools) {
        assert.equal(tool.parameters?.type, "object", tool.name + " parameter root is not an object");
        for (const keyword of ["anyOf", "oneOf", "allOf", "not"]) {
          assert.equal(
            tool.parameters?.[keyword],
            undefined,
            tool.name + " parameter root uses unsupported " + keyword
          );
        }
      }
      assert.ok(
        emittedChannels.includes("pi-leetcode-tools:ready:v1"),
        "Extension registered tools but did not activate its Gateway"
      );
    } finally {
      await sessionShutdown({ type: "session_shutdown", reason: "quit" }, context);
    }
  `;

  const { environment: noAccountEnvironment } = createNoAccountEnvironment();
  Object.assign(noAccountEnvironment, {
    NODE_PATH: "",
    PI_CODING_AGENT_DIR: piDirectory
  });

  await runCommand(
    process.execPath,
    ["--input-type=module", "--eval", probe, packageName, installedPackageDirectory],
    {
      cwd: installDirectory,
      env: noAccountEnvironment
    }
  );

  const installedCli = join(installedPackageDirectory, "dist", "src", "cli.js");
  const cliEnvironment = { ...noAccountEnvironment };
  const cliHelp = await runCommand(
    process.execPath,
    [installedCli, "--help"],
    {
      cwd: installDirectory,
      env: cliEnvironment
    }
  );
  for (const command of ["login", "import", "status", "list", "use", "logout", "doctor"]) {
    assert(
      cliHelp.stdout.includes(`auth ${command}`),
      `Packed CLI help is missing auth ${command}`
    );
  }

  let invalidRegionFailure;
  try {
    await runCommand(
      process.execPath,
      [installedCli, "auth", "login", "--region", "invalid"],
      {
        cwd: installDirectory,
        env: cliEnvironment
      }
    );
  } catch (error) {
    invalidRegionFailure = error;
  }
  assert(invalidRegionFailure instanceof Error, "Packed CLI accepted an invalid auth region");
  assert(
    invalidRegionFailure.message.includes("[auth_region_invalid]"),
    "Packed CLI did not emit the stable auth_region_invalid reason code"
  );

  console.log(
    `Packed install verified: ${packageName}@${installedPackageJson.version} loads without workspace dependencies`
  );
} finally {
  if (process.env.PI_LEETCODE_KEEP_VERIFY_TEMP === "1") {
    console.log(`Packed install retained at ${temporaryDirectory}`);
  } else {
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    });
  }
}
