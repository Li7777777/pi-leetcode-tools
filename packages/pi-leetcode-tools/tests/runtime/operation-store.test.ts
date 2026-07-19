import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OperationStatus } from "../../src/types.js";
import type { Clock, IdGenerator } from "../../src/runtime/abstractions.js";
import {
  AtomicJsonOperationStore,
  OPERATION_STORE_SCHEMA_VERSION,
  OperationStoreCapacityError,
  OperationStoreCorruptError,
  OperationStorePolicyError,
  OperationStoreUnsupportedVersionError
} from "../../src/runtime/operation-store.js";

interface TestOperation {
  operationId: string;
  state: "prepared" | "completed";
  codeHash: string;
}

interface RetainedOperation {
  operationId: string;
  state: "prepared" | "unknown" | "completed" | "failed";
  updatedAt: string;
}

class ManualClock implements Clock {
  #now = Date.parse("2026-07-15T00:00:00.000Z");

  now(): Date {
    return new Date(this.#now);
  }

  sleep(): Promise<void> {
    return Promise.reject(new Error("Unexpected sleep"));
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-leetcode-operation-store-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("AtomicJsonOperationStore", () => {
  it("serializes concurrent changes and returns defensive clones", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "operations.json");
    const store = new AtomicJsonOperationStore<TestOperation>(filePath, {
      idGenerator: new SequenceIds()
    });

    await Promise.all([
      store.save({ operationId: "op-1", state: "prepared", codeHash: "hash-1" }),
      store.save({ operationId: "op-2", state: "prepared", codeHash: "hash-2" })
    ]);
    const first = await store.get("op-1");
    expect(first).toEqual({ operationId: "op-1", state: "prepared", codeHash: "hash-1" });
    if (first !== undefined) {
      first.state = "completed";
    }
    await expect(store.get("op-1")).resolves.toMatchObject({ state: "prepared" });

    await expect(
      store.update("op-1", (operation) =>
        operation === undefined ? undefined : { ...operation, state: "completed" }
      )
    ).resolves.toMatchObject({ state: "completed" });
    await expect(store.list()).resolves.toHaveLength(2);
    await expect(store.remove("op-2")).resolves.toBe(true);
    await expect(store.remove("op-2")).resolves.toBe(false);

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaVersion: number;
      records: Record<string, TestOperation>;
    };
    expect(persisted.schemaVersion).toBe(OPERATION_STORE_SCHEMA_VERSION);
    expect(Object.keys(persisted.records)).toEqual(["op-1"]);
    expect((await readdir(directory)).filter((name) => name.startsWith(".operations"))).toEqual([]);
  });

  it("refuses corrupt input without overwriting it", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "operations.json");
    await writeFile(filePath, "not-json", "utf8");
    const store = new AtomicJsonOperationStore<TestOperation>(filePath);

    await expect(
      store.save({ operationId: "op-1", state: "prepared", codeHash: "hash" })
    ).rejects.toBeInstanceOf(OperationStoreCorruptError);
    await expect(readFile(filePath, "utf8")).resolves.toBe("not-json");
  });

  it("can validate records loaded from disk", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "operations.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, records: { invalid: { operationId: "invalid" } } }),
      "utf8"
    );
    const store = new AtomicJsonOperationStore<TestOperation>(filePath, {
      validate: (value): value is TestOperation =>
        typeof value === "object" &&
        value !== null &&
        "state" in value &&
        (value.state === "prepared" || value.state === "completed") &&
        "codeHash" in value &&
        typeof value.codeHash === "string"
    });

    await expect(store.list()).rejects.toBeInstanceOf(OperationStoreCorruptError);
  });

  it("migrates the legacy envelope only after creating a durable backup", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "operations.json");
    const legacy = `${JSON.stringify({
      version: 1,
      records: {
        "op-legacy": {
          operationId: "op-legacy",
          state: "prepared",
          codeHash: "hash"
        }
      }
    })}\n`;
    await writeFile(filePath, legacy, "utf8");
    const store = new AtomicJsonOperationStore<TestOperation>(filePath, {
      idGenerator: new SequenceIds()
    });

    await expect(store.list()).resolves.toEqual([
      { operationId: "op-legacy", state: "prepared", codeHash: "hash" }
    ]);
    const entries = await readdir(directory);
    const backup = entries.find((entry) => entry.endsWith(".bak"));
    expect(backup).toBeDefined();
    await expect(readFile(join(directory, backup!), "utf8")).resolves.toBe(legacy);
    const migrated = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaVersion: number;
      version?: number;
    };
    expect(migrated).toMatchObject({ schemaVersion: OPERATION_STORE_SCHEMA_VERSION });
    expect(migrated).not.toHaveProperty("version");
  });

  it("fails closed on a future schema without modifying or backing up the file", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "operations.json");
    const future = `${JSON.stringify({
      schemaVersion: OPERATION_STORE_SCHEMA_VERSION + 1,
      records: {}
    })}\n`;
    await writeFile(filePath, future, "utf8");
    const store = new AtomicJsonOperationStore<TestOperation>(filePath);

    await expect(store.list()).rejects.toBeInstanceOf(
      OperationStoreUnsupportedVersionError
    );
    await expect(readFile(filePath, "utf8")).resolves.toBe(future);
    await expect(readdir(directory)).resolves.toEqual(["operations.json"]);
  });

  it("evicts terminal records by retention and capacity but never evicts recoverable records", async () => {
    const directory = await temporaryDirectory();
    const clock = new ManualClock();
    const store = new AtomicJsonOperationStore<RetainedOperation>(
      join(directory, "operations.json"),
      {
        clock,
        retentionPolicy: {
          maxRecords: 2,
          terminalRetentionMs: 1_000,
          isTerminal: (record) =>
            record.state === "completed" || record.state === "failed",
          updatedAt: (record) => record.updatedAt
        }
      }
    );
    const old = new Date(clock.now().getTime() - 2_000).toISOString();
    const recent = clock.now().toISOString();

    await store.save({ operationId: "pending", state: "prepared", updatedAt: old });
    await store.save({ operationId: "completed", state: "completed", updatedAt: old });
    await store.save({ operationId: "unknown", state: "unknown", updatedAt: old });
    await expect(store.list()).resolves.toEqual([
      { operationId: "pending", state: "prepared", updatedAt: old },
      { operationId: "unknown", state: "unknown", updatedAt: old }
    ]);

    await expect(
      store.save({ operationId: "new-pending", state: "prepared", updatedAt: recent })
    ).rejects.toBeInstanceOf(OperationStoreCapacityError);
    await expect(store.list()).resolves.toHaveLength(2);

    await store.update("pending", (record) =>
      record === undefined ? undefined : { ...record, state: "completed", updatedAt: recent }
    );
    await store.save({ operationId: "new-pending", state: "prepared", updatedAt: recent });
    await expect(store.list()).resolves.toEqual([
      { operationId: "unknown", state: "unknown", updatedAt: old },
      { operationId: "new-pending", state: "prepared", updatedAt: recent }
    ]);
  });

  it("rejects confirmation tokens, credentials, source code, and transient judge envelopes at the persistence boundary", async () => {
    const directory = await temporaryDirectory();
    const store = new AtomicJsonOperationStore<
      TestOperation &
        { confirmationToken?: string; code?: string } &
        Record<string, unknown>
    >(join(directory, "operations.json"));

    await expect(
      store.save({
        operationId: "op-token",
        state: "prepared",
        codeHash: "hash",
        confirmationToken: "one-time-token"
      })
    ).rejects.toBeInstanceOf(OperationStorePolicyError);
    await expect(
      store.save({
        operationId: "op-code",
        state: "prepared",
        codeHash: "hash",
        code: "return 42"
      })
    ).rejects.toBeInstanceOf(OperationStorePolicyError);
    for (const key of ["start", "check", "checkUrl", "questionId", "stdout", "lastTestcase"]) {
      await expect(
        store.save({
          operationId: `op-${key}`,
          state: "prepared",
          codeHash: "hash",
          [key]: { canary: "must-not-persist" }
        })
      ).rejects.toBeInstanceOf(OperationStorePolicyError);
    }
    await expect(store.list()).resolves.toEqual([]);
  });

  it("preserves unknown outcomes and remote ids needed after a runtime restart", async () => {
    const directory = await temporaryDirectory();
    const store = new AtomicJsonOperationStore<OperationStatus>(
      join(directory, "operations.json")
    );
    const operation: OperationStatus = {
      operationId: "operation-unknown",
      kind: "submit",
      state: "unknown",
      region: "global",
      titleSlug: "two-sum",
      language: "typescript",
      codeHash: "sha256:hash",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:01:00.000Z",
      remoteId: "remote-submission-1"
    };

    await store.save(operation);
    await expect(store.get(operation.operationId)).resolves.toEqual(operation);
  });
});
