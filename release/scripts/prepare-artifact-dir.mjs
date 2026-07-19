import { mkdir, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const artifactRoot = resolve(repositoryRoot, ".artifacts");
const allowed = new Map([
  ["tools", resolve(artifactRoot, "tools")],
  ["integration", resolve(artifactRoot, "integration")]
]);

const name = process.argv[2];
const target = allowed.get(name);
if (target === undefined) {
  throw new Error(`Expected artifact namespace: ${[...allowed.keys()].join(" | ")}`);
}
const relativeTarget = relative(artifactRoot, target);
if (
  relativeTarget === "" ||
  relativeTarget === ".." ||
  relativeTarget.startsWith(`..${sep}`)
) {
  throw new Error(`Refusing to prepare unsafe artifact directory: ${target}`);
}

await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
await mkdir(target, { recursive: true });
console.log(`Prepared ${name} artifacts: ${target}`);
