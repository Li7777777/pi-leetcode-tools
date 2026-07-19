import { open, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Clock, IdGenerator } from "./abstractions.js";
import { randomIdGenerator, systemClock } from "./abstractions.js";

export const OPERATION_STORE_SCHEMA_VERSION = 2 as const;

export interface OperationRecord {
  operationId: string;
}

export interface OperationStore<T extends OperationRecord> {
  get(operationId: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  save(record: T): Promise<void>;
  update(
    operationId: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined>;
  remove(operationId: string): Promise<boolean>;
}

export interface AtomicJsonOperationStoreOptions<T extends OperationRecord> {
  validate?: (value: unknown) => value is T;
  idGenerator?: IdGenerator;
  forbiddenKeys?: readonly string[];
  clock?: Clock;
  retentionPolicy?: OperationStoreRetentionPolicy<T>;
}

export interface OperationStoreRetentionPolicy<T extends OperationRecord> {
  maxRecords: number;
  terminalRetentionMs: number;
  isTerminal(record: T): boolean;
  updatedAt(record: T): Date | number | string;
}

interface StoreEnvelope<T> {
  schemaVersion: typeof OPERATION_STORE_SCHEMA_VERSION;
  records: Record<string, T>;
}

export class OperationStoreCorruptError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause?: unknown) {
    super(`Operation store is corrupt: ${filePath}`, { cause });
    this.name = "OperationStoreCorruptError";
    this.filePath = filePath;
  }
}

export class OperationStorePolicyError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Operation store policy forbids persisting field: ${field}`);
    this.name = "OperationStorePolicyError";
    this.field = field;
  }
}

export class OperationStoreUnsupportedVersionError extends Error {
  readonly filePath: string;
  readonly schemaVersion: number;

  constructor(filePath: string, schemaVersion: number) {
    super(
      `Operation store schema version ${schemaVersion} is newer than supported version ${OPERATION_STORE_SCHEMA_VERSION}: ${filePath}`
    );
    this.name = "OperationStoreUnsupportedVersionError";
    this.filePath = filePath;
    this.schemaVersion = schemaVersion;
  }
}

export class OperationStoreCapacityError extends Error {
  readonly filePath: string;
  readonly maxRecords: number;
  readonly protectedRecords: number;

  constructor(filePath: string, maxRecords: number, protectedRecords: number) {
    super(
      `Operation store capacity ${maxRecords} is exhausted by ${protectedRecords} non-evictable records: ${filePath}`
    );
    this.name = "OperationStoreCapacityError";
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.protectedRecords = protectedRecords;
  }
}

const DEFAULT_FORBIDDEN_KEYS = [
  "authorization",
  "check",
  "checkUrl",
  "code",
  "confirmationToken",
  "cookie",
  "credentials",
  "csrfToken",
  "expectedOutput",
  "hiddenTests",
  "input",
  "lastTestcase",
  "questionId",
  "session",
  "start",
  "stdout",
  "testcases",
  "token",
  "__proto__",
  "constructor",
  "prototype"
] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function emptyRecords<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Serializes writes within one process. Wrap cross-process read/modify/write sequences in a LockStore lease.
 */
export class AtomicJsonOperationStore<T extends OperationRecord> implements OperationStore<T> {
  readonly filePath: string;
  readonly #validate: ((value: unknown) => value is T) | undefined;
  readonly #idGenerator: IdGenerator;
  readonly #forbiddenKeys: ReadonlySet<string>;
  readonly #clock: Clock;
  readonly #retentionPolicy: OperationStoreRetentionPolicy<T> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: AtomicJsonOperationStoreOptions<T> = {}) {
    this.filePath = filePath;
    this.#validate = options.validate;
    this.#idGenerator = options.idGenerator ?? randomIdGenerator;
    this.#clock = options.clock ?? systemClock;
    this.#retentionPolicy = options.retentionPolicy;
    if (this.#retentionPolicy !== undefined) {
      positiveInteger(this.#retentionPolicy.maxRecords, "retentionPolicy.maxRecords");
      nonNegativeInteger(
        this.#retentionPolicy.terminalRetentionMs,
        "retentionPolicy.terminalRetentionMs"
      );
    }
    this.#forbiddenKeys = new Set(
      [...DEFAULT_FORBIDDEN_KEYS, ...(options.forbiddenKeys ?? [])].map(canonicalKey)
    );
  }

  get(operationId: string): Promise<T | undefined> {
    return this.#serialized(async () => {
      const envelope = await this.#read();
      const record = envelope.records[operationId];
      return record === undefined ? undefined : clone(record);
    });
  }

  list(): Promise<T[]> {
    return this.#serialized(async () => {
      const envelope = await this.#read();
      return Object.values(envelope.records).map((record) => clone(record));
    });
  }

  save(record: T): Promise<void> {
    return this.#serialized(async () => {
      this.#assertRecord(record);
      const envelope = await this.#read();
      const isNew = envelope.records[record.operationId] === undefined;
      envelope.records[record.operationId] = clone(record);
      this.#applyRetention(envelope, record.operationId, isNew);
      await this.#write(envelope);
    });
  }

  update(
    operationId: string,
    updater: (current: T | undefined) => T | undefined
  ): Promise<T | undefined> {
    return this.#serialized(async () => {
      const envelope = await this.#read();
      const current = envelope.records[operationId];
      const next = updater(current === undefined ? undefined : clone(current));
      if (next === undefined) {
        delete envelope.records[operationId];
      } else {
        this.#assertRecord(next);
        if (next.operationId !== operationId) {
          throw new Error("An operation update cannot change operationId");
        }
        envelope.records[operationId] = clone(next);
      }
      this.#applyRetention(envelope, next?.operationId, current === undefined && next !== undefined);
      await this.#write(envelope);
      return next === undefined ? undefined : clone(next);
    });
  }

  remove(operationId: string): Promise<boolean> {
    return this.#serialized(async () => {
      const envelope = await this.#read();
      if (!(operationId in envelope.records)) {
        return false;
      }
      delete envelope.records[operationId];
      await this.#write(envelope);
      return true;
    });
  }

  #serialized<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #read(): Promise<StoreEnvelope<T>> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          schemaVersion: OPERATION_STORE_SCHEMA_VERSION,
          records: emptyRecords<T>()
        };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new OperationStoreCorruptError(this.filePath, error);
    }

    let sourceSchemaVersion: number | undefined;
    let envelope: StoreEnvelope<T>;
    try {
      if (!isObject(parsed) || !isObject(parsed.records)) {
        throw new Error("Invalid operation store envelope");
      }
      const schemaVersion = parsed.schemaVersion;
      if (schemaVersion === undefined && parsed.version === 1) {
        sourceSchemaVersion = 1;
      } else if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) {
        throw new Error("Invalid operation store schemaVersion");
      } else if ((schemaVersion as number) > OPERATION_STORE_SCHEMA_VERSION) {
        throw new OperationStoreUnsupportedVersionError(
          this.filePath,
          schemaVersion as number
        );
      } else if ((schemaVersion as number) < OPERATION_STORE_SCHEMA_VERSION) {
        sourceSchemaVersion = schemaVersion as number;
      }

      const records = emptyRecords<T>();
      for (const [operationId, value] of Object.entries(parsed.records)) {
        if (!isObject(value) || value.operationId !== operationId) {
          throw new Error("Invalid operation record key");
        }
        if (this.#validate !== undefined && !this.#validate(value)) {
          throw new Error("Operation record validation failed");
        }
        this.#assertPolicy(value);
        records[operationId] = value as T;
      }
      envelope = {
        schemaVersion: OPERATION_STORE_SCHEMA_VERSION,
        records
      };
    } catch (error) {
      if (error instanceof OperationStoreUnsupportedVersionError) {
        throw error;
      }
      throw new OperationStoreCorruptError(this.filePath, error);
    }
    if (sourceSchemaVersion !== undefined) {
      await this.#backupBeforeMigration(text, sourceSchemaVersion);
      await this.#write(envelope);
    }
    return envelope;
  }

  async #write(envelope: StoreEnvelope<T>): Promise<void> {
    await this.#writeText(
      this.filePath,
      `${JSON.stringify(envelope, null, 2)}\n`
    );
  }

  async #backupBeforeMigration(text: string, sourceSchemaVersion: number): Promise<void> {
    const backupPath = `${this.filePath}.schema-${sourceSchemaVersion}.${this.#idGenerator.generate("backup")}.bak`;
    await this.#writeText(backupPath, text);
  }

  async #writeText(targetPath: string, text: string): Promise<void> {
    const directory = dirname(targetPath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      `.${basename(targetPath)}.${process.pid}.${this.#idGenerator.generate("tmp")}`
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporaryPath, targetPath);
      await this.#syncDirectory(directory);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EISDIR" && code !== "EINVAL" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
    }
  }

  #assertRecord(record: T): void {
    if (record.operationId.length === 0) {
      throw new Error("operationId must not be empty");
    }
    if (this.#validate !== undefined && !this.#validate(record)) {
      throw new Error("Operation record validation failed");
    }
    this.#assertPolicy(record);
  }

  #applyRetention(
    envelope: StoreEnvelope<T>,
    protectedOperationId: string | undefined,
    addingNewRecord: boolean
  ): void {
    const policy = this.#retentionPolicy;
    if (policy === undefined) {
      return;
    }

    const now = this.#clock.now().getTime();
    const terminalRecords: Array<{ operationId: string; updatedAt: number }> = [];
    for (const [operationId, record] of Object.entries(envelope.records)) {
      if (!policy.isTerminal(record)) {
        continue;
      }
      const updatedAt = timestamp(policy.updatedAt(record), operationId);
      if (
        operationId !== protectedOperationId &&
        updatedAt + policy.terminalRetentionMs <= now
      ) {
        delete envelope.records[operationId];
        continue;
      }
      if (operationId !== protectedOperationId) {
        terminalRecords.push({ operationId, updatedAt });
      }
    }

    terminalRecords.sort(
      (left, right) =>
        left.updatedAt - right.updatedAt ||
        left.operationId.localeCompare(right.operationId)
    );
    while (
      Object.keys(envelope.records).length > policy.maxRecords &&
      terminalRecords.length > 0
    ) {
      const oldest = terminalRecords.shift();
      if (oldest !== undefined) {
        delete envelope.records[oldest.operationId];
      }
    }

    const recordCount = Object.keys(envelope.records).length;
    if (addingNewRecord && recordCount > policy.maxRecords) {
      const protectedRecords = Object.values(envelope.records).filter(
        (record) => !policy.isTerminal(record)
      ).length;
      throw new OperationStoreCapacityError(
        this.filePath,
        policy.maxRecords,
        protectedRecords
      );
    }
  }

  #assertPolicy(value: unknown, seen = new WeakSet<object>()): void {
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        this.#assertPolicy(item, seen);
      }
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (this.#forbiddenKeys.has(canonicalKey(key))) {
        throw new OperationStorePolicyError(key);
      }
      this.#assertPolicy(item, seen);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function timestamp(value: Date | number | string, operationId: string): number {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Operation ${operationId} has an invalid retention timestamp`);
  }
  return parsed;
}
