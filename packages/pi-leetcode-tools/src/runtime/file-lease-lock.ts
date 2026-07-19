import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Clock, IdGenerator } from "./abstractions.js";
import {
  randomIdGenerator,
  systemClock,
  throwIfAborted
} from "./abstractions.js";
import { sha256Hex } from "./hash.js";

export interface LeaseHandle {
  readonly keyHash: string;
  readonly ownerId: string;
  readonly token: string;
  readonly expiresAt: Date;
  assertOwned(): Promise<void>;
  renew(ttlMs?: number): Promise<void>;
  release(): Promise<void>;
}

export interface LockStore {
  acquire(key: string, options: AcquireLeaseOptions): Promise<LeaseHandle>;
  close(): Promise<void>;
}

export interface FileLeaseLockOptions {
  directory: string;
  defaultTtlMs?: number;
  retryDelayMs?: number;
  clock?: Clock;
  idGenerator?: IdGenerator;
}

export interface AcquireLeaseOptions {
  ownerId: string;
  ttlMs?: number;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
}

interface LeasePayload {
  version: 1;
  keyHash: string;
  ownerId: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

interface MutationGuardPayload {
  version: 1;
  keyHash: string;
  token: string;
  expiresAt: string;
}

interface MutationGuard {
  keyHash: string;
  token: string;
}

interface ClaimedLease {
  path: string;
  payload: LeasePayload | undefined;
}

const MUTATION_GUARD_TTL_MS = 10_000;

export class LeaseUnavailableError extends Error {
  readonly keyHash: string;

  constructor(keyHash: string) {
    super(`Lease is unavailable for key ${keyHash}`);
    this.name = "LeaseUnavailableError";
    this.keyHash = keyHash;
  }
}

export class LeaseLostError extends Error {
  readonly keyHash: string;

  constructor(keyHash: string) {
    super(`Lease ownership was lost for key ${keyHash}`);
    this.name = "LeaseLostError";
    this.keyHash = keyHash;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function validOwnerId(ownerId: string): boolean {
  return ownerId.length > 0 && ownerId.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(ownerId);
}

function parseLease(value: string): LeasePayload | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const candidate = parsed as Partial<LeasePayload>;
    if (
      candidate.version !== 1 ||
      typeof candidate.keyHash !== "string" ||
      typeof candidate.ownerId !== "string" ||
      typeof candidate.token !== "string" ||
      typeof candidate.acquiredAt !== "string" ||
      typeof candidate.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.expiresAt))
    ) {
      return undefined;
    }
    return candidate as LeasePayload;
  } catch {
    return undefined;
  }
}

function parseMutationGuard(value: string): MutationGuardPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const candidate = parsed as Partial<MutationGuardPayload>;
    if (
      candidate.version !== 1 ||
      typeof candidate.keyHash !== "string" ||
      typeof candidate.token !== "string" ||
      typeof candidate.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.expiresAt))
    ) {
      return undefined;
    }
    return candidate as MutationGuardPayload;
  } catch {
    return undefined;
  }
}

class FileLeaseHandle implements LeaseHandle {
  readonly keyHash: string;
  readonly ownerId: string;
  readonly token: string;
  #expiresAt: Date;
  readonly #ttlMs: number;
  readonly #lock: FileLeaseLock;
  #released = false;
  #releasePromise: Promise<void> | undefined;

  constructor(lock: FileLeaseLock, payload: LeasePayload, ttlMs: number) {
    this.#lock = lock;
    this.keyHash = payload.keyHash;
    this.ownerId = payload.ownerId;
    this.token = payload.token;
    this.#expiresAt = new Date(payload.expiresAt);
    this.#ttlMs = ttlMs;
  }

  get expiresAt(): Date {
    return new Date(this.#expiresAt);
  }

  async assertOwned(): Promise<void> {
    if (this.#released || !(await this.#lock.isOwned(this.keyHash, this.token))) {
      throw new LeaseLostError(this.keyHash);
    }
  }

  async renew(ttlMs = this.#ttlMs): Promise<void> {
    if (this.#released) {
      throw new LeaseLostError(this.keyHash);
    }
    this.#expiresAt = await this.#lock.renew(this.keyHash, this.token, ttlMs);
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    if (this.#releasePromise !== undefined) {
      return this.#releasePromise;
    }
    const releasePromise = this.#lock
      .release(this.keyHash, this.token)
      .then(() => {
        this.#released = true;
      })
      .finally(() => {
        this.#releasePromise = undefined;
      });
    this.#releasePromise = releasePromise;
    return releasePromise;
  }
}

/**
 * A cooperative local-filesystem lease based on atomic directory creation.
 * Callers should assert the fencing token immediately before consequential work.
 */
export class FileLeaseLock implements LockStore {
  readonly #directory: string;
  readonly #defaultTtlMs: number;
  readonly #retryDelayMs: number;
  readonly #clock: Clock;
  readonly #idGenerator: IdGenerator;
  readonly #handles = new Set<FileLeaseHandle>();
  #closed = false;

  constructor(options: FileLeaseLockOptions) {
    this.#directory = options.directory;
    this.#defaultTtlMs = positiveInteger(options.defaultTtlMs ?? 30_000, "defaultTtlMs");
    this.#retryDelayMs = positiveInteger(options.retryDelayMs ?? 50, "retryDelayMs");
    this.#clock = options.clock ?? systemClock;
    this.#idGenerator = options.idGenerator ?? randomIdGenerator;
  }

  async acquire(key: string, options: AcquireLeaseOptions): Promise<LeaseHandle> {
    if (this.#closed) {
      throw new Error("Lock store is closed");
    }
    if (key.length === 0) {
      throw new Error("Lease key must not be empty");
    }
    if (!validOwnerId(options.ownerId)) {
      throw new Error("Lease ownerId is invalid");
    }
    throwIfAborted(options.signal);

    const keyHash = sha256Hex(key);
    const ttlMs = positiveInteger(options.ttlMs ?? this.#defaultTtlMs, "ttlMs");
    const waitTimeoutMs = options.waitTimeoutMs ?? 0;
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
      throw new RangeError("waitTimeoutMs must be a non-negative finite number");
    }
    const deadline = this.#clock.now().getTime() + waitTimeoutMs;
    await mkdir(this.#directory, { recursive: true });

    while (true) {
      throwIfAborted(options.signal);
      const guard = await this.#tryAcquireMutationGuard(keyHash);
      if (guard !== undefined) {
        try {
          let payload = this.#newPayload(keyHash, options.ownerId, ttlMs);
          if (await this.#tryCreate(payload)) {
            const handle = new FileLeaseHandle(this, payload, ttlMs);
            this.#handles.add(handle);
            return handle;
          }
          await this.#removeIfExpiredGuarded(keyHash);
          payload = this.#newPayload(keyHash, options.ownerId, ttlMs);
          if (await this.#tryCreate(payload)) {
            const handle = new FileLeaseHandle(this, payload, ttlMs);
            this.#handles.add(handle);
            return handle;
          }
        } finally {
          await this.#releaseMutationGuard(guard);
        }
      }

      const remaining = deadline - this.#clock.now().getTime();
      if (remaining <= 0) {
        throw new LeaseUnavailableError(keyHash);
      }
      await this.#clock.sleep(Math.min(this.#retryDelayMs, remaining), options.signal);
    }
  }

  async isOwned(keyHash: string, token: string): Promise<boolean> {
    const payload = await this.#read(keyHash);
    return (
      payload?.token === token && Date.parse(payload.expiresAt) > this.#clock.now().getTime()
    );
  }

  async renew(keyHash: string, token: string, ttlMs: number): Promise<Date> {
    positiveInteger(ttlMs, "ttlMs");
    const guard = await this.#acquireMutationGuard(keyHash);
    if (guard === undefined) {
      throw new LeaseLostError(keyHash);
    }
    try {
      const claim = await this.#claimLease(keyHash);
      const now = this.#clock.now();
      if (
        claim === undefined ||
        claim.payload?.token !== token ||
        Date.parse(claim.payload.expiresAt) <= now.getTime()
      ) {
        if (claim !== undefined) {
          await this.#restoreLeaseClaim(keyHash, claim);
        }
        throw new LeaseLostError(keyHash);
      }
      const expiresAt = new Date(now.getTime() + ttlMs);
      const next: LeasePayload = {
        ...claim.payload,
        expiresAt: expiresAt.toISOString()
      };
      await this.#writePayloadAt(claim.path, next);
      if (!(await this.#restoreLeaseClaim(keyHash, { ...claim, payload: next }))) {
        throw new LeaseLostError(keyHash);
      }
      const current = await this.#read(keyHash);
      if (current?.token !== token || current.expiresAt !== next.expiresAt) {
        throw new LeaseLostError(keyHash);
      }
      return expiresAt;
    } finally {
      await this.#releaseMutationGuard(guard);
    }
  }

  async release(keyHash: string, token: string): Promise<void> {
    const guard = await this.#acquireMutationGuard(keyHash);
    if (guard !== undefined) {
      try {
        const claim = await this.#claimLease(keyHash);
        if (claim !== undefined) {
          if (claim.payload?.token === token) {
            await this.#removePath(claim.path, true);
          } else {
            await this.#restoreLeaseClaim(keyHash, claim);
          }
        }
      } finally {
        await this.#releaseMutationGuard(guard);
      }
    }
    for (const handle of this.#handles) {
      if (handle.keyHash === keyHash && handle.token === token) {
        this.#handles.delete(handle);
        break;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#handles].map((handle) => handle.release())
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length > 0) {
      this.#closed = false;
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Failed to release every file lease"
      );
    }
    this.#handles.clear();
  }

  #newPayload(keyHash: string, ownerId: string, ttlMs: number): LeasePayload {
    const acquiredAt = this.#clock.now();
    return {
      version: 1,
      keyHash,
      ownerId,
      token: this.#idGenerator.generate("lease"),
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + ttlMs).toISOString()
    };
  }

  async #tryCreate(payload: LeasePayload): Promise<boolean> {
    const leasePath = this.#leasePath(payload.keyHash);
    try {
      await mkdir(leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }

    try {
      await writeFile(join(leasePath, "lease.json"), `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      return true;
    } catch (error) {
      await this.#removePath(leasePath, true);
      throw error;
    }
  }

  async #removeIfExpiredGuarded(keyHash: string): Promise<void> {
    const observed = await this.#read(keyHash);
    let expired = false;
    if (observed !== undefined) {
      expired = Date.parse(observed.expiresAt) <= this.#clock.now().getTime();
    } else {
      try {
        const details = await stat(this.#leasePath(keyHash));
        expired = details.mtimeMs + this.#defaultTtlMs <= this.#clock.now().getTime();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (!expired) {
      return;
    }

    const claim = await this.#claimLease(keyHash);
    if (claim === undefined) {
      return;
    }
    let stillExpired = false;
    if (claim.payload !== undefined) {
      stillExpired = Date.parse(claim.payload.expiresAt) <= this.#clock.now().getTime();
    } else {
      const details = await stat(claim.path);
      stillExpired = details.mtimeMs + this.#defaultTtlMs <= this.#clock.now().getTime();
    }
    const sameGeneration = observed === undefined || claim.payload?.token === observed.token;
    if (sameGeneration && stillExpired) {
      await this.#removePath(claim.path, true);
      return;
    }
    await this.#restoreLeaseClaim(keyHash, claim);
  }

  async #pathAvailable(keyHash: string): Promise<boolean> {
    try {
      await stat(this.#leasePath(keyHash));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      throw error;
    }
  }

  async #read(keyHash: string): Promise<LeasePayload | undefined> {
    try {
      return parseLease(await readFile(join(this.#leasePath(keyHash), "lease.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async #writePayloadAt(leasePath: string, payload: LeasePayload): Promise<void> {
    const temporaryPath = join(leasePath, `lease.${this.#idGenerator.generate("tmp")}.json`);
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    try {
      await this.#renamePath(temporaryPath, join(leasePath, "lease.json"));
    } catch (error) {
      await this.#removePath(temporaryPath, false);
      throw error;
    }
  }

  async #claimLease(keyHash: string): Promise<ClaimedLease | undefined> {
    const claimPath = join(
      this.#directory,
      `${keyHash}.lease-claim-${this.#idGenerator.generate("claim")}`
    );
    try {
      await this.#renamePath(this.#leasePath(keyHash), claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return {
      path: claimPath,
      payload: await this.#readLeaseAt(claimPath)
    };
  }

  async #restoreLeaseClaim(keyHash: string, claim: ClaimedLease): Promise<boolean> {
    try {
      await this.#renamePath(claim.path, this.#leasePath(keyHash));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        await this.#removePath(claim.path, true);
        return false;
      }
      if (code === "EPERM" && !(await this.#pathAvailable(keyHash))) {
        await this.#removePath(claim.path, true);
        return false;
      }
      throw error;
    }
  }

  async #readLeaseAt(path: string): Promise<LeasePayload | undefined> {
    try {
      return parseLease(await readFile(join(path, "lease.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async #tryAcquireMutationGuard(keyHash: string): Promise<MutationGuard | undefined> {
    const guard = this.#newMutationGuard(keyHash);
    if (await this.#tryCreateMutationGuard(guard)) {
      return { keyHash, token: guard.token };
    }
    if (!(await this.#removeExpiredMutationGuard(keyHash))) {
      return undefined;
    }
    const retry = this.#newMutationGuard(keyHash);
    return (await this.#tryCreateMutationGuard(retry))
      ? { keyHash, token: retry.token }
      : undefined;
  }

  async #acquireMutationGuard(keyHash: string): Promise<MutationGuard | undefined> {
    const deadline = this.#clock.now().getTime() + this.#defaultTtlMs;
    while (true) {
      const guard = await this.#tryAcquireMutationGuard(keyHash);
      if (guard !== undefined) {
        return guard;
      }
      const remaining = deadline - this.#clock.now().getTime();
      if (remaining <= 0) {
        return undefined;
      }
      await this.#clock.sleep(Math.min(this.#retryDelayMs, remaining));
    }
  }

  #newMutationGuard(keyHash: string): MutationGuardPayload {
    const now = this.#clock.now().getTime();
    return {
      version: 1,
      keyHash,
      token: this.#idGenerator.generate("guard"),
      expiresAt: new Date(now + MUTATION_GUARD_TTL_MS).toISOString()
    };
  }

  async #tryCreateMutationGuard(payload: MutationGuardPayload): Promise<boolean> {
    const guardPath = this.#guardPath(payload.keyHash);
    try {
      await mkdir(guardPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
    try {
      await writeFile(join(guardPath, "guard.json"), `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      return true;
    } catch (error) {
      await this.#removePath(guardPath, true);
      throw error;
    }
  }

  async #removeExpiredMutationGuard(keyHash: string): Promise<boolean> {
    const guardPath = this.#guardPath(keyHash);
    const observed = await this.#readMutationGuard(guardPath);
    let expired = false;
    if (observed !== undefined) {
      expired = Date.parse(observed.expiresAt) <= this.#clock.now().getTime();
    } else {
      try {
        const details = await stat(guardPath);
        expired = details.mtimeMs + MUTATION_GUARD_TTL_MS <= this.#clock.now().getTime();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return true;
        }
        throw error;
      }
    }
    if (!expired) {
      return false;
    }

    const claimPath = this.#guardClaimPath(keyHash);
    try {
      await this.#renamePath(guardPath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      throw error;
    }
    const claimed = await this.#readMutationGuard(claimPath);
    const stillExpired =
      claimed === undefined
        ? true
        : Date.parse(claimed.expiresAt) <= this.#clock.now().getTime();
    const sameGeneration = observed === undefined || claimed?.token === observed.token;
    if (sameGeneration && stillExpired) {
      await this.#removePath(claimPath, true);
      return true;
    }
    await this.#restoreClaim(claimPath, guardPath);
    return false;
  }

  async #releaseMutationGuard(guard: MutationGuard): Promise<void> {
    const guardPath = this.#guardPath(guard.keyHash);
    const claimPath = this.#guardClaimPath(guard.keyHash);
    try {
      await this.#renamePath(guardPath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    const claimed = await this.#readMutationGuard(claimPath);
    if (claimed?.token === guard.token) {
      await this.#removePath(claimPath, true);
      return;
    }
    await this.#restoreClaim(claimPath, guardPath);
  }

  async #restoreClaim(claimPath: string, targetPath: string): Promise<void> {
    try {
      await this.#renamePath(claimPath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        await this.#removePath(claimPath, true);
        return;
      }
      if (code === "EPERM" && !(await this.#pathAvailableByPath(targetPath))) {
        await this.#removePath(claimPath, true);
        return;
      }
      throw error;
    }
  }

  async #readMutationGuard(path: string): Promise<MutationGuardPayload | undefined> {
    try {
      return parseMutationGuard(await readFile(join(path, "guard.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async #pathAvailableByPath(path: string): Promise<boolean> {
    try {
      await stat(path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      throw error;
    }
  }

  async #renamePath(source: string, target: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(source, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          attempt >= 19 ||
          (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(5 + attempt * 2, 25)));
      }
    }
  }

  async #removePath(path: string, recursive: boolean): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(path, { recursive, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          attempt >= 19 ||
          (code !== "EPERM" &&
            code !== "EBUSY" &&
            code !== "EACCES" &&
            code !== "ENOTEMPTY")
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(5 + attempt * 2, 25)));
      }
    }
  }

  #leasePath(keyHash: string): string {
    return join(this.#directory, `${keyHash}.lease`);
  }

  #guardPath(keyHash: string): string {
    return join(this.#directory, `${keyHash}.guard`);
  }

  #guardClaimPath(keyHash: string): string {
    return join(
      this.#directory,
      `${keyHash}.guard-claim-${this.#idGenerator.generate("claim")}`
    );
  }
}
