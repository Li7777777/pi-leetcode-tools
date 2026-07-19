import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, canonicalJson, runCommand } from "./release-utils.mjs";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "..", "..");
const npmCli = process.env.npm_execpath;
assert(
  typeof npmCli === "string" && npmCli.length > 0,
  "Reproducible build verification must be launched through an npm script"
);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    } else {
      throw new Error(`Build output contains a non-regular entry: ${absolutePath}`);
    }
  }
  return files;
}

async function snapshot(rootNames = ["dist", "contract"]) {
  const result = {};
  for (const rootName of rootNames) {
    const root = resolve(packageDirectory, rootName);
    for (const absolutePath of await walk(root)) {
      const key = `${rootName}/${relative(root, absolutePath).replaceAll("\\", "/")}`;
      const bytes = await readFile(absolutePath);
      result[key] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return result;
}

async function build(label) {
  await runCommand(
    process.execPath,
    [npmCli, "run", "build", "--workspace", "pi-leetcode-tools"],
    { cwd: repositoryRoot, stdio: "inherit" }
  );
  const files = await snapshot();
  console.log(`${label}: ${Object.keys(files).length} generated files`);
  return files;
}

const contractBeforeBuild = await snapshot(["contract"]);
const buildA = await build("build A");
const buildB = await build("build B");
assert(
  canonicalJson(buildA) === canonicalJson(buildB),
  "Build output is not reproducible; build A and build B hashes differ"
);
const contractAfterBuild = await snapshot(["contract"]);
assert(
  canonicalJson(contractBeforeBuild) === canonicalJson(contractAfterBuild),
  "Generated contract artifacts changed during the release build; review and retain them, then rerun"
);

const aggregateDigest = createHash("sha256")
  .update(canonicalJson(buildB), "utf8")
  .digest("hex");
console.log(`Reproducible build verified: sha256:${aggregateDigest}`);
