import { describe, expect, it, vi } from "vitest";

import { LeetCodeToolError } from "../../src/leetcode/errors.js";
import type { Clock } from "../../src/runtime/abstractions.js";
import { SafeLogger, type SafeLogRecord } from "../../src/runtime/logger.js";
import type { RateLimiter } from "../../src/runtime/rate-limiter.js";
import type {
  TransportAttemptContext,
  TransportTimeoutScheduler
} from "../../src/runtime/transport-policy.js";
import { DefaultTransportPolicy } from "../../src/runtime/transport-policy.js";

interface Sleeper {
  readonly at: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
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
    if (delayMs === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const sleeper: Sleeper = {
        at: this.#now + delayMs,
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.#sleepers = this.#sleepers.filter(
            (candidate) => candidate !== sleeper
          );
          reject(signal?.reason);
        }
      };
      signal?.addEventListener("abort", sleeper.onAbort, { once: true });
      this.#sleepers.push(sleeper);
    });
  }

  advance(delayMs: number): void {
    this.#now += delayMs;
    const ready = this.#sleepers.filter((sleeper) => sleeper.at <= this.#now);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.at > this.#now);
    for (const sleeper of ready) {
      sleeper.signal?.removeEventListener("abort", sleeper.onAbort);
      sleeper.resolve();
    }
  }
}

class RecordingRateLimiter implements RateLimiter {
  readonly keys: string[] = [];

  acquire(key: string, signal?: AbortSignal): Promise<void> {
    this.keys.push(key);
    return signal?.aborted === true
      ? Promise.reject(signal.reason)
      : Promise.resolve();
  }

  close(): void {}
}

class BlockingRateLimiter implements RateLimiter {
  acquire(_key: string, signal?: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => {
      const onAbort = (): void => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {}
}

class ManualTimeoutScheduler implements TransportTimeoutScheduler {
  #now = 0;
  #nextId = 0;
  #timers = new Map<number, { at: number; callback: () => void }>();

  schedule(delayMs: number, callback: () => void): () => void {
    this.#nextId += 1;
    const id = this.#nextId;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    return () => this.#timers.delete(id);
  }

  advance(delayMs: number): void {
    this.#now += delayMs;
    const ready = [...this.#timers.entries()].filter(
      ([, timer]) => timer.at <= this.#now
    );
    for (const [id, timer] of ready) {
      this.#timers.delete(id);
      timer.callback();
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

function request(
  overrides: Partial<{
    region: "global" | "cn";
    retryMode: "safe-read" | "never";
    recoveryProbe: boolean;
    signal: AbortSignal;
    profileId: string;
    requestTimeoutMs: number;
  }> = {}
) {
  return {
    region: overrides.region ?? "global",
    operation: "dailyCodingChallengeV2",
    retryMode: overrides.retryMode ?? "safe-read",
    recoveryProbe: overrides.recoveryProbe ?? true,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.profileId === undefined
      ? {}
      : { profileId: overrides.profileId }),
    ...(overrides.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: overrides.requestTimeoutMs })
  } as const;
}

describe("DefaultTransportPolicy", () => {
  it("retries safe reads at most three times with injected full jitter", async () => {
    const clock = new ManualClock();
    const policy = new DefaultTransportPolicy({
      clock,
      rateLimiter: new RecordingRateLimiter(),
      random: () => 0.5,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1_000,
      circuitFailureThreshold: 10
    });
    const attempt = vi.fn(async (_context: TransportAttemptContext) => {
      if (attempt.mock.calls.length < 3) {
        throw new LeetCodeToolError(
          "REMOTE_UNAVAILABLE",
          "temporary transport failure",
          { retryable: true }
        );
      }
      return "ok";
    });

    const result = policy.execute(request(), attempt);
    await flushMicrotasks();
    expect(attempt).toHaveBeenCalledTimes(1);

    clock.advance(49);
    await flushMicrotasks();
    expect(attempt).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await flushMicrotasks();
    expect(attempt).toHaveBeenCalledTimes(2);

    clock.advance(100);
    await expect(result).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(attempt.mock.calls.map(([context]) => context.attempt)).toEqual([
      1, 2, 3
    ]);
  });

  it("honors a bounded Retry-After before retrying a safe read", async () => {
    const clock = new ManualClock();
    const policy = new DefaultTransportPolicy({
      clock,
      rateLimiter: new RecordingRateLimiter(),
      random: () => 0,
      readMaxAttempts: 2,
      baseRetryDelayMs: 10,
      maxRetryAfterMs: 2_000,
      circuitFailureThreshold: 10
    });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(
        new LeetCodeToolError("RATE_LIMITED", "rate limited", {
          retryable: true,
          retryAfterMs: 1_000
        })
      )
      .mockResolvedValueOnce("recovered");

    const result = policy.execute(request(), attempt);
    await flushMicrotasks();
    clock.advance(999);
    await flushMicrotasks();
    expect(attempt).toHaveBeenCalledTimes(1);
    clock.advance(1);

    await expect(result).resolves.toBe("recovered");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("never automatically replays an unsafe request", async () => {
    const policy = new DefaultTransportPolicy({
      rateLimiter: new RecordingRateLimiter(),
      readMaxAttempts: 3
    });
    const attempt = vi.fn(async () => {
      throw new LeetCodeToolError(
        "REMOTE_UNAVAILABLE",
        "dispatch result is uncertain",
        { retryable: true }
      );
    });

    await expect(
      policy.execute(request({ retryMode: "never", recoveryProbe: false }), attempt)
    ).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it.each([
    new LeetCodeToolError("RATE_LIMITED", "remote 429", { retryable: true }),
    new LeetCodeToolError("REMOTE_UNAVAILABLE", "remote 503", {
      retryable: true,
      details: { status: 503 }
    }),
    new LeetCodeToolError("REMOTE_SCHEMA_CHANGED", "schema drift")
  ])("opens a regional circuit for %s and recovers through one low-frequency read probe", async (failure) => {
    const clock = new ManualClock();
    const policy = new DefaultTransportPolicy({
      clock,
      rateLimiter: new RecordingRateLimiter(),
      readMaxAttempts: 1,
      circuitFailureThreshold: 1,
      circuitOpenMs: 1_000
    });
    const failedAttempt = vi.fn(async () => {
      throw failure;
    });

    await expect(policy.execute(request(), failedAttempt)).rejects.toBe(failure);
    const blockedAttempt = vi.fn(async () => "unexpected");
    await expect(
      policy.execute(request({ recoveryProbe: false }), blockedAttempt)
    ).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      retryable: true,
      details: { circuitOpen: true }
    });
    expect(blockedAttempt).not.toHaveBeenCalled();

    await expect(
      policy.execute(
        request({ region: "cn" }),
        async () => "independent-region"
      )
    ).resolves.toBe("independent-region");

    clock.advance(999);
    await expect(
      policy.execute(request(), blockedAttempt)
    ).rejects.toMatchObject({ details: { circuitOpen: true } });
    clock.advance(1);
    await expect(
      policy.execute(request(), async () => "probe-ok")
    ).resolves.toBe("probe-ok");
    await expect(
      policy.execute(request(), async () => "closed-again")
    ).resolves.toBe("closed-again");
  });

  it("aborts the rate-limit queue and maps caller cancellation", async () => {
    const policy = new DefaultTransportPolicy({
      rateLimiter: new BlockingRateLimiter()
    });
    const controller = new AbortController();
    const attempt = vi.fn(async () => "unexpected");
    const result = policy.execute(
      request({ retryMode: "never", signal: controller.signal }),
      attempt
    );
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    expect(attempt).not.toHaveBeenCalled();
  });

  it("propagates its timeout signal through the transport attempt", async () => {
    const clock = new ManualClock();
    const timeoutScheduler = new ManualTimeoutScheduler();
    const policy = new DefaultTransportPolicy({
      clock,
      rateLimiter: new RecordingRateLimiter(),
      timeoutScheduler
    });
    let transportSignal: AbortSignal | undefined;
    const result = policy.execute(
      request({ retryMode: "never", requestTimeoutMs: 100 }),
      async ({ signal }) => {
        transportSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        });
      }
    );
    await flushMicrotasks();
    timeoutScheduler.advance(100);

    await expect(result).rejects.toMatchObject({
      code: "REMOTE_UNAVAILABLE",
      retryable: true,
      details: { timedOut: true }
    });
    expect(transportSignal?.aborted).toBe(true);
  });

  it("uses profile-scoped limiter keys and emits only structured safe logs", async () => {
    const limiter = new RecordingRateLimiter();
    const records: SafeLogRecord[] = [];
    const logger = new SafeLogger({
      minimumLevel: "debug",
      sink: (record) => records.push({ ...record })
    });
    const policy = new DefaultTransportPolicy({
      rateLimiter: limiter,
      logger,
      readMaxAttempts: 1,
      circuitFailureThreshold: 10
    });

    await expect(
      policy.execute(
        request({ profileId: "secret-profile-id" }),
        async () => {
          throw new LeetCodeToolError(
            "REMOTE_UNAVAILABLE",
            "secret response body canary",
            { retryable: true, details: { status: 503 } }
          );
        }
      )
    ).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });

    expect(limiter.keys[0]).toMatch(/^[a-f0-9]{16}:global$/u);
    expect(limiter.keys[0]).not.toContain("secret-profile-id");
    expect(records.map((record) => record.event)).toEqual([
      "transport.request",
      "transport.failure"
    ]);
    expect(JSON.stringify(records)).not.toContain("secret response body canary");
  });
});
