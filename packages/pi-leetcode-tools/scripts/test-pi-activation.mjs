import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startClosedRegistry } from "./closed-registry.mjs";
import {
  assert,
  assertJcsGoldenVectors,
  createNoAccountEnvironment,
  digestPackageFiles,
  JCS_DIGEST_ALGORITHM,
  pathExists,
  readJson,
  resolveTarball,
  runCommand,
  sha256Jcs,
  terminateProcessTree,
  withExtractedPackage
} from "./release-utils.mjs";

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = resolve(dirname(piEntry), "cli.js");
const piPackageJson = await readJson(resolve(dirname(piEntry), "..", "package.json"));
const tarball = await resolveTarball();
const { manifest, packedPackageJson, candidateContent } = await withExtractedPackage(
  tarball,
  async ({ packageDirectory }) => ({
    manifest: await readJson(join(packageDirectory, "contract", "manifest.json")),
    packedPackageJson: await readJson(join(packageDirectory, "package.json")),
    candidateContent: await digestPackageFiles(packageDirectory)
  })
);
const tarballBytes = await readFile(tarball);
assertJcsGoldenVectors();

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-tools-activation-"));
const agentDirectory = join(temporaryDirectory, "agent");
const npmCache = join(temporaryDirectory, "npm-cache");
const npmUserConfig = join(temporaryDirectory, "npmrc");
const workingDirectory = join(temporaryDirectory, "workspace");
const probeExtension = join(temporaryDirectory, "probe-extension.mjs");
const probeResult = join(temporaryDirectory, "probe-result.json");
const activationEvidence = join(
  dirname(tarball),
  "pi-leetcode-tools-pi-activation-evidence.json"
);
let registry;
let child;
let childExit;

try {
  await rm(activationEvidence, { force: true });
  await Promise.all([
    mkdir(agentDirectory, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(workingDirectory, { recursive: true }),
    writeFile(npmUserConfig, "audit=false\nfund=false\n", "utf8")
  ]);

const expectedTools = manifest.tools;
assert(Array.isArray(expectedTools) && expectedTools.length > 0, "Contract has no tools");
assert(
  manifest.behaviorDigestAlgorithm === JCS_DIGEST_ALGORITHM,
  "Packed manifest does not declare the fixed behavior digest algorithm"
);
assert(
  sha256Jcs(manifest.behaviorManifest) === manifest.behaviorManifestDigest,
  "Packed behavior manifest digest is invalid"
);

const probeSource = `
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

const DISCOVERY_CHANNEL = ${JSON.stringify(manifest.discoveryChannel)};
const RPC_CHANNEL = ${JSON.stringify(manifest.rpcChannel)};
const READY_CHANNEL = "pi-leetcode-tools:ready:v1";
const PROTOCOL_VERSION = ${JSON.stringify(manifest.protocolVersion)};
const RESULT_PATH = process.env.PI_LEETCODE_PROBE_RESULT;

export default function probeExtension(pi) {
  let settled = false;
  let verifying = false;
  let readyUnsubscribe;

  async function finish(payload) {
    if (settled) return;
    settled = true;
    readyUnsubscribe?.();
    const temporaryPath = RESULT_PATH + ".tmp-" + randomUUID();
    await writeFile(temporaryPath, JSON.stringify(payload), "utf8");
    await rename(temporaryPath, RESULT_PATH);
  }

  async function verifyActivation(response) {
    const descriptor = response.descriptor;
    const requestId = "activation-diagnostics-" + randomUUID();
    const diagnosticsResponse = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("diagnostics RPC timed out")),
        10_000
      );
      pi.events.emit(RPC_CHANNEL, {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        providerId: descriptor.providerId,
        instanceId: descriptor.instanceId,
        contextRevision: descriptor.contextRevision,
        method: "diagnostics.getSnapshot",
        params: {},
        deadlineAt: Date.now() + 10_000,
        respond(rpcResponse) {
          if (rpcResponse?.requestId !== requestId) return;
          clearTimeout(timeout);
          resolve(rpcResponse);
        }
      });
    });
    if (diagnosticsResponse?.result?.ok !== true) {
      throw new Error(
        "diagnostics RPC failed: " +
          (diagnosticsResponse?.result?.error?.code ?? "MALFORMED_RESULT")
      );
    }
    const allTools = pi.getAllTools().map((tool) => tool.name).sort();
    const activeTools = [...pi.getActiveTools()].sort();
    await finish({
      ok: true,
      responseProtocolVersion: response.protocolVersion,
      descriptor,
      diagnostics: diagnosticsResponse.result.data,
      allTools,
      activeTools
    });
  }

  function discover() {
    if (settled || verifying) return;
    const requestId = "activation-probe-" + randomUUID();
    pi.events.emit(DISCOVERY_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      respond(response) {
        if (settled || verifying || response?.requestId !== requestId) return;
        verifying = true;
        void verifyActivation(response).catch((error) =>
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
        );
      }
    });
  }

  readyUnsubscribe = pi.events.on(READY_CHANNEL, discover);
  pi.on("session_start", () => {
    void (async () => {
      for (let attempt = 0; attempt < 100 && !settled; attempt += 1) {
        discover();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!settled) {
        await finish({ ok: false, error: "provider discovery timed out" });
      }
    })().catch((error) =>
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
  });

  pi.on("session_shutdown", () => {
    readyUnsubscribe?.();
  });
}
`;
  await writeFile(probeExtension, probeSource, "utf8");
  registry = await startClosedRegistry({
    candidateTarball: tarball,
    candidatePackageJson: packedPackageJson,
    candidateBytes: tarballBytes,
    directory: temporaryDirectory
  });
  const registryOrigin = registry.origin;
  const independentlyComputedIntegrity = `sha512-${createHash("sha512")
    .update(tarballBytes)
    .digest("base64")}`;
  assert(
    registry.candidateIntegrity === independentlyComputedIntegrity,
    "Closed registry dist.integrity is not bound to the candidate tarball"
  );
  await writeFile(
    npmUserConfig,
    `registry=${registryOrigin}\naudit=false\nfund=false\nupdate-notifier=false\n`,
    "utf8"
  );

  const {
    environment: baseEnvironment,
    profileId: noAccountProfileId
  } = createNoAccountEnvironment();
  Object.assign(baseEnvironment, {
    NODE_PATH: "",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_REGISTRY: registryOrigin,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_TELEMETRY: "0"
  });

  const packageSpec = `npm:${manifest.packageName}@${manifest.packageVersion}`;
  await runCommand(process.execPath, [piCli, "install", packageSpec], {
    cwd: workingDirectory,
    stdio: "inherit",
    env: baseEnvironment
  });
  registry.assertNoUnexpectedRequests();

  const installedPackageDirectory = join(
    agentDirectory,
    "npm",
    "node_modules",
    ...manifest.packageName.split("/")
  );
  const installedPackageJson = await readJson(
    join(installedPackageDirectory, "package.json")
  );
  assert(
    installedPackageJson.name === manifest.packageName &&
      installedPackageJson.version === manifest.packageVersion,
    "Pi installed package identity does not match the candidate tarball"
  );
  const installedContent = await digestPackageFiles(
    installedPackageDirectory,
    candidateContent.files.map((file) => file.path)
  );
  assert(
    installedContent.digest === candidateContent.digest,
    "Pi installed package files do not match the candidate tarball"
  );

  const listResult = await runCommand(process.execPath, [piCli, "list"], {
    cwd: workingDirectory,
    env: baseEnvironment
  });
  assert(
    listResult.stdout.includes(`${manifest.packageName}@${manifest.packageVersion}`) ||
      listResult.stdout.includes(manifest.packageName),
    "Pi list does not show the installed package"
  );

  const args = [
    piCli,
    "--mode",
    "rpc",
    "--no-session",
    "--offline",
    "--no-builtin-tools",
    "--tools",
    expectedTools.join(","),
    "--extension",
    probeExtension,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--approve"
  ];
  child = spawn(process.execPath, args, {
    cwd: workingDirectory,
    env: {
      ...baseEnvironment,
      PI_OFFLINE: "1",
      PI_LEETCODE_PROBE_RESULT: probeResult
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  childExit = new Promise((resolvePromise) => child.once("exit", resolvePromise));

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-65_536);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-65_536);
  });

  const deadline = Date.now() + 20_000;
  while (!(await pathExists(probeResult)) && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Pi RPC process exited before activation evidence (code ${child.exitCode})\n${stderr}\n${stdout}`
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert(await pathExists(probeResult), `Pi activation probe timed out\n${stderr}\n${stdout}`);

  const result = JSON.parse(await readFile(probeResult, "utf8"));
  assert(result.ok === true, `Pi activation probe failed: ${String(result.error)}`);
  assert(
    result.responseProtocolVersion === manifest.protocolVersion,
    "Discovery response protocolVersion does not match the packed manifest"
  );
  for (const field of [
    "packageName",
    "packageVersion",
    "contractVersion",
    "schemaDigest",
    "behaviorManifestDigest",
    "capabilityManifestDigest"
  ]) {
    assert(
      result.descriptor?.[field] === manifest[field],
      `Provider descriptor ${field} does not match the packed manifest`
    );
  }
  assert(
    result.descriptor?.protocolVersion === manifest.protocolVersion,
    "Provider descriptor protocolVersion does not match the packed manifest"
  );
  assert(
    result.diagnostics?.providerId === result.descriptor.providerId &&
      result.diagnostics?.instanceId === result.descriptor.instanceId &&
      result.diagnostics?.providerConflict === false &&
      typeof result.diagnostics?.storageWritable === "boolean" &&
      typeof result.diagnostics?.regions?.global === "object" &&
      typeof result.diagnostics?.regions?.cn === "object",
    "Installed provider did not expose a safe diagnostics snapshot"
  );
  assert(
    baseEnvironment.PI_LEETCODE_PROFILE_ID === noAccountProfileId &&
      result.descriptor?.activeAccountProfileId === undefined &&
      result.diagnostics?.activeAccountProfileId === undefined &&
      result.diagnostics?.regions?.global?.configured === false &&
      result.diagnostics?.regions?.global?.sessionConfigured === false &&
      result.diagnostics?.regions?.global?.operationConfigured === false &&
      result.diagnostics?.regions?.cn?.configured === false &&
      result.diagnostics?.regions?.cn?.sessionConfigured === false &&
      result.diagnostics?.regions?.cn?.operationConfigured === false &&
      result.diagnostics?.regions?.global?.queueDepth === 0 &&
      result.diagnostics?.regions?.cn?.queueDepth === 0,
    "Pi activation observed configured credentials or authenticated activity"
  );
  assert(
    JSON.stringify(result.allTools.filter((name) => expectedTools.includes(name)).sort()) ===
      JSON.stringify([...expectedTools].sort()),
    "The installed Extension did not register every packed tool"
  );
  assert(
    !result.allTools.includes("diagnostics.getSnapshot"),
    "Non-model diagnostics RPC was incorrectly registered as a model tool"
  );
  assert(
    JSON.stringify(result.activeTools.filter((name) => expectedTools.includes(name)).sort()) ===
      JSON.stringify([...expectedTools].sort()),
    "The packed tools were not all active in the new Pi session"
  );

  registry.assertNoUnexpectedRequests();
  const installedArtifacts = Object.fromEntries(
    installedContent.files
      .filter((file) =>
        [
          "package.json",
          "contract/manifest.json",
          "contract/schema.json",
          "contract/capabilities.json"
        ].includes(file.path)
      )
      .map((file) => [file.path, { bytes: file.size, sha256: file.sha256 }])
  );
  const evidence = {
    schemaVersion: "1.0.0",
    evidenceType: "pi-package-activation",
    generatedAt: new Date().toISOString(),
    subject: {
      name: manifest.packageName,
      version: manifest.packageVersion,
      file: basename(tarball),
      bytes: tarballBytes.length,
      sha512: registry.candidateSha512,
      distIntegrity: registry.candidateIntegrity
    },
    registry: {
      origin: registryOrigin,
      mode: "closed-allowlist",
      upstreamFallbackAllowed: false,
      prefetchedPackages: registry.prefetchedPackages,
      requests: registry.requests.length,
      unexpectedRequests: 0
    },
    installation: {
      installer: "pi install",
      packageSpec,
      packageName: installedPackageJson.name,
      packageVersion: installedPackageJson.version,
      candidateTarballSha512: registry.candidateSha512,
      candidatePackageContentDigest: candidateContent.digest,
      installedPackageContentDigest: installedContent.digest,
      artifacts: installedArtifacts
    },
    contract: {
      contractVersion: manifest.contractVersion,
      protocolVersion: manifest.protocolVersion,
      schemaDigest: manifest.schemaDigest,
      behaviorDigestAlgorithm: manifest.behaviorDigestAlgorithm,
      behaviorManifestDigest: manifest.behaviorManifestDigest,
      capabilityManifestDigest: manifest.capabilityManifestDigest
    },
    activation: {
      piVersion: piPackageJson.version,
      providerId: result.descriptor.providerId,
      instanceId: result.descriptor.instanceId,
      diagnostics: result.diagnostics,
      registeredTools: result.allTools,
      activeTools: result.activeTools
    }
  };
  const temporaryEvidence = `${activationEvidence}.tmp`;
  await writeFile(temporaryEvidence, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await rename(temporaryEvidence, activationEvidence);

  console.log(
    `Pi activation verified: ${manifest.packageName}@${manifest.packageVersion}, ${expectedTools.length} tools, provider ${result.descriptor.providerId}`
  );
  console.log(`Pi activation evidence: ${activationEvidence}`);
} finally {
  try {
    await terminateProcessTree(child);
    await Promise.race([
      childExit ?? Promise.resolve(),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
    ]);
  } finally {
    try {
      await registry?.close();
    } finally {
      if (process.env.PI_LEETCODE_KEEP_VERIFY_TEMP === "1") {
        console.log(`Pi activation probe retained at ${temporaryDirectory}`);
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
}
