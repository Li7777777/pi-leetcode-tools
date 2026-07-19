import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import {
  assert,
  readJson,
  runCommand,
  sha256Bytes,
  withExtractedPackage
} from "./release-utils.mjs";

const UPSTREAM_REGISTRY = "https://registry.npmjs.org/";
const INTEGRITY_ALGORITHMS = ["sha512", "sha384", "sha256", "sha1"];

function packageNameFromLockPath(lockPath) {
  const normalized = lockPath.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const segments = normalized.slice(markerIndex + marker.length).split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0] || undefined;
}

function verifyIntegrity(bytes, integrity, label) {
  assert(typeof integrity === "string" && integrity.length > 0, `${label} has no integrity`);
  const entries = integrity
    .trim()
    .split(/\s+/u)
    .map((entry) => {
      const separator = entry.indexOf("-");
      if (separator <= 0) {
        return undefined;
      }
      return {
        algorithm: entry.slice(0, separator).toLowerCase(),
        digest: entry.slice(separator + 1).split("?")[0]
      };
    })
    .filter(Boolean);

  const strongestAlgorithm = INTEGRITY_ALGORITHMS.find((algorithm) =>
    entries.some((entry) => entry.algorithm === algorithm)
  );
  assert(strongestAlgorithm !== undefined, `${label} has no supported integrity algorithm`);
  const actual = createHash(strongestAlgorithm).update(bytes).digest("base64");
  assert(
    entries.some(
      (entry) => entry.algorithm === strongestAlgorithm && entry.digest === actual
    ),
    `${label} failed ${strongestAlgorithm} integrity verification`
  );
}

function sha1Hex(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function sha512Hex(bytes) {
  return `sha512:${createHash("sha512").update(bytes).digest("hex")}`;
}

async function fetchTarball(url, integrity, label) {
  const response = await fetch(url, {
    headers: { accept: "application/octet-stream" },
    redirect: "follow"
  });
  assert(response.ok, `${label} download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(bytes, integrity, label);
  return bytes;
}

async function readPackedMetadata(tarball, expectedName, expectedVersion) {
  return withExtractedPackage(tarball, async ({ packageDirectory }) => {
    const packageJson = await readJson(join(packageDirectory, "package.json"));
    assert(packageJson.name === expectedName, `${expectedName} tarball contains another package`);
    assert(
      packageJson.version === expectedVersion,
      `${expectedName} tarball version does not match the resolved lock entry`
    );
    return packageJson;
  });
}

function addPackageRecord(packages, record) {
  let versions = packages.get(record.name);
  if (versions === undefined) {
    versions = new Map();
    packages.set(record.name, versions);
  }
  const existing = versions.get(record.version);
  if (existing !== undefined) {
    assert(
      existing.integrity === record.integrity && existing.sha256 === record.sha256,
      `Conflicting tarballs resolved for ${record.name}@${record.version}`
    );
    return;
  }
  versions.set(record.version, record);
}

export async function preparePrefetchWorkspace(
  {
    resolutionDirectory,
    cacheDirectory,
    tarballDirectory,
    npmUserConfig
  },
  filesystem = { mkdir, writeFile }
) {
  await filesystem.mkdir(resolutionDirectory, { recursive: true });
  await filesystem.mkdir(cacheDirectory, { recursive: true });
  await filesystem.mkdir(tarballDirectory, { recursive: true });
  await filesystem.writeFile(
    join(resolutionDirectory, "package.json"),
    `${JSON.stringify({ name: "pi-leetcode-registry-prefetch", private: true }, null, 2)}\n`,
    "utf8"
  );
  await filesystem.writeFile(
    npmUserConfig,
    `registry=${UPSTREAM_REGISTRY}\naudit=false\nfund=false\nupdate-notifier=false\n`,
    "utf8"
  );
}

async function prefetchProductionGraph({
  candidateTarball,
  candidatePackageJson,
  candidateBytes,
  registryDirectory
}) {
  const resolutionDirectory = join(registryDirectory, "resolution");
  const cacheDirectory = join(registryDirectory, "prefetch-cache");
  const tarballDirectory = join(registryDirectory, "tarballs");
  const npmUserConfig = join(registryDirectory, "prefetch.npmrc");
  await preparePrefetchWorkspace({
    resolutionDirectory,
    cacheDirectory,
    tarballDirectory,
    npmUserConfig
  });

  const npmCli = process.env.npm_execpath;
  assert(
    typeof npmCli === "string" && npmCli.length > 0,
    "Closed-registry verification must be launched through an npm script"
  );
  await runCommand(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      resolutionDirectory,
      "--package-lock-only",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--registry",
      UPSTREAM_REGISTRY,
      candidateTarball
    ],
    {
      env: {
        ...process.env,
        NODE_PATH: "",
        NPM_CONFIG_CACHE: cacheDirectory,
        NPM_CONFIG_REGISTRY: UPSTREAM_REGISTRY,
        NPM_CONFIG_USERCONFIG: npmUserConfig
      }
    }
  );

  const lock = await readJson(join(resolutionDirectory, "package-lock.json"));
  assert(lock.lockfileVersion >= 3, "Dependency prefetch requires npm lockfileVersion 3+");
  const packages = new Map();
  const candidateIntegrity = sha512Integrity(candidateBytes);
  addPackageRecord(packages, {
    name: candidatePackageJson.name,
    version: candidatePackageJson.version,
    metadata: candidatePackageJson,
    bytes: candidateBytes,
    integrity: candidateIntegrity,
    shasum: sha1Hex(candidateBytes),
    sha256: sha256Bytes(candidateBytes),
    sha512: sha512Hex(candidateBytes),
    candidate: true
  });

  const resolvedEntries = [];
  for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
    const name = packageNameFromLockPath(lockPath);
    if (name === undefined || name === candidatePackageJson.name) {
      continue;
    }
    assert(typeof entry.version === "string", `Resolved package ${name} has no version`);
    assert(
      typeof entry.resolved === "string" && entry.resolved.startsWith("https://"),
      `Resolved package ${name}@${entry.version} is not an HTTPS registry tarball`
    );
    assert(
      typeof entry.integrity === "string",
      `Resolved package ${name}@${entry.version} has no registry integrity`
    );
    resolvedEntries.push({
      name,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity
    });
  }

  const uniqueEntries = new Map();
  for (const entry of resolvedEntries) {
    const key = `${entry.name}@${entry.version}`;
    const existing = uniqueEntries.get(key);
    if (existing !== undefined) {
      assert(
        existing.resolved === entry.resolved && existing.integrity === entry.integrity,
        `Dependency graph resolved conflicting artifacts for ${key}`
      );
    } else {
      uniqueEntries.set(key, entry);
    }
  }

  for (const entry of [...uniqueEntries.values()].sort((left, right) =>
    `${left.name}@${left.version}` < `${right.name}@${right.version}` ? -1 : 1
  )) {
    const label = `${entry.name}@${entry.version}`;
    const bytes = await fetchTarball(entry.resolved, entry.integrity, label);
    const fileName = `${createHash("sha256").update(label).digest("hex")}.tgz`;
    const localTarball = join(tarballDirectory, fileName);
    await writeFile(localTarball, bytes);
    const metadata = await readPackedMetadata(localTarball, entry.name, entry.version);
    addPackageRecord(packages, {
      name: entry.name,
      version: entry.version,
      metadata,
      bytes,
      integrity: entry.integrity,
      shasum: sha1Hex(bytes),
      sha256: sha256Bytes(bytes),
      sha512: sha512Hex(bytes),
      candidate: false
    });
  }

  return { packages, candidateIntegrity };
}

function packageRequestName(pathname) {
  if (!pathname.startsWith("/") || pathname.startsWith("/-/")) {
    return undefined;
  }
  try {
    return decodeURIComponent(pathname.slice(1));
  } catch {
    return undefined;
  }
}

function sendJson(response, method, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store"
  });
  response.end(method === "HEAD" ? undefined : body);
}

/**
 * Prefetch the exact production graph, then expose it through an allowlisted
 * local registry. The request handler performs no network I/O and every
 * unknown route is recorded and answered with 404.
 */
export async function startClosedRegistry({
  candidateTarball,
  candidatePackageJson,
  candidateBytes,
  directory
}) {
  const registryDirectory = join(directory, "closed-registry");
  await mkdir(registryDirectory, { recursive: true });
  const { packages, candidateIntegrity } = await prefetchProductionGraph({
    candidateTarball,
    candidatePackageJson,
    candidateBytes,
    registryDirectory
  });

  const tarballRoutes = new Map();
  for (const versions of packages.values()) {
    for (const record of versions.values()) {
      const routeId = createHash("sha256")
        .update(`${record.name}@${record.version}\0${record.sha256}`)
        .digest("hex");
      record.route = `/-/tarballs/${routeId}.tgz`;
      tarballRoutes.set(record.route, record);
    }
  }

  const unexpectedRequests = [];
  const requests = [];
  let origin;
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", origin);
    requests.push({ method, path: requestUrl.pathname });

    if ((method === "GET" || method === "HEAD") && tarballRoutes.has(requestUrl.pathname)) {
      const record = tarballRoutes.get(requestUrl.pathname);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(record.bytes.length),
        "cache-control": "no-store"
      });
      response.end(method === "HEAD" ? undefined : record.bytes);
      return;
    }

    const requestedPackage = packageRequestName(requestUrl.pathname);
    const versions = requestedPackage === undefined ? undefined : packages.get(requestedPackage);
    if ((method === "GET" || method === "HEAD") && versions !== undefined) {
      const orderedRecords = [...versions.values()].sort((left, right) =>
        left.version < right.version ? -1 : left.version > right.version ? 1 : 0
      );
      const versionEntries = Object.fromEntries(
        orderedRecords.map((record) => [
          record.version,
          {
            ...record.metadata,
            dist: {
              tarball: new URL(record.route, origin).href,
              shasum: record.shasum,
              integrity: record.integrity
            }
          }
        ])
      );
      sendJson(response, method, 200, {
        name: requestedPackage,
        "dist-tags": { latest: orderedRecords.at(-1).version },
        versions: versionEntries
      });
      return;
    }

    unexpectedRequests.push({ method, path: requestUrl.pathname });
    sendJson(response, method, 404, {
      error: "not_found",
      reason: "The closed verification registry does not allow this request"
    });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let closePromise;
  function closeServer() {
    if (closePromise !== undefined) {
      return closePromise;
    }
    closePromise = new Promise((resolvePromise, reject) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (!server.listening) {
        resolvePromise();
        return;
      }
      server.close((error) =>
        error === undefined || error.code === "ERR_SERVER_NOT_RUNNING"
          ? resolvePromise()
          : reject(error)
      );
      server.closeAllConnections?.();
    });
    return closePromise;
  }

  try {
    await new Promise((resolvePromise, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    assert(address !== null && typeof address === "object", "Closed registry has no address");
    origin = `http://127.0.0.1:${address.port}/`;
  } catch (error) {
    await closeServer().catch(() => undefined);
    throw error;
  }

  return {
    origin,
    candidateIntegrity,
    candidateSha512: sha512Hex(candidateBytes),
    prefetchedPackages: [...packages.values()].reduce(
      (total, versions) => total + versions.size,
      0
    ),
    requests,
    assertNoUnexpectedRequests() {
      assert(
        unexpectedRequests.length === 0,
        `Closed registry received unexpected requests: ${JSON.stringify(unexpectedRequests)}`
      );
    },
    close: closeServer
  };
}
