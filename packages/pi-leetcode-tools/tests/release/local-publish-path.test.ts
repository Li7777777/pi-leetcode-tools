import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runNpm(
  npmCli: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `npm ${args.join(" ")} failed with code ${String(code)} and signal ${String(signal)}\n${stderr}`
        )
      );
    });
  });
}

describe("explicit local npm publish paths", () => {
  it("dry-runs tgz files from the downloaded bootstrap and release bundle layouts", async () => {
    const npmCli = process.env.npm_execpath;
    if (typeof npmCli !== "string" || npmCli.length === 0) {
      throw new Error("The local publish path test must be launched through npm");
    }

    const root = await mkdtemp(join(tmpdir(), "pi-leetcode-local-publish-"));
    const fixture = join(root, "fixture");
    const npmCache = join(root, "npm-cache");
    const npmHome = join(root, "home");
    const npmUserConfig = join(root, "user.npmrc");
    const npmGlobalConfig = join(root, "global.npmrc");
    const packageJson = {
      name: "pi-leetcode-local-publish-fixture",
      version: "0.0.0",
      files: ["index.js"]
    };

    try {
      await Promise.all([
        mkdir(fixture, { recursive: true }),
        mkdir(npmCache, { recursive: true }),
        mkdir(npmHome, { recursive: true })
      ]);
      await Promise.all([
        writeFile(npmUserConfig, "audit=false\nfund=false\nupdate-notifier=false\n", "utf8"),
        writeFile(npmGlobalConfig, "", "utf8"),
        writeFile(join(fixture, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8"),
        writeFile(join(fixture, "index.js"), "export const fixture = true;\n", "utf8")
      ]);
      const environment = {
        ...process.env,
        HOME: npmHome,
        NPM_CONFIG_CACHE: npmCache,
        NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
        NPM_CONFIG_USERCONFIG: npmUserConfig
      };
      const packed = await runNpm(
        npmCli,
        ["pack", "--ignore-scripts", "--json"],
        fixture,
        environment
      );
      const packEntries = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
      expect(packEntries).toHaveLength(1);
      const filename = packEntries[0]?.filename;
      expect(typeof filename).toBe("string");
      if (typeof filename !== "string") throw new Error("npm pack did not report a tgz filename");

      for (const bundleDirectory of ["bootstrap-bundle", "release-bundle"]) {
        const destinationDirectory = join(root, bundleDirectory);
        await mkdir(destinationDirectory, { recursive: true });
        await copyFile(join(fixture, filename), join(destinationDirectory, filename));
        const published = await runNpm(
          npmCli,
          [
            "publish",
            `./${bundleDirectory}/${filename}`,
            "--dry-run",
            "--ignore-scripts",
            "--json",
            "--tag",
            "next",
            "--access",
            "public"
          ],
          root,
          environment
        );
        const parsed = JSON.parse(published.stdout) as Record<string, unknown>;
        const result = (parsed[packageJson.name] ?? parsed) as {
          id?: unknown;
          name?: unknown;
          version?: unknown;
        };
        expect(result).toMatchObject({
          id: "pi-leetcode-local-publish-fixture@0.0.0",
          name: "pi-leetcode-local-publish-fixture",
          version: "0.0.0"
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
