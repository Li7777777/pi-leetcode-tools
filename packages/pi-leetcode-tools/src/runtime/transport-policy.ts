import type { Region } from "../types.js";
import { LeetCodeToolError } from "../leetcode/errors.js";
import type { Clock } from "./abstractions.js";
import { systemClock, throwIfAborted } from "./abstractions.js";
import { sha256Hex } from "./hash.js";
import { SafeLogger } from "./logger.js";
import type { RateLimiter } from "./rate-limiter.js";
import {
  RateLimiterClosedError,
  RateLimitQueueFullError,
  TokenBucketRateLimiter
} from "./rate-limiter.js";

export type TransportRetryMode = "safe-read" | "never";

export interface TransportRequestPolicy {
  readonly region: Region;
  readonly operation: string;
  readonly retryMode: TransportRetryMode;
  readonly signal?: AbortSignal;
  readonly profileId?: string;
  readonly requestTimeoutMs?: number;
  readonly recoveryProbe?: boolean;
  readonly uncertainOnAbort?: boolean;
}

export interface TransportAttemptContext {
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type TransportAttempt<T> = (
  context: TransportAttemptContext
) => Promise<T>;

export interface TransportPolicy {
  execute<T>(
    request: TransportRequestPolicy,
    attempt: TransportAttempt<T>
  ): Promise<T>;
  close(): void;
}

export interface DefaultTransportPolicyOptions {
  rateLimiter?: RateLimiter;
  clock?: Clock;
  logger?: SafeLogger;
  random?: () => number;
  requestTimeoutMs?: number;
  readMaxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRetryAfterMs?: number;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
  timeoutScheduler?: TransportTimeoutScheduler;
}

export interface TransportTimeoutScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

interface CircuitState {
  consecutiveFailures: number;
  open: boolean;
  nextProbeAt: number;
  probeInFlight: boolean;
}

interface CircuitAdmission {
  readonly state: CircuitState;
  readonly probe: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_READ_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_OPEN_MS = 30_000;

const systemTimeoutScheduler: TransportTimeoutScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  }
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof LeetCodeToolError ? error.code : undefined;
}

function errorStatus(error: LeetCodeToolError): number | undefined {
  const status = error.details?.status;
  return typeof status === "number" ? status : undefined;
}

function isRemoteCircuitFailure(error: unknown): boolean {
  if (!(error instanceof LeetCodeToolError)) {
    return false;
  }
  if (error.code === "RATE_LIMITED") {
    return error.details?.localRateLimit !== true;
  }
  if (error.code === "REMOTE_SCHEMA_CHANGED") {
    return true;
  }
  const status = errorStatus(error);
  return (
    error.code === "REMOTE_UNAVAILABLE" &&
    status !== undefined &&
    status >= 500 &&
    status <= 599
  );
}

function isAutomaticallyRetryable(error: unknown): error is LeetCodeToolError {
  return (
    error instanceof LeetCodeToolError &&
    error.retryable &&
    (error.code === "RATE_LIMITED" || error.code === "REMOTE_UNAVAILABLE")
  );
}

function cancelledError(): LeetCodeToolError {
  return new LeetCodeToolError("CANCELLED", "LeetCode request was cancelled");
}

function timeoutError(transportUncertain: boolean): LeetCodeToolError {
  return new LeetCodeToolError(
    "REMOTE_UNAVAILABLE",
    "LeetCode request timed out",
    {
      retryable: true,
      details: {
        timedOut: true,
        ...(transportUncertain ? { transportUncertain: true } : {})
      }
    }
  );
}

export class DefaultTransportPolicy implements TransportPolicy {
  readonly #rateLimiter: RateLimiter;
  readonly #ownsRateLimiter: boolean;
  readonly #clock: Clock;
  readonly #logger: SafeLogger;
  readonly #random: () => number;
  readonly #requestTimeoutMs: number;
  readonly #readMaxAttempts: number;
  readonly #baseRetryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #maxRetryAfterMs: number;
  readonly #circuitFailureThreshold: number;
  readonly #circuitOpenMs: number;
  readonly #timeoutScheduler: TransportTimeoutScheduler;
  readonly #circuits = new Map<Region, CircuitState>();
  readonly #lifecycle = new AbortController();
  #closed = false;

  constructor(options: DefaultTransportPolicyOptions = {}) {
    this.#rateLimiter =
      options.rateLimiter ??
      new TokenBucketRateLimiter({
        capacity: 4,
        refillTokens: 1,
        refillIntervalMs: 500,
        maxQueue: 20,
        ...(options.clock === undefined ? {} : { clock: options.clock })
      });
    this.#ownsRateLimiter = options.rateLimiter === undefined;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? new SafeLogger({ clock: this.#clock });
    this.#random = options.random ?? Math.random;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs"
    );
    this.#readMaxAttempts = positiveInteger(
      options.readMaxAttempts ?? DEFAULT_READ_MAX_ATTEMPTS,
      "readMaxAttempts"
    );
    this.#baseRetryDelayMs = nonNegativeInteger(
      options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
      "baseRetryDelayMs"
    );
    this.#maxRetryDelayMs = nonNegativeInteger(
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      "maxRetryDelayMs"
    );
    this.#maxRetryAfterMs = nonNegativeInteger(
      options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
      "maxRetryAfterMs"
    );
    this.#circuitFailureThreshold = positiveInteger(
      options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
      "circuitFailureThreshold"
    );
    this.#circuitOpenMs = positiveInteger(
      options.circuitOpenMs ?? DEFAULT_CIRCUIT_OPEN_MS,
      "circuitOpenMs"
    );
    this.#timeoutScheduler =
      options.timeoutScheduler ?? systemTimeoutScheduler;
  }

  async execute<T>(
    request: TransportRequestPolicy,
    attempt: TransportAttempt<T>
  ): Promise<T> {
    if (this.#closed) {
      throw new LeetCodeToolError("CANCELLED", "LeetCode runtime is closed");
    }
    if (request.operation.trim().length === 0) {
      throw new Error("transport operation must not be empty");
    }
    try {
      throwIfAborted(request.signal);
    } catch {
      throw cancelledError();
    }

    const admission = this.#admitCircuit(request);
    const configuredMaxAttempts =
      request.retryMode === "safe-read" ? this.#readMaxAttempts : 1;
    const maxAttempts = admission.probe ? 1 : configuredMaxAttempts;

    if (admission.probe) {
      this.#logger.info("transport.circuit_probe", {
        tool: request.operation,
        region: request.region
      });
    }

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const startedAt = this.#clock.now().getTime();
      this.#logger.debug("transport.request", {
        tool: request.operation,
        region: request.region,
        status: `attempt_${attemptNumber}`
      });
      try {
        const result = await this.#runAttempt(request, attempt, {
          attempt: attemptNumber,
          maxAttempts
        });
        this.#recordSuccess(admission.state);
        this.#logger.info("transport.success", {
          tool: request.operation,
          region: request.region,
          status: `attempt_${attemptNumber}`,
          durationMs: this.#durationSince(startedAt)
        });
        return result;
      } catch (error) {
        const opened = this.#recordFailure(admission.state, error);
        const failureCode = errorCode(error);
        this.#logger.warn("transport.failure", {
          tool: request.operation,
          region: request.region,
          status: `attempt_${attemptNumber}`,
          durationMs: this.#durationSince(startedAt),
          ...(failureCode === undefined ? {} : { errorCode: failureCode }),
          ...(error instanceof LeetCodeToolError
            ? { retryable: error.retryable }
            : {})
        });

        if (opened) {
          this.#logger.warn("transport.circuit_open", {
            tool: request.operation,
            region: request.region,
            ...(failureCode === undefined ? {} : { errorCode: failureCode })
          });
        }

        const delayMs = this.#retryDelay(error, attemptNumber, maxAttempts);
        if (opened || delayMs === undefined) {
          throw error;
        }

        const retryErrorCode = errorCode(error);
        this.#logger.info("transport.retry", {
          tool: request.operation,
          region: request.region,
          status: `attempt_${attemptNumber + 1}`,
          ...(retryErrorCode === undefined ? {} : { errorCode: retryErrorCode }),
          retryable: true
        });
        await this.#sleepForRetry(delayMs, request.signal);
      }
    }

    throw new Error("transport retry loop completed without a result");
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#lifecycle.abort(new DOMException("Runtime closed", "AbortError"));
    if (this.#ownsRateLimiter) {
      this.#rateLimiter.close();
    }
  }

  async #runAttempt<T>(
    request: TransportRequestPolicy,
    attempt: TransportAttempt<T>,
    retryContext: Omit<TransportAttemptContext, "signal">
  ): Promise<T> {
    const timeoutMs = positiveInteger(
      request.requestTimeoutMs ?? this.#requestTimeoutMs,
      "requestTimeoutMs"
    );
    const controller = new AbortController();
    let timedOut = false;
    let cancelledByCaller = false;
    let closedDuringAttempt = false;
    let attemptInvoked = false;

    const abortFromCaller = (): void => {
      cancelledByCaller = true;
      controller.abort(request.signal?.reason);
    };
    const abortFromLifecycle = (): void => {
      closedDuringAttempt = true;
      controller.abort(this.#lifecycle.signal.reason);
    };
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    this.#lifecycle.signal.addEventListener("abort", abortFromLifecycle, {
      once: true
    });
    if (request.signal?.aborted === true) {
      abortFromCaller();
    } else if (this.#lifecycle.signal.aborted) {
      abortFromLifecycle();
    }
    const cancelTimeout = this.#timeoutScheduler.schedule(timeoutMs, () => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    });

    try {
      await this.#rateLimiter.acquire(
        this.#rateLimitKey(request.region, request.profileId),
        controller.signal
      );
      attemptInvoked = true;
      return await attempt({ signal: controller.signal, ...retryContext });
    } catch (error) {
      if (cancelledByCaller || request.signal?.aborted === true) {
        throw cancelledError();
      }
      if (closedDuringAttempt || this.#closed) {
        throw new LeetCodeToolError("CANCELLED", "LeetCode runtime is closed");
      }
      if (timedOut) {
        throw timeoutError(
          attemptInvoked && request.uncertainOnAbort === true
        );
      }
      if (error instanceof RateLimitQueueFullError) {
        throw new LeetCodeToolError(
          "RATE_LIMITED",
          "The local LeetCode rate limit queue is full",
          {
            retryable: true,
            details: { localRateLimit: true, queueFull: true }
          }
        );
      }
      if (error instanceof RateLimiterClosedError) {
        throw new LeetCodeToolError("CANCELLED", "LeetCode runtime is closed");
      }
      throw error;
    } finally {
      cancelTimeout();
      request.signal?.removeEventListener("abort", abortFromCaller);
      this.#lifecycle.signal.removeEventListener("abort", abortFromLifecycle);
    }
  }

  #admitCircuit(request: TransportRequestPolicy): CircuitAdmission {
    let state = this.#circuits.get(request.region);
    if (state === undefined) {
      state = {
        consecutiveFailures: 0,
        open: false,
        nextProbeAt: 0,
        probeInFlight: false
      };
      this.#circuits.set(request.region, state);
    }
    if (!state.open) {
      return { state, probe: false };
    }

    const now = this.#clock.now().getTime();
    const retryAfterMs = Math.max(1, state.nextProbeAt - now);
    if (
      request.recoveryProbe !== true ||
      state.probeInFlight ||
      now < state.nextProbeAt
    ) {
      throw this.#circuitOpenError(retryAfterMs);
    }

    state.probeInFlight = true;
    return { state, probe: true };
  }

  #recordSuccess(state: CircuitState): void {
    state.consecutiveFailures = 0;
    state.open = false;
    state.nextProbeAt = 0;
    state.probeInFlight = false;
  }

  #recordFailure(state: CircuitState, error: unknown): boolean {
    const wasProbe = state.probeInFlight;
    state.probeInFlight = false;
    if (!isRemoteCircuitFailure(error)) {
      if (
        wasProbe &&
        error instanceof LeetCodeToolError &&
        error.code !== "REMOTE_UNAVAILABLE" &&
        error.code !== "CANCELLED"
      ) {
        this.#recordSuccess(state);
      } else if (!state.open) {
        state.consecutiveFailures = 0;
      } else if (wasProbe && errorCode(error) !== "CANCELLED") {
        state.nextProbeAt = this.#clock.now().getTime() + this.#circuitOpenMs;
      }
      return false;
    }

    state.consecutiveFailures += 1;
    if (
      !state.open &&
      state.consecutiveFailures < this.#circuitFailureThreshold
    ) {
      return false;
    }

    const retryAfterMs =
      error instanceof LeetCodeToolError ? error.retryAfterMs ?? 0 : 0;
    state.open = true;
    state.consecutiveFailures = this.#circuitFailureThreshold;
    state.nextProbeAt =
      this.#clock.now().getTime() + Math.max(this.#circuitOpenMs, retryAfterMs);
    return true;
  }

  #retryDelay(
    error: unknown,
    attemptNumber: number,
    maxAttempts: number
  ): number | undefined {
    if (
      attemptNumber >= maxAttempts ||
      !isAutomaticallyRetryable(error)
    ) {
      return undefined;
    }

    const retryAfterMs = error.retryAfterMs;
    if (retryAfterMs !== undefined && retryAfterMs > this.#maxRetryAfterMs) {
      return undefined;
    }
    const exponentialCap = Math.min(
      this.#maxRetryDelayMs,
      this.#baseRetryDelayMs * 2 ** (attemptNumber - 1)
    );
    const randomValue = this.#random();
    if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
      throw new RangeError("random must return a finite number from 0 (inclusive) to 1 (exclusive)");
    }
    const jitterMs = Math.floor(randomValue * (exponentialCap + 1));
    return Math.max(retryAfterMs ?? 0, jitterMs);
  }

  async #sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
    try {
      throwIfAborted(signal);
      await this.#clock.sleep(
        delayMs,
        signal === undefined
          ? this.#lifecycle.signal
          : AbortSignal.any([signal, this.#lifecycle.signal])
      );
    } catch {
      if (this.#closed) {
        throw new LeetCodeToolError("CANCELLED", "LeetCode runtime is closed");
      }
      throw cancelledError();
    }
  }

  #rateLimitKey(region: Region, profileId: string | undefined): string {
    return profileId === undefined
      ? `public:${region}`
      : `${sha256Hex(profileId).slice(0, 16)}:${region}`;
  }

  #durationSince(startedAt: number): number {
    return Math.max(0, this.#clock.now().getTime() - startedAt);
  }

  #circuitOpenError(retryAfterMs: number): LeetCodeToolError {
    return new LeetCodeToolError(
      "REMOTE_UNAVAILABLE",
      "LeetCode requests are temporarily paused while the remote service recovers",
      {
        retryable: true,
        retryAfterMs,
        details: { circuitOpen: true }
      }
    );
  }
}

export function createDefaultTransportPolicy(
  options: DefaultTransportPolicyOptions = {}
): TransportPolicy {
  return new DefaultTransportPolicy(options);
}
