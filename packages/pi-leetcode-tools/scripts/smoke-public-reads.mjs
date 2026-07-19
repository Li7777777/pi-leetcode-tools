import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startClosedRegistry } from "./closed-registry.mjs";
import {
  assert,
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

const READ_TOOLS = ["lc_daily", "lc_search", "lc_problem"];
for (const tool of READ_TOOLS) {
  assert(manifest.tools?.includes(tool), `Packed contract does not contain ${tool}`);
}
assert(
  manifest.behaviorDigestAlgorithm === JCS_DIGEST_ALGORITHM &&
    sha256Jcs(manifest.behaviorManifest) === manifest.behaviorManifestDigest,
  "Packed behavior manifest is invalid"
);

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-tools-public-smoke-"));
const agentDirectory = join(temporaryDirectory, "agent");
const npmCache = join(temporaryDirectory, "npm-cache");
const npmUserConfig = join(temporaryDirectory, "npmrc");
const workingDirectory = join(temporaryDirectory, "workspace");
const probeExtension = join(temporaryDirectory, "public-read-probe.mjs");
const probeResult = join(temporaryDirectory, "public-read-result.json");
let registry;
let child;
let childExit;

try {
  await Promise.all([
  mkdir(agentDirectory, { recursive: true }),
  mkdir(npmCache, { recursive: true }),
  mkdir(workingDirectory, { recursive: true }),
  writeFile(npmUserConfig, "audit=false\nfund=false\n", "utf8")
  ]);

const probeSource = `
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

const DISCOVERY_CHANNEL = ${JSON.stringify(manifest.discoveryChannel)};
const RPC_CHANNEL = ${JSON.stringify(manifest.rpcChannel)};
const READY_CHANNEL = "pi-leetcode-tools:ready:v1";
const PROTOCOL_VERSION = ${JSON.stringify(manifest.protocolVersion)};
const RESULT_PATH = process.env.PI_LEETCODE_PUBLIC_SMOKE_RESULT;
const ALLOWED_TOOLS = new Set(${JSON.stringify(READ_TOOLS)});
const REGIONS = ["global", "cn"];
const RPC_TIMEOUT_MS = 15_000;

function safeFailure(step, region, requestId, result) {
  return {
    step,
    region,
    requestId,
    errorCode: result?.error?.code ?? "MALFORMED_RESULT",
    retryable: result?.error?.retryable === true
  };
}

function requireSlug(value, step, region, requestId) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw Object.assign(new Error("public read returned no safe slug"), {
      evidence: { step, region, requestId, errorCode: "MALFORMED_RESULT", retryable: false }
    });
  }
  return value;
}

export default function publicReadProbe(pi) {
  let settled = false;
  let running = false;
  let readyUnsubscribe;

  async function finish(payload) {
    if (settled) return;
    settled = true;
    readyUnsubscribe?.();
    const temporaryPath = RESULT_PATH + ".tmp-" + randomUUID();
    await writeFile(temporaryPath, JSON.stringify(payload), "utf8");
    await rename(temporaryPath, RESULT_PATH);
  }

  function discoverProvider() {
    return new Promise((resolve, reject) => {
      const requestId = "public-smoke-discover-" + randomUUID();
      let completed = false;
      function attempt() {
        if (completed) return;
        pi.events.emit(DISCOVERY_CHANNEL, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          respond(response) {
            if (completed || response?.requestId !== requestId) return;
            completed = true;
            clearInterval(retry);
            clearTimeout(timeout);
            resolve(response);
          }
        });
      }
      const retry = setInterval(attempt, 100);
      const timeout = setTimeout(() => {
        completed = true;
        clearInterval(retry);
        reject(Object.assign(new Error("provider discovery timed out"), {
          evidence: {
            step: "discovery",
            region: "none",
            requestId,
            errorCode: "PROTOCOL_TIMEOUT",
            retryable: true
          }
        }));
      }, RPC_TIMEOUT_MS);
      attempt();
    });
  }

  function rpc(descriptor, tool, input) {
    if (!ALLOWED_TOOLS.has(tool)) {
      throw new Error("probe attempted a non-read tool");
    }
    const region = input.region;
    const requestId = "public-smoke-" + region + "-" + tool + "-" + randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(Object.assign(new Error("Gateway RPC timed out"), {
          evidence: {
            step: tool,
            region,
            requestId,
            errorCode: "PROTOCOL_TIMEOUT",
            retryable: true
          }
        }));
      }, RPC_TIMEOUT_MS + 1_000);
      pi.events.emit(RPC_CHANNEL, {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        providerId: descriptor.providerId,
        instanceId: descriptor.instanceId,
        contextRevision: descriptor.contextRevision,
        method: "tool.execute",
        params: { tool, input },
        deadlineAt: Date.now() + RPC_TIMEOUT_MS,
        respond(response) {
          if (response?.requestId !== requestId) return;
          clearTimeout(timeout);
          resolve({ requestId, response });
        }
      });
    });
  }

  async function execute() {
    if (running || settled) return;
    running = true;
    const summaries = [];
    const failures = [];
    try {
      const discovery = await discoverProvider();
      const descriptor = discovery?.descriptor;
      if (
        discovery?.protocolVersion !== PROTOCOL_VERSION ||
        descriptor?.protocolVersion !== PROTOCOL_VERSION ||
        typeof descriptor?.providerId !== "string" ||
        typeof descriptor?.instanceId !== "string" ||
        !Number.isSafeInteger(descriptor?.contextRevision)
      ) {
        throw Object.assign(new Error("provider descriptor is malformed"), {
          evidence: {
            step: "discovery",
            region: "none",
            requestId: discovery?.requestId ?? "missing",
            errorCode: "CONTRACT_MISMATCH",
            retryable: false
          }
        });
      }
      const verificationProfileId = process.env.PI_LEETCODE_PROFILE_ID;
      if (
        typeof verificationProfileId !== "string" ||
        descriptor.activeAccountProfileId !== undefined ||
        descriptor.regionReadiness?.global?.configured !== false ||
        descriptor.regionReadiness?.cn?.configured !== false
      ) {
        throw Object.assign(new Error("public-read smoke observed configured credentials"), {
          evidence: {
            step: "auth-isolation",
            region: "none",
            requestId: discovery?.requestId ?? "missing",
            errorCode: "CONTRACT_MISMATCH",
            retryable: false
          }
        });
      }

      for (const region of REGIONS) {
        let problemSlugInput = "two-sum";
        try {
          const dailyCall = await rpc(descriptor, "lc_daily", { region });
          const dailyResult = dailyCall.response?.result;
          if (dailyResult?.ok !== true) {
            failures.push(safeFailure("lc_daily", region, dailyCall.requestId, dailyResult));
          } else {
            problemSlugInput = requireSlug(
              dailyResult.data?.problem?.titleSlug,
              "lc_daily",
              region,
              dailyCall.requestId
            );
            summaries.push({
              tool: "lc_daily",
              region,
              requestId: dailyCall.requestId,
              slug: problemSlugInput,
              count: 1
            });
          }
        } catch (error) {
          failures.push(
            error?.evidence ?? {
              step: "lc_daily",
              region,
              requestId: "unavailable",
              errorCode: "PROBE_FAILED",
              retryable: false
            }
          );
        }

        try {
          const searchCall = await rpc(descriptor, "lc_search", { region, limit: 1 });
          const searchResult = searchCall.response?.result;
          if (searchResult?.ok !== true) {
            failures.push(
              safeFailure("lc_search", region, searchCall.requestId, searchResult)
            );
          } else {
            const items = Array.isArray(searchResult.data?.items)
              ? searchResult.data.items
              : null;
            if (items === null) {
              failures.push({
                step: "lc_search",
                region,
                requestId: searchCall.requestId,
                errorCode: "MALFORMED_RESULT",
                retryable: false
              });
            } else {
              const firstSlug =
                items.length === 0
                  ? undefined
                  : requireSlug(
                      items[0]?.titleSlug,
                      "lc_search",
                      region,
                      searchCall.requestId
                    );
              summaries.push({
                tool: "lc_search",
                region,
                requestId: searchCall.requestId,
                ...(firstSlug === undefined ? {} : { slug: firstSlug }),
                count: items.length
              });
            }
          }
        } catch (error) {
          failures.push(
            error?.evidence ?? {
              step: "lc_search",
              region,
              requestId: "unavailable",
              errorCode: "PROBE_FAILED",
              retryable: false
            }
          );
        }

        try {
          const problemCall = await rpc(descriptor, "lc_problem", {
            region,
            titleSlug: problemSlugInput
          });
          const problemResult = problemCall.response?.result;
          if (problemResult?.ok !== true) {
            failures.push(
              safeFailure("lc_problem", region, problemCall.requestId, problemResult)
            );
          } else {
            const problemSlug = requireSlug(
              problemResult.data?.titleSlug,
              "lc_problem",
              region,
              problemCall.requestId
            );
            const exampleCount = Array.isArray(problemResult.data?.exampleTestcases)
              ? problemResult.data.exampleTestcases.length
              : 0;
            const tagCount = Array.isArray(problemResult.data?.topicTags)
              ? problemResult.data.topicTags.length
              : 0;
            const snippetCount = Array.isArray(problemResult.data?.codeSnippets)
              ? problemResult.data.codeSnippets.length
              : 0;
            summaries.push({
              tool: "lc_problem",
              region,
              requestId: problemCall.requestId,
              slug: problemSlug,
              count: 1,
              structure: { exampleCount, tagCount, snippetCount }
            });
          }
        } catch (error) {
          failures.push(
            error?.evidence ?? {
              step: "lc_problem",
              region,
              requestId: "unavailable",
              errorCode: "PROBE_FAILED",
              retryable: false
            }
          );
        }
      }

      await finish({
        ok: failures.length === 0,
        packageName: descriptor.packageName,
        packageVersion: descriptor.packageVersion,
        verificationProfileId,
        authenticated: false,
        summaries,
        failures
      });
    } catch (error) {
      failures.push(
        error?.evidence ?? {
          step: "probe",
          region: "none",
          requestId: "unavailable",
          errorCode: "PROBE_FAILED",
          retryable: false
        }
      );
      await finish({
        ok: false,
        summaries,
        failures
      });
    }
  }

  readyUnsubscribe = pi.events.on(READY_CHANNEL, () => void execute());
  pi.on("session_start", () => {
    void execute().catch(() =>
      finish({
        ok: false,
        evidence: {
          step: "probe",
          region: "none",
          requestId: "unavailable",
          errorCode: "PROBE_FAILED",
          retryable: false
        }
      })
    );
  });
  pi.on("session_shutdown", () => readyUnsubscribe?.());
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
    "Public-read smoke installed a package other than the candidate"
  );
  const installedContent = await digestPackageFiles(
    installedPackageDirectory,
    candidateContent.files.map((file) => file.path)
  );
  assert(
    installedContent.digest === candidateContent.digest,
    "Public-read smoke installed files do not match the candidate tarball"
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

  child = spawn(
    process.execPath,
    [
      piCli,
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-builtin-tools",
      "--tools",
      READ_TOOLS.join(","),
      "--extension",
      probeExtension,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve"
    ],
    {
      cwd: workingDirectory,
      env: {
        ...baseEnvironment,
        PI_OFFLINE: "1",
        PI_LEETCODE_PUBLIC_SMOKE_RESULT: probeResult
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  childExit = new Promise((resolvePromise) => child.once("exit", resolvePromise));

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-16_384);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16_384);
  });

  const deadline = Date.now() + 120_000;
  while (!(await pathExists(probeResult)) && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Pi RPC process exited before public-read evidence (code ${child.exitCode}); stderr=${JSON.stringify(stderr.trim())}`
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert(
    await pathExists(probeResult),
    `Pi public-read smoke timed out; stderr=${JSON.stringify(stderr.trim())}`
  );

  const result = JSON.parse(await readFile(probeResult, "utf8"));
  assert(Array.isArray(result.summaries), "Public-read probe returned no summaries");
  for (const summary of result.summaries) {
    assert(READ_TOOLS.includes(summary.tool), "Probe reported a non-read tool");
    assert(summary.region === "global" || summary.region === "cn", "Probe reported an invalid region");
    assert(typeof summary.requestId === "string", "Probe summary has no requestId");
    console.log(JSON.stringify(summary));
  }
  if (result.ok !== true) {
    assert(Array.isArray(result.failures), "Public-read probe returned no failure evidence");
    console.error(JSON.stringify({ ok: false, failures: result.failures }));
    process.exitCode = 1;
  } else {
    assert(
      result.packageName === manifest.packageName &&
        result.packageVersion === manifest.packageVersion,
      "Public-read probe package identity does not match the final tarball"
    );
    assert(
      result.verificationProfileId === noAccountProfileId &&
        result.authenticated === false,
      "Public-read probe did not preserve no-account isolation"
    );
    assert(result.summaries.length === 6, "Public-read probe did not complete all six reads");
    console.log("Public reads verified: 6/6 requests");
  }
  registry.assertNoUnexpectedRequests();
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
        console.log(`Public-read smoke files retained at ${temporaryDirectory}`);
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
