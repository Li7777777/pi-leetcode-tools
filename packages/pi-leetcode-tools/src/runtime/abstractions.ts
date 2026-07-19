import { randomUUID } from "node:crypto";

export interface Clock {
  now(): Date;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}

export interface IdGenerator {
  generate(prefix?: string): string;
}

export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  return new DOMException("The operation was aborted", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw createAbortError(signal.reason);
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return Promise.reject(new RangeError("delayMs must be a non-negative finite number"));
    }

    try {
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }

    if (delayMs === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);

      const onAbort = (): void => {
        clearTimeout(timer);
        cleanup();
        reject(createAbortError(signal?.reason));
      };

      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export class RandomIdGenerator implements IdGenerator {
  generate(prefix?: string): string {
    const id = randomUUID();
    return prefix === undefined || prefix.length === 0 ? id : `${prefix}_${id}`;
  }
}

export const systemClock: Clock = new SystemClock();
export const randomIdGenerator: IdGenerator = new RandomIdGenerator();
