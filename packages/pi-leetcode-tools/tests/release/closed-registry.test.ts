import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const closedRegistryUrl = new URL(
  "../../scripts/closed-registry.mjs",
  import.meta.url
).href;

interface PrefetchWorkspacePaths {
  resolutionDirectory: string;
  cacheDirectory: string;
  tarballDirectory: string;
  npmUserConfig: string;
}

interface PrefetchFilesystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

async function loadHelper() {
  return (await import(closedRegistryUrl)) as {
    preparePrefetchWorkspace(
      paths: PrefetchWorkspacePaths,
      filesystem?: PrefetchFilesystem
    ): Promise<void>;
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("closed registry prefetch workspace", () => {
  it("does not write into the resolution directory before every directory exists", async () => {
    const { preparePrefetchWorkspace } = await loadHelper();
    const paths = {
      resolutionDirectory: join("registry", "resolution"),
      cacheDirectory: join("registry", "prefetch-cache"),
      tarballDirectory: join("registry", "tarballs"),
      npmUserConfig: join("registry", "prefetch.npmrc")
    };
    const directoryGates = new Map(
      [paths.resolutionDirectory, paths.cacheDirectory, paths.tarballDirectory].map(
        (path) => [path, deferred()] as const
      )
    );
    const mkdir = vi.fn((path: string) => {
      const gate = directoryGates.get(path);
      if (gate === undefined) throw new Error(`Unexpected directory: ${path}`);
      return gate.promise;
    });
    const writeFile = vi.fn(
      async (_path: string, _data: string, _encoding: "utf8") => undefined
    );

    const preparation = preparePrefetchWorkspace(paths, { mkdir, writeFile });

    expect(mkdir).toHaveBeenCalledWith(paths.resolutionDirectory, { recursive: true });
    expect(writeFile).not.toHaveBeenCalled();

    for (const gate of directoryGates.values()) gate.resolve();
    await preparation;

    expect(mkdir.mock.calls.map(([path]) => path)).toEqual([
      paths.resolutionDirectory,
      paths.cacheDirectory,
      paths.tarballDirectory
    ]);
    expect(writeFile.mock.calls.map(([path]) => path)).toEqual([
      join(paths.resolutionDirectory, "package.json"),
      paths.npmUserConfig
    ]);
  });

  it("initializes a fresh registry workspace on the real filesystem", async () => {
    const { preparePrefetchWorkspace } = await loadHelper();
    const registryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-closed-registry-"));
    const paths = {
      resolutionDirectory: join(registryDirectory, "resolution"),
      cacheDirectory: join(registryDirectory, "prefetch-cache"),
      tarballDirectory: join(registryDirectory, "tarballs"),
      npmUserConfig: join(registryDirectory, "prefetch.npmrc")
    };

    try {
      await preparePrefetchWorkspace(paths);

      expect((await stat(paths.resolutionDirectory)).isDirectory()).toBe(true);
      expect((await stat(paths.cacheDirectory)).isDirectory()).toBe(true);
      expect((await stat(paths.tarballDirectory)).isDirectory()).toBe(true);
      expect(
        JSON.parse(await readFile(join(paths.resolutionDirectory, "package.json"), "utf8"))
      ).toEqual({ name: "pi-leetcode-registry-prefetch", private: true });
      await expect(readFile(paths.npmUserConfig, "utf8")).resolves.toBe(
        "registry=https://registry.npmjs.org/\naudit=false\nfund=false\nupdate-notifier=false\n"
      );
    } finally {
      await rm(registryDirectory, { recursive: true, force: true });
    }
  });

  it("does not start later filesystem work after a directory failure", async () => {
    const { preparePrefetchWorkspace } = await loadHelper();
    const paths = {
      resolutionDirectory: join("registry", "resolution"),
      cacheDirectory: join("registry", "prefetch-cache"),
      tarballDirectory: join("registry", "tarballs"),
      npmUserConfig: join("registry", "prefetch.npmrc")
    };
    const failure = new Error("cache directory unavailable");
    const mkdir = vi
      .fn<(path: string, options: { recursive: true }) => Promise<unknown>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);
    const writeFile = vi.fn(
      async (_path: string, _data: string, _encoding: "utf8") => undefined
    );

    await expect(
      preparePrefetchWorkspace(paths, { mkdir, writeFile })
    ).rejects.toBe(failure);

    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
