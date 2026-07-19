import type { Clock } from "./abstractions.js";
import { createAbortError, systemClock, throwIfAborted } from "./abstractions.js";

export interface RateLimiter {
  acquire(key: string, signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface TokenBucketRateLimiterOptions {
  capacity: number;
  refillTokens?: number;
  refillIntervalMs: number;
  maxQueue: number;
  clock?: Clock;
}

export class RateLimitQueueFullError extends Error {
  readonly key: string;
  readonly maxQueue: number;

  constructor(key: string, maxQueue: number) {
    super(`Rate limit queue is full for key ${key}`);
    this.name = "RateLimitQueueFullError";
    this.key = key;
    this.maxQueue = maxQueue;
  }
}

export class RateLimiterClosedError extends Error {
  constructor() {
    super("Rate limiter is closed");
    this.name = "RateLimiterClosedError";
  }
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

interface Bucket {
  tokens: number;
  lastRefillAt: number;
  queue: Waiter[];
  draining: boolean;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export class TokenBucketRateLimiter implements RateLimiter {
  readonly #capacity: number;
  readonly #refillTokens: number;
  readonly #refillIntervalMs: number;
  readonly #maxQueue: number;
  readonly #clock: Clock;
  readonly #buckets = new Map<string, Bucket>();
  readonly #closeController = new AbortController();
  #closed = false;

  constructor(options: TokenBucketRateLimiterOptions) {
    this.#capacity = positiveInteger(options.capacity, "capacity");
    this.#refillTokens = positiveInteger(options.refillTokens ?? 1, "refillTokens");
    this.#refillIntervalMs = positiveInteger(options.refillIntervalMs, "refillIntervalMs");
    if (!Number.isInteger(options.maxQueue) || options.maxQueue < 0) {
      throw new RangeError("maxQueue must be a non-negative integer");
    }
    this.#maxQueue = options.maxQueue;
    this.#clock = options.clock ?? systemClock;
  }

  acquire(key: string, signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new RateLimiterClosedError());
    }
    if (key.length === 0) {
      return Promise.reject(new Error("Rate limit key must not be empty"));
    }

    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }

    const bucket = this.#getBucket(key);
    this.#refill(bucket);
    if (bucket.queue.length === 0 && bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return Promise.resolve();
    }
    if (bucket.queue.length >= this.#maxQueue) {
      return Promise.reject(new RateLimitQueueFullError(key, this.#maxQueue));
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: undefined,
        settled: false
      };
      waiter.onAbort = () => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        bucket.queue = bucket.queue.filter((candidate) => candidate !== waiter);
        reject(createAbortError(signal?.reason));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      bucket.queue.push(waiter);
      this.#startDrain(key, bucket);
    });
  }

  pending(key?: string): number {
    if (key !== undefined) {
      return this.#buckets.get(key)?.queue.length ?? 0;
    }
    let count = 0;
    for (const bucket of this.#buckets.values()) {
      count += bucket.queue.length;
    }
    return count;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeController.abort(new RateLimiterClosedError());
    for (const bucket of this.#buckets.values()) {
      for (const waiter of bucket.queue.splice(0)) {
        this.#settle(waiter, new RateLimiterClosedError());
      }
    }
  }

  #getBucket(key: string): Bucket {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        tokens: this.#capacity,
        lastRefillAt: this.#clock.now().getTime(),
        queue: [],
        draining: false
      };
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }

  #refill(bucket: Bucket): void {
    const now = this.#clock.now().getTime();
    const intervals = Math.floor((now - bucket.lastRefillAt) / this.#refillIntervalMs);
    if (intervals <= 0) {
      return;
    }
    bucket.tokens = Math.min(
      this.#capacity,
      bucket.tokens + intervals * this.#refillTokens
    );
    bucket.lastRefillAt += intervals * this.#refillIntervalMs;
  }

  #startDrain(key: string, bucket: Bucket): void {
    if (bucket.draining || this.#closed) {
      return;
    }
    bucket.draining = true;
    void this.#drain(key, bucket);
  }

  async #drain(key: string, bucket: Bucket): Promise<void> {
    try {
      while (!this.#closed && bucket.queue.length > 0) {
        this.#refill(bucket);
        while (bucket.tokens >= 1 && bucket.queue.length > 0) {
          const waiter = bucket.queue.shift();
          if (waiter === undefined || waiter.settled) {
            continue;
          }
          bucket.tokens -= 1;
          this.#settle(waiter);
        }
        if (bucket.queue.length === 0) {
          break;
        }

        const now = this.#clock.now().getTime();
        const waitMs = Math.max(1, bucket.lastRefillAt + this.#refillIntervalMs - now);
        try {
          await this.#clock.sleep(waitMs, this.#closeController.signal);
        } catch {
          if (this.#closed) {
            break;
          }
        }
      }
    } finally {
      bucket.draining = false;
      if (!this.#closed && bucket.queue.length > 0) {
        this.#startDrain(key, bucket);
      }
    }
  }

  #settle(waiter: Waiter, error?: unknown): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    if (error === undefined) {
      waiter.resolve();
    } else {
      waiter.reject(error);
    }
  }
}
