import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import {
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  transpileModule
} from "typescript";

import type { Clock, IdGenerator } from "../../src/runtime/abstractions.js";
import {
  FileLeaseLock,
  LeaseLostError,
  LeaseUnavailableError
} from "../../src/runtime/file-lease-lock.js";
import { sha256Hex } from "../../src/runtime/hash.js";

class ManualClock implements Clock {
  #now = Date.parse("2026-07-15T00:00:00.000Z");

  now(): Date {
    return new Date(this.#now);
  }

  sleep(_delayMs: number, _signal?: AbortSignal): Promise<void> {
    throw new Error("Unexpected sleep");
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

class AdvancingClock extends ManualClock {
  override async sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    this.advance(delayMs);
  }
}

class SequenceIds implements IdGenerator {
  #next = 0;

  generate(prefix = "id"): string {
    this.#next += 1;
    return `${prefix}-${this.#next}`;
  }
}

const directories: string[] = [];
const stores = new Set<FileLeaseLock>();
const children = new Set<ChildProcessWithoutNullStreams>();

interface ChildState {
  stdout: string;
  stderr: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const childStates = new WeakMap<ChildProcessWithoutNullStreams, ChildState>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-leetcode-lock-"));
  directories.push(directory);
  return directory;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function trackedStore(
  options: ConstructorParameters<typeof FileLeaseLock>[0]
): FileLeaseLock {
  const store = new FileLeaseLock(options);
  stores.add(store);
  return store;
}

async function compileChildRuntime(directory: string): Promise<string> {
  const runtimeDirectory = join(directory, "child-runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const sourceDirectory = fileURLToPath(new URL("../../src/runtime/", import.meta.url));
  for (const name of ["abstractions", "hash", "file-lease-lock"] as const) {
    const source = await readFile(join(sourceDirectory, `${name}.ts`), "utf8");
    const output = transpileModule(source, {
      fileName: `${name}.ts`,
      compilerOptions: {
        target: ScriptTarget.ES2023,
        module: ModuleKind.NodeNext,
        moduleResolution: ModuleResolutionKind.NodeNext,
        verbatimModuleSyntax: true
      }
    }).outputText;
    await writeFile(join(runtimeDirectory, `${name}.js`), output, "utf8");
  }

  const childPath = join(directory, "lease-child.mjs");
  await writeFile(
    childPath,
    `import { appendFile, readFile, writeFile } from "node:fs/promises";
import { FileLeaseLock, LeaseLostError } from "./child-runtime/file-lease-lock.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForCommand(path) {
  while (true) {
    try {
      await readFile(path, "utf8");
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await sleep(10);
    }
  }
}

const [mode, directory, key, id, pathA, valueA, valueB] = process.argv.slice(2);
const lock = new FileLeaseLock({ directory, retryDelayMs: 10 });

if (mode === "sequence") {
  const handle = await lock.acquire(key, {
    ownerId: id,
    ttlMs: Number(valueA),
    waitTimeoutMs: 60_000
  });
  await appendFile(pathA, \`enter \${id} \${handle.token}\\n\`, "utf8");
  await sleep(Number(valueB));
  await appendFile(pathA, \`exit \${id} \${handle.token}\\n\`, "utf8");
  await handle.release();
  await lock.close();
} else if (mode === "crash") {
  const handle = await lock.acquire(key, { ownerId: id, ttlMs: Number(valueA) });
  await writeFile(pathA, handle.token, "utf8");
  setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
} else if (mode === "late") {
  const handle = await lock.acquire(key, { ownerId: id, ttlMs: Number(valueA) });
  await writeFile(pathA, handle.token, "utf8");
  await waitForCommand(valueB);
  let renewLost = false;
  try {
    await handle.renew(30_000);
  } catch (error) {
    renewLost = error instanceof LeaseLostError;
  }
  await handle.release();
  process.stdout.write(JSON.stringify({ renewLost, token: handle.token }));
  await lock.close();
} else {
  throw new Error(\`Unknown child mode: \${mode}\`);
}
`,
    "utf8"
  );
  return childPath;
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 60_000
): Promise<{ stdout: string; stderr: string }> {
  const state = childStates.get(child);
  if (state === undefined) {
    throw new Error("Child process is not tracked");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      state.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Child process timed out: ${state.stderr}`)),
          timeoutMs
        );
      })
    ]);
    if (result.code !== 0) {
      throw new Error(
        `Child exited with code ${result.code} signal ${result.signal}: ${state.stderr}`
      );
    }
    return { stdout: state.stdout, stderr: state.stderr };
  } catch (error) {
    await terminateChild(child);
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function spawnLeaseChild(script: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [script, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
}

function trackLeaseChild(
  script: string,
  args: string[]
): ChildProcessWithoutNullStreams {
  const child = spawnLeaseChild(script, args);
  const state: ChildState = {
    stdout: "",
    stderr: "",
    exit: Promise.resolve({ code: null, signal: null })
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    state.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    state.stderr += chunk;
  });
  state.exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  childStates.set(child, state);
  children.add(child);
  void state.exit.finally(() => children.delete(child)).catch(() => undefined);
  return child;
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<void> {
  const state = childStates.get(child);
  if (state === undefined) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      state.exit.then(() => undefined, () => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Child did not exit")), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await waitForProcessExit(child, 5_000);
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true }
    );
    await new Promise<void>((resolve) => {
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
  } else {
    child.kill("SIGKILL");
  }
  await waitForProcessExit(child, 10_000);
}

afterEach(async () => {
  const childResults = await Promise.allSettled([...children].map(terminateChild));
  const storeResults = await Promise.allSettled([...stores].map((store) => store.close()));
  children.clear();
  stores.clear();
  const directoryResults = await Promise.allSettled(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50
      })
    )
  );
  const failure = [...childResults, ...storeResults, ...directoryResults].find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure !== undefined) {
    throw failure.reason;
  }
});

describe("FileLeaseLock", { timeout: 30_000 }, () => {
  it("provides mutual exclusion and stores only a hash of the logical key in paths", async () => {
    const directory = await temporaryDirectory();
    const clock = new ManualClock();
    const ids = new SequenceIds();
    const firstStore = trackedStore({ directory, clock, idGenerator: ids });
    const secondStore = trackedStore({ directory, clock, idGenerator: ids });
    const logicalKey = "profile-a:global:two-sum";

    const first = await firstStore.acquire(logicalKey, { ownerId: "process-a" });
    await expect(
      secondStore.acquire(logicalKey, { ownerId: "process-b" })
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(await readdir(directory)).toEqual([`${sha256Hex(logicalKey)}.lease`]);
    expect((await readdir(directory)).join(" ")).not.toContain("two-sum");

    await first.release();
    const second = await secondStore.acquire(logicalKey, { ownerId: "process-b" });
    await expect(second.assertOwned()).resolves.toBeUndefined();
    await second.release();
  });

  it("reclaims an expired lease without allowing the stale owner to remove the new lease", async () => {
    const directory = await temporaryDirectory();
    const clock = new ManualClock();
    const ids = new SequenceIds();
    const firstStore = trackedStore({ directory, clock, idGenerator: ids });
    const secondStore = trackedStore({ directory, clock, idGenerator: ids });

    const stale = await firstStore.acquire("key", { ownerId: "old", ttlMs: 100 });
    clock.advance(101);
    const current = await secondStore.acquire("key", { ownerId: "new", ttlMs: 100 });
    await expect(stale.assertOwned()).rejects.toBeInstanceOf(LeaseLostError);
    await expect(stale.renew()).rejects.toBeInstanceOf(LeaseLostError);
    await stale.release();
    await expect(current.assertOwned()).resolves.toBeUndefined();
    await current.release();
  });

  it("renews a live lease and close releases owned handles", async () => {
    const directory = await temporaryDirectory();
    const clock = new ManualClock();
    const store = trackedStore({
      directory,
      clock,
      idGenerator: new SequenceIds(),
      defaultTtlMs: 100
    });
    const handle = await store.acquire("key", { ownerId: "owner" });
    const originalExpiry = handle.expiresAt.getTime();
    clock.advance(50);
    await handle.renew(200);
    expect(handle.expiresAt.getTime()).toBeGreaterThan(originalExpiry);

    await store.close();
    expect(await readdir(directory)).toEqual([]);
    await expect(handle.assertOwned()).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("honors a deterministic acquisition timeout", async () => {
    const directory = await temporaryDirectory();
    const clock = new AdvancingClock();
    const firstStore = trackedStore({
      directory,
      clock,
      idGenerator: new SequenceIds(),
      retryDelayMs: 10
    });
    const secondStore = trackedStore({
      directory,
      clock,
      idGenerator: new SequenceIds(),
      retryDelayMs: 10
    });
    const handle = await firstStore.acquire("key", { ownerId: "first", ttlMs: 1_000 });

    await expect(
      secondStore.acquire("key", { ownerId: "second", waitTimeoutMs: 25 })
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(clock.now().getTime()).toBe(Date.parse("2026-07-15T00:00:00.000Z") + 25);
    await handle.release();
  });

  it("serializes real child processes competing for the same key", async () => {
    const directory = await temporaryDirectory();
    const script = await compileChildRuntime(directory);
    const lockDirectory = join(directory, "locks");
    const logPath = join(directory, "critical-sections.log");
    const children = ["child-a", "child-b"].map((id) =>
      trackLeaseChild(script, [
        "sequence",
        lockDirectory,
        "shared-key",
        id,
        logPath,
        "60000",
        "100"
      ])
    );

    await Promise.all(children.map((child) => waitForChild(child, 90_000)));
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(events).toHaveLength(4);
    let active = 0;
    const tokens = new Set<string>();
    for (const event of events) {
      const [kind, , token] = event.split(" ");
      if (kind === "enter") {
        active += 1;
        expect(active).toBe(1);
        tokens.add(token!);
      } else {
        expect(kind).toBe("exit");
        active -= 1;
        expect(active).toBe(0);
      }
    }
    expect(tokens.size).toBe(2);
  }, 120_000);

  it("recovers an expired lease after the owning child process crashes", async () => {
    const directory = await temporaryDirectory();
    const script = await compileChildRuntime(directory);
    const lockDirectory = join(directory, "locks");
    const readyPath = join(directory, "crash-ready");
    const child = trackLeaseChild(script, [
      "crash",
      lockDirectory,
      "crash-key",
      "crashed-owner",
      readyPath,
      "1500",
      "unused"
    ]);
    await waitForFile(readyPath);
    await terminateChild(child);
    await delay(1_750);

    const survivor = trackedStore({ directory: lockDirectory, retryDelayMs: 25 });
    const handle = await survivor.acquire("crash-key", {
      ownerId: "survivor",
      ttlMs: 30_000,
      waitTimeoutMs: 30_000
    });
    await expect(handle.assertOwned()).resolves.toBeUndefined();
    await handle.release();
    await survivor.close();
  }, 90_000);

  it("fences a late child owner after a new generation acquires the expired lease", async () => {
    const directory = await temporaryDirectory();
    const script = await compileChildRuntime(directory);
    const lockDirectory = join(directory, "locks");
    const readyPath = join(directory, "late-ready");
    const commandPath = join(directory, "late-command");
    const child = trackLeaseChild(script, [
      "late",
      lockDirectory,
      "late-key",
      "late-owner",
      readyPath,
      "1500",
      commandPath
    ]);
    const staleToken = await waitForFile(readyPath);
    await delay(1_750);

    const currentStore = trackedStore({ directory: lockDirectory, retryDelayMs: 25 });
    const current = await currentStore.acquire("late-key", {
      ownerId: "current-owner",
      ttlMs: 30_000,
      waitTimeoutMs: 30_000
    });
    expect(current.token).not.toBe(staleToken);
    await writeFile(commandPath, "continue", "utf8");
    const childResult = await waitForChild(child, 60_000);
    expect(JSON.parse(childResult.stdout)).toMatchObject({ renewLost: true });
    await expect(current.assertOwned()).resolves.toBeUndefined();
    await current.release();
    await currentStore.close();
  }, 120_000);
});
