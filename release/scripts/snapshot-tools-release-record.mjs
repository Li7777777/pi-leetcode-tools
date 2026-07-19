import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputDirectory = join(
  repositoryRoot,
  ".artifacts",
  "committed-release",
  "tools"
);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sha256Pattern = /^(?:sha256:)?([0-9a-f]{64})$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    assert(key?.startsWith("--") && value !== undefined, `Invalid snapshot argument: ${key ?? "<missing>"}`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function git(args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const version = args.version;
const expectedSha = sha256Pattern.exec(args["expected-sha256"] ?? "");
const expectedRecordDigest = args["expected-record-digest"];
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? ""), "--version is invalid");
assert(expectedSha !== null, "--expected-sha256 is invalid");
assert(digestPattern.test(expectedRecordDigest ?? ""), "--expected-record-digest is invalid");

const policyText = await git(["show", "HEAD:release/tools-release-policy.json"]);
const policy = JSON.parse(policyText);
assert(policy.packageName === "pi-leetcode-tools", "Committed release policy is invalid");
const tag = `${policy.releaseTagPrefix}${version}`;
const head = (await git(["rev-parse", "HEAD"])).trim().toLowerCase();
const peeled = (await git(["rev-parse", `refs/tags/${tag}^{commit}`])).trim().toLowerCase();
assert(head === peeled, `HEAD is not the peeled commit of ${tag}`);

if (process.env.GITHUB_ACTIONS === "true") {
  assert(process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME === tag, `Workflow must run at ${tag}`);
  assert((process.env.GITHUB_SHA ?? "").toLowerCase() === head, "GITHUB_SHA differs from the tagged commit");
}

const currentText = await git(["show", "HEAD:release/candidates/tools/current.json"]);
const current = JSON.parse(currentText);
assert(current.packageVersion === version && current.packageName === "pi-leetcode-tools", "Committed current.json has the wrong subject");
assert(current.recordDigest === expectedRecordDigest, "Committed current.json record digest differs from the approved input");
assert(basename(current.recordFile) === current.recordFile, "Committed current.json record filename is unsafe");

const recordText = await git(["show", `HEAD:release/candidates/tools/${current.recordFile}`]);
const record = JSON.parse(recordText);
assert(`sha256:${sha256(recordText)}` === expectedRecordDigest, "Committed CandidateRecord byte digest is invalid");
assert(record.recordId === current.recordId, "Committed CandidateRecord ID differs from current.json");
assert(record.artifact?.sha256 === `sha256:${expectedSha[1]}`, "Committed CandidateRecord tgz SHA-256 differs from the approved input");

await rm(outputDirectory, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100
});
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, "current.json"), currentText, "utf8"),
  writeFile(join(outputDirectory, "record.json"), recordText, "utf8"),
  writeFile(join(outputDirectory, "policy.json"), policyText, "utf8"),
  writeFile(
    join(outputDirectory, "snapshot.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      evidenceType: "tagged-candidate-record-snapshot",
      package: "pi-leetcode-tools",
      version,
      commit: head,
      tag,
      recordId: current.recordId,
      recordDigest: current.recordDigest,
      artifactSha256: `sha256:${expectedSha[1]}`
    }, null, 2)}\n`,
    "utf8"
  )
]);

console.log(`Saved committed Tools release record before build: ${outputDirectory}`);
