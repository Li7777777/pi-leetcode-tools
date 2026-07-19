import type { Clock } from "./abstractions.js";
import { systemClock } from "./abstractions.js";
import { Redactor } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SafeLogMetadata {
  tool?: string;
  region?: string;
  status?: string;
  durationMs?: number;
  requestId?: string;
  operationId?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface SafeLogRecord extends SafeLogMetadata {
  timestamp: string;
  level: LogLevel;
  event: string;
}

export type SafeLogSink = (record: Readonly<SafeLogRecord>) => void;

export interface SafeLoggerOptions {
  sink?: SafeLogSink;
  redactor?: Redactor;
  clock?: Clock;
  minimumLevel?: LogLevel;
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const SAFE_EVENT_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,79}$/u;

export class SafeLogger {
  readonly #sink: SafeLogSink;
  readonly #redactor: Redactor;
  readonly #clock: Clock;
  readonly #minimumPriority: number;

  constructor(options: SafeLoggerOptions = {}) {
    this.#sink = options.sink ?? (() => undefined);
    this.#redactor = options.redactor ?? new Redactor();
    this.#clock = options.clock ?? systemClock;
    this.#minimumPriority = LEVEL_PRIORITY[options.minimumLevel ?? "info"];
  }

  debug(event: string, metadata?: SafeLogMetadata): void {
    this.log("debug", event, metadata);
  }

  info(event: string, metadata?: SafeLogMetadata): void {
    this.log("info", event, metadata);
  }

  warn(event: string, metadata?: SafeLogMetadata): void {
    this.log("warn", event, metadata);
  }

  error(event: string, metadata?: SafeLogMetadata): void {
    this.log("error", event, metadata);
  }

  log(level: LogLevel, event: string, metadata: SafeLogMetadata = {}): void {
    if (LEVEL_PRIORITY[level] < this.#minimumPriority) {
      return;
    }

    const record: SafeLogRecord = {
      timestamp: this.#clock.now().toISOString(),
      level,
      event: SAFE_EVENT_PATTERN.test(event) ? event : "unsafe_event_name"
    };
    this.#copyString(record, "tool", metadata.tool);
    this.#copyString(record, "region", metadata.region);
    this.#copyString(record, "status", metadata.status);
    this.#copyString(record, "requestId", metadata.requestId);
    this.#copyString(record, "operationId", metadata.operationId);
    this.#copyString(record, "errorCode", metadata.errorCode);
    if (typeof metadata.durationMs === "number" && Number.isFinite(metadata.durationMs)) {
      record.durationMs = Math.max(0, metadata.durationMs);
    }
    if (typeof metadata.retryable === "boolean") {
      record.retryable = metadata.retryable;
    }

    this.#sink(Object.freeze(record));
  }

  #copyString(
    target: SafeLogRecord,
    key: "tool" | "region" | "status" | "requestId" | "operationId" | "errorCode",
    value: string | undefined
  ): void {
    if (typeof value === "string") {
      target[key] = this.#redactor.redactText(value).slice(0, 256);
    }
  }
}
