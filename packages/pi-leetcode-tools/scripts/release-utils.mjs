import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const PACKAGE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
export const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
export const DEFAULT_ARTIFACT_DIRECTORY = join(REPOSITORY_ROOT, ".artifacts");
export const JCS_DIGEST_ALGORITHM = "RFC8785/JCS+UTF-8+SHA-256";

const JCS_GOLDEN_VALUE = {
  numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
  string: "€$\u000f\nA'B\"\\\\\"/",
  literals: [null, true, false]
};
const JCS_GOLDEN_CANONICAL =
  "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}";
const JCS_GOLDEN_DIGEST =
  "sha256:2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb";

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const CREDENTIAL_ENVIRONMENT_NAMES = new Set([
  "LEETCODE_SESSION",
  "LEETCODE_CSRF_TOKEN",
  "LEETCODE_CN_SESSION",
  "LEETCODE_CN_CSRF_TOKEN",
  "PI_LEETCODE_PROFILE_ID"
]);

/**
 * Build an environment for release checks that must not observe the developer's
 * real LeetCode account. HOME/APPDATA isolation is insufficient on Windows
 * because the OS keyring is process-global, so select a unique nonexistent
 * profile after removing every credential variable case-insensitively.
 */
export function createNoAccountEnvironment(options = {}) {
  const sourceEnvironment = options.environment ?? process.env;
  const profileId = options.profileId ?? `pi-no-account-${randomUUID()}`;
  assert(
    profileId.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(profileId),
    "No-account verification profile ID is invalid"
  );

  const environment = { ...sourceEnvironment };
  for (const name of Object.keys(environment)) {
    if (CREDENTIAL_ENVIRONMENT_NAMES.has(name.toUpperCase())) {
      delete environment[name];
    }
  }
  environment.PI_LEETCODE_PROFILE_ID = profileId;
  return { environment, profileId };
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertWellFormedUnicode(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      assert(
        nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff,
        `${label} contains an unpaired UTF-16 high surrogate`
      );
      index += 1;
    } else {
      assert(
        codeUnit < 0xdc00 || codeUnit > 0xdfff,
        `${label} contains an unpaired UTF-16 low surrogate`
      );
    }
  }
}

/**
 * Canonicalize an in-memory I-JSON value according to RFC 8785/JCS.
 *
 * Property names are ordered by their UTF-16 code units, strings must be
 * well-formed Unicode, and numbers use ECMAScript's JSON serialization.
 */
export function canonicalizeJcs(value) {
  const ancestors = new Set();

  function serialize(item, label) {
    if (item === null || typeof item === "boolean") {
      return JSON.stringify(item);
    }

    if (typeof item === "string") {
      assertWellFormedUnicode(item, label);
      return JSON.stringify(item);
    }

    if (typeof item === "number") {
      assert(Number.isFinite(item), `${label} contains a non-finite number`);
      return JSON.stringify(item);
    }

    assert(
      typeof item === "object",
      `${label} contains a non-JSON ${typeof item} value`
    );
    assert(!ancestors.has(item), `${label} contains a circular reference`);
    ancestors.add(item);

    try {
      if (Array.isArray(item)) {
        const values = [];
        for (let index = 0; index < item.length; index += 1) {
          assert(
            Object.prototype.hasOwnProperty.call(item, index),
            `${label} contains a sparse array element at index ${index}`
          );
          values.push(serialize(item[index], `${label}[${index}]`));
        }
        return `[${values.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(item);
      assert(
        prototype === Object.prototype || prototype === null,
        `${label} contains a non-JSON object`
      );
      assert(
        Object.getOwnPropertySymbols(item).length === 0,
        `${label} contains a symbol-keyed property`
      );

      const properties = Object.keys(item).sort();
      return `{${properties
        .map((key) => {
          assertWellFormedUnicode(key, `${label} property name`);
          return `${JSON.stringify(key)}:${serialize(item[key], `${label}.${key}`)}`;
        })
        .join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  }

  return serialize(value, "JCS input");
}

export function sha256Jcs(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJcs(value), "utf8")
    .digest("hex")}`;
}

export function assertJcsGoldenVectors() {
  const canonical = canonicalizeJcs(JCS_GOLDEN_VALUE);
  assert(
    canonical === JCS_GOLDEN_CANONICAL,
    `RFC 8785 canonicalization golden vector mismatch: ${canonical}`
  );
  const digest = sha256Jcs(JCS_GOLDEN_VALUE);
  assert(
    digest === JCS_GOLDEN_DIGEST,
    `RFC 8785 SHA-256 golden vector mismatch: ${digest}`
  );

  const utf16Ordering = {
    "€": "Euro Sign",
    "\r": "Carriage Return",
    "דּ": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "😀": "Emoji: Grinning Face",
    "\u0080": "Control",
    "ö": "Latin Small Letter O With Diaeresis"
  };
  assert(
    canonicalizeJcs(utf16Ordering) ===
      "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji: Grinning Face\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}",
    "RFC 8785 UTF-16 property ordering golden vector mismatch"
  );
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }

  const serialized = JSON.stringify(value);
  assert(serialized !== undefined, "Contract data contains a non-JSON value");
  return serialized;
}

export function sha256CanonicalJson(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function digestPackageFiles(packageDirectory, expectedPaths) {
  const paths =
    expectedPaths === undefined
      ? (await walkPackageFiles(packageDirectory)).map((entry) => entry.path)
      : [...expectedPaths];
  paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const files = [];
  for (const path of paths) {
    const absolutePath = resolveInside(packageDirectory, path, "Package artifact path");
    const metadata = await lstat(absolutePath);
    assert(metadata.isFile(), `Package artifact is not a regular file: ${path}`);
    const bytes = await readFile(absolutePath);
    files.push({ path: portablePath(path), size: bytes.length, sha256: sha256Bytes(bytes) });
  }

  return { digest: sha256Jcs(files), files };
}

export function portablePath(path) {
  return path.split(sep).join("/");
}

export function resolveInside(baseDirectory, candidate, label) {
  const resolved = resolve(baseDirectory, candidate);
  const relativePath = relative(baseDirectory, resolved);
  assert(
    relativePath !== "" &&
      !relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath),
    `${label} resolves outside the package: ${candidate}`
  );
  return resolved;
}

export async function resolveTarball(input = process.argv[2]) {
  const candidate = resolve(input ?? DEFAULT_ARTIFACT_DIRECTORY);
  const candidateStat = await stat(candidate).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Tarball or artifact directory does not exist: ${candidate}`);
    }
    throw error;
  });

  if (candidateStat.isFile()) {
    assert(candidate.toLowerCase().endsWith(".tgz"), `Expected a .tgz file: ${candidate}`);
    return candidate;
  }

  assert(candidateStat.isDirectory(), `Expected a tarball or directory: ${candidate}`);
  const tarballs = (await readdir(candidate, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".tgz"))
    .map((entry) => join(candidate, entry.name))
    .sort();

  assert(
    tarballs.length === 1,
    `Expected exactly one .tgz in ${candidate}, found ${tarballs.length}`
  );
  return tarballs[0];
}

export function runCommand(command, args, options = {}) {
  const {
    acceptedExitCodes = [0],
    cwd,
    env,
    stdio = "pipe",
    input,
    timeoutMs = 120_000
  } = options;
  assert(
    Array.isArray(acceptedExitCodes) &&
      acceptedExitCodes.length > 0 &&
      acceptedExitCodes.every((code) => Number.isInteger(code) && code >= 0),
    "acceptedExitCodes must contain non-negative integers"
  );

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: stdio === "pipe" ? ["pipe", "pipe", "pipe"] : stdio,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    if (stdio === "pipe") {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdin.end(input);
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).catch(() => undefined);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== null && acceptedExitCodes.includes(code)) {
        resolvePromise({ stdout, stderr, exitCode: code });
        return;
      }

      const details = [
        `${command} ${args.join(" ")} failed`,
        timedOut ? `timed out after ${timeoutMs} ms` : undefined,
        code === null ? `signal: ${String(signal)}` : `exit code: ${code}`,
        stdout.trim(),
        stderr.trim()
      ]
        .filter(Boolean)
        .join("\n");
      reject(new Error(details));
    });
  });
}

export async function terminateProcessTree(child) {
  if (child === undefined || child === null || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32" && Number.isInteger(child.pid)) {
    await new Promise((resolvePromise) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => resolvePromise());
      killer.once("close", () => resolvePromise());
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function validateArchiveEntry(entry) {
  const normalized = entry.replaceAll("\\", "/");
  assert(normalized.length > 0, "Tarball contains an empty path");
  assert(!normalized.startsWith("/"), `Tarball contains an absolute path: ${entry}`);
  assert(!/^[A-Za-z]:\//u.test(normalized), `Tarball contains an absolute path: ${entry}`);

  const segments = normalized.split("/").filter(Boolean);
  assert(segments[0] === "package", `Tarball entry is outside package/: ${entry}`);
  assert(!segments.includes(".."), `Tarball contains path traversal: ${entry}`);
  return normalized;
}

export async function listArchiveEntries(tarball) {
  const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";
  const { stdout } = await runCommand(tarCommand, ["-tzf", tarball]);
  return stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(validateArchiveEntry);
}

export async function walkPackageFiles(packageDirectory) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      const relativePath = portablePath(relative(packageDirectory, absolutePath));

      assert(!metadata.isSymbolicLink(), `Tarball contains a symbolic link: ${relativePath}`);
      if (metadata.isDirectory()) {
        await visit(absolutePath);
      } else {
        assert(metadata.isFile(), `Tarball contains an unsupported entry: ${relativePath}`);
        files.push({ path: relativePath, size: metadata.size });
      }
    }
  }

  await visit(packageDirectory);
  return files;
}

export async function withExtractedPackage(tarball, operation) {
  const archiveEntries = await listArchiveEntries(tarball);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-tools-verify-"));
  const extractionDirectory = join(temporaryDirectory, "extract");

  try {
    await mkdir(extractionDirectory, { recursive: true });
    const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";
    await runCommand(tarCommand, ["-xzf", tarball, "-C", extractionDirectory]);
    const packageDirectory = join(extractionDirectory, "package");
    const packageStat = await stat(packageDirectory);
    assert(packageStat.isDirectory(), "Tarball does not contain package/");
    return await operation({ packageDirectory, archiveEntries, temporaryDirectory });
  } finally {
    if (process.env.PI_LEETCODE_KEEP_VERIFY_TEMP === "1") {
      console.log(`Verification files retained at ${temporaryDirectory}`);
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

export function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
