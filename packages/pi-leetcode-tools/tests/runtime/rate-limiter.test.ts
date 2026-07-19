import { describe, expect, it } from "vitest";

import type { Clock } from "../../src/runtime/abstractions.js";
import {
  RateLimiterClosedError,
  RateLimitQueueFullError,
  TokenBucketRateLimiter
} from "../../src/runtime/rate-limiter.js";

interface Sleeper {
  at: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

class ManualClock implements Clock {
  #now = 0;
  #sleepers: Sleeper[] = [];

  now(): Date {
    return new Date(this.#now);
  }

  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
      const sleeper: Sleeper = {
        at: this.#now + delayMs,
        resolve,
        reject,
        signal,
        onAbort: undefined
      };
      sleeper.onAbort = () => {
        this.#sleepers = this.#sleepers.filter((candidate) => candidate !== sleeper);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", sleeper.onAbort, { once: true });
      this.#sleepers.push(sleeper);
    });
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    const ready = this.#sleepers.filter((sleeper) => sleeper.at <= this.#now);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.at > this.#now);
    for (const sleeper of ready) {
      if (sleeper.onAbort !== undefined) {
        sleeper.signal?.removeEventListener("abort", sleeper.onAbort);
      }
      sleeper.resolve();
    }
  }
}

describe("TokenBucketRateLimiter", () => {
  it("queues fairly per key until a token is refilled", async () => {
    const clock = new ManualClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillIntervalMs: 100,
      maxQueue: 2,
      clock
    });

    await limiter.acquire("profile:global");
    let released = false;
    const queued = limiter.acquire("profile:global").then(() => {
      released = true;
    });
    expect(limiter.pending("profile:global")).toBe(1);

    clock.advance(99);
    await Promise.resolve();
    expect(released).toBe(false);
    clock.advance(1);
    await queued;
    expect(released).toBe(true);
  });

  it("uses independent buckets for different profile/region keys", async () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillIntervalMs: 100,
      maxQueue: 0,
      clock: new ManualClock()
    });

    await limiter.acquire("profile-a:global");
    await expect(limiter.acquire("profile-a:cn")).resolves.toBeUndefined();
    await expect(limiter.acquire("profile-a:global")).rejects.toBeInstanceOf(
      RateLimitQueueFullError
    );
  });

  it("enforces the queue bound and removes an aborted waiter", async () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillIntervalMs: 100,
      maxQueue: 1,
      clock: new ManualClock()
    });
    await limiter.acquire("key");
    const controller = new AbortController();
    const queued = limiter.acquire("key", controller.signal);
    await expect(limiter.acquire("key")).rejects.toBeInstanceOf(RateLimitQueueFullError);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(limiter.pending()).toBe(0);
  });

  it("rejects queued and future work after close", async () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillIntervalMs: 100,
      maxQueue: 1,
      clock: new ManualClock()
    });
    await limiter.acquire("key");
    const queued = limiter.acquire("key");
    limiter.close();
    await expect(queued).rejects.toBeInstanceOf(RateLimiterClosedError);
    await expect(limiter.acquire("key")).rejects.toBeInstanceOf(RateLimiterClosedError);
  });
});
