import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactRoot = resolve(repositoryRoot, ".artifacts");
const targetDirectory = resolve(artifactRoot, "upstream-reference");
const registry = "https://registry.npmjs.org";
const references = Object.freeze([
  {
    spec: "@jinzcdev/leetcode-mcp-server@1.4.0",
    name: "@jinzcdev/leetcode-mcp-server",
    version: "1.4.0",
    file: "jinzcdev-leetcode-mcp-server-1.4.0.tgz",
    bytes: 46_005,
    sha256: "976ffafb49f1a3d2132a119e71af28b2911b4c56480bcb58097fa9d1c9657b56",
    integrity: "sha512-9DewGzg265ob+ld0dq8R2yzK7/k9RCPE/KNKB/3cDAeiIuONPi1OopAzAcAkHpYnXG/xgxDwuy8tokZjX3BTpw=="
  },
  {
    spec: "leetcode-query@2.0.1",
    name: "leetcode-query",
    version: "2.0.1",
    file: "leetcode-query-2.0.1.tgz",
    bytes: 26_379,
    sha256: "281fbaa950bf82e0b72a7273c2e7f5502ea6eb1dd593079ab5b89f8048b3eff0",
    integrity: "sha512-zvVp5T5C69pmvgaaxIP8OFBfhzIw57TAVPFDK5y2DYDNPW2A5sBSFHAUDgFpbZylO3VeHJWlCBAEgrhs2PHR9Q=="
  }
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function runNpmPack(reference, destination) {
  const npmCli = process.env.npm_execpath;
  assert(
    typeof npmCli === "string" && npmCli.length > 0,
    "Upstream provisioning must be launched through an npm script"
  );

  const { spawn } = await import("node:child_process");
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        npmCli,
        "pack",
        reference.spec,
        `--registry=${registry}`,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        destination
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_UPDATE_NOTIFIER: "false"
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`npm pack ${reference.spec} failed (${code}): ${stderr.trim()}`));
    });
  });

  const result = JSON.parse(output);
  assert(Array.isArray(result) && result.length === 1, `npm pack returned an unexpected result for ${reference.spec}`);
  const packed = result[0];
  assert(packed.name === reference.name, `npm pack resolved the wrong package for ${reference.spec}`);
  assert(packed.version === reference.version, `npm pack resolved the wrong version for ${reference.spec}`);
  assert(packed.filename === reference.file, `npm pack returned an unexpected filename for ${reference.spec}`);
  return resolve(destination, packed.filename);
}

await mkdir(targetDirectory, { recursive: true });
const temporaryDirectory = await mkdtemp(join(artifactRoot, "upstream-provision-"));

try {
  const provisioned = [];
  for (const reference of references) {
    const packedPath = await runNpmPack(reference, temporaryDirectory);
    const bytes = await readFile(packedPath);
    const actualSha256 = sha256(bytes);
    const actualIntegrity = integrity(bytes);
    assert(bytes.length === reference.bytes, `Pinned archive size changed for ${reference.spec}`);
    assert(actualSha256 === reference.sha256, `Pinned archive SHA-256 changed for ${reference.spec}`);
    assert(actualIntegrity === reference.integrity, `Pinned archive integrity changed for ${reference.spec}`);

    const targetPath = resolve(targetDirectory, reference.file);
    await rm(targetPath, { force: true });
    await rename(packedPath, targetPath);
    provisioned.push({
      package: reference.name,
      version: reference.version,
      file: reference.file,
      bytes: bytes.length,
      sha256: actualSha256,
      integrity: actualIntegrity
    });
  }

  console.log(JSON.stringify({ registry, targetDirectory, provisioned }, null, 2));
} finally {
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100
  });
}
