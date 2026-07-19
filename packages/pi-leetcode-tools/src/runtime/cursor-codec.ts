import { createHmac, timingSafeEqual } from "node:crypto";

import { LeetCodeToolError } from "../leetcode/errors.js";
import type { Region } from "../types.js";
import { MAX_PROFILE_ID_LENGTH, PROFILE_ID_PATTERN } from "./credentials.js";
import type { Clock } from "./abstractions.js";
import { systemClock } from "./abstractions.js";
import { sha256Digest } from "./hash.js";

export const CURSOR_CODEC_VERSION = 1 as const;
export const MAX_OPAQUE_CURSOR_LENGTH = 1_000;
export const DEFAULT_CURSOR_TTL_MS = 15 * 60_000;

const CURSOR_PREFIX = "lc1";
const MINIMUM_HMAC_KEY_BYTES = 32;
const QUERY_FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export type CursorTool = "search" | "history";

export interface CursorEncodeInput {
  tool: CursorTool;
  region: Region;
  queryFingerprint: string;
  profileId?: string;
  offset: number;
  remoteCursor?: string;
  expiresAt?: Date | string | number;
}

export interface CursorDecodeContext {
  tool: CursorTool;
  region: Region;
  queryFingerprint: string;
  profileId?: string;
}

export interface DecodedCursor {
  version: typeof CURSOR_CODEC_VERSION;
  tool: CursorTool;
  region: Region;
  queryFingerprint: string;
  profileId?: string;
  offset: number;
  remoteCursor?: string;
  expiresAt: string;
}

export interface CursorCodec {
  encode(input: CursorEncodeInput): string;
  decode(cursor: string, expected: CursorDecodeContext): DecodedCursor;
}

export interface HmacCursorCodecOptions {
  key: string | Uint8Array;
  clock?: Clock;
  defaultTtlMs?: number;
  maxEncodedLength?: number;
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Cursor fingerprint values must contain only finite numbers");
      }
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("Cursor fingerprint values must not contain cycles");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
        }
        if (
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null
        ) {
          throw new TypeError("Cursor fingerprint values must contain only plain objects");
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new TypeError("Cursor fingerprint values must not contain symbol keys");
        }
        return `{${Object.keys(value)
          .sort()
          .map((key) => {
            const item = (value as Record<string, unknown>)[key];
            if (item === undefined) {
              throw new TypeError("Cursor fingerprint values must not contain undefined");
            }
            return `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`;
          })
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError("Cursor fingerprint values must be JSON-compatible");
  }
}

export function canonicalCursorQueryFingerprint(value: unknown): string {
  return sha256Digest(canonicalJson(value));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function normalizeKey(key: string | Uint8Array): Uint8Array {
  const bytes =
    typeof key === "string"
      ? new TextEncoder().encode(key)
      : new Uint8Array(key);
  if (bytes.byteLength < MINIMUM_HMAC_KEY_BYTES) {
    throw new RangeError(
      `Cursor HMAC keys must contain at least ${MINIMUM_HMAC_KEY_BYTES} bytes`
    );
  }
  return bytes;
}

function validTool(value: unknown): value is CursorTool {
  return value === "search" || value === "history";
}

function validRegion(value: unknown): value is Region {
  return value === "global" || value === "cn";
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && QUERY_FINGERPRINT.test(value);
}

function validProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_ID_LENGTH &&
    PROFILE_ID_PATTERN.test(value)
  );
}

function validRemoteCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_CURSOR_LENGTH &&
    !/[\r\n]/u.test(value)
  );
}

function normalizeExpiresAt(
  value: Date | string | number | undefined,
  clock: Clock,
  defaultTtlMs: number
): string {
  const now = clock.now().getTime();
  if (!Number.isFinite(now)) {
    throw new RangeError("Cursor clock returned an invalid date");
  }
  const expiresAt =
    value === undefined
      ? new Date(now + defaultTtlMs)
      : value instanceof Date
        ? new Date(value)
        : new Date(value);
  const expiresAtMs = expiresAt.getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    throw new RangeError("Cursor expiresAt must be a valid future date");
  }
  return expiresAt.toISOString();
}

function assertEncodeInput(input: CursorEncodeInput): void {
  if (!validTool(input.tool)) {
    throw new TypeError("Cursor tool must be search or history");
  }
  if (!validRegion(input.region)) {
    throw new TypeError("Cursor region must be global or cn");
  }
  if (!validFingerprint(input.queryFingerprint)) {
    throw new TypeError("Cursor queryFingerprint must be a SHA-256 digest");
  }
  if (input.profileId !== undefined && !validProfileId(input.profileId)) {
    throw new TypeError("Cursor profileId is invalid");
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new RangeError("Cursor offset must be a non-negative safe integer");
  }
  if (input.remoteCursor !== undefined && !validRemoteCursor(input.remoteCursor)) {
    throw new TypeError("Cursor remoteCursor is invalid");
  }
}

function parsePayload(value: unknown): DecodedCursor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const payload = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "version",
    "tool",
    "region",
    "queryFingerprint",
    "profileId",
    "offset",
    "remoteCursor",
    "expiresAt"
  ]);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
    return undefined;
  }
  if (
    payload.version !== CURSOR_CODEC_VERSION ||
    !validTool(payload.tool) ||
    !validRegion(payload.region) ||
    !validFingerprint(payload.queryFingerprint) ||
    !Number.isSafeInteger(payload.offset) ||
    (payload.offset as number) < 0 ||
    typeof payload.expiresAt !== "string"
  ) {
    return undefined;
  }
  if (payload.profileId !== undefined && !validProfileId(payload.profileId)) {
    return undefined;
  }
  if (payload.remoteCursor !== undefined && !validRemoteCursor(payload.remoteCursor)) {
    return undefined;
  }
  const expiresAt = new Date(payload.expiresAt);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== payload.expiresAt
  ) {
    return undefined;
  }
  return {
    version: CURSOR_CODEC_VERSION,
    tool: payload.tool,
    region: payload.region,
    queryFingerprint: payload.queryFingerprint,
    ...(payload.profileId === undefined ? {} : { profileId: payload.profileId }),
    offset: payload.offset as number,
    ...(payload.remoteCursor === undefined
      ? {}
      : { remoteCursor: payload.remoteCursor }),
    expiresAt: payload.expiresAt
  };
}

function staleCursor(): never {
  throw new LeetCodeToolError(
    "STALE_CURSOR",
    "The pagination cursor is stale or invalid"
  );
}

export class HmacCursorCodec implements CursorCodec {
  readonly #key: Uint8Array;
  readonly #clock: Clock;
  readonly #defaultTtlMs: number;
  readonly #maxEncodedLength: number;

  constructor(options: HmacCursorCodecOptions) {
    this.#key = normalizeKey(options.key);
    this.#clock = options.clock ?? systemClock;
    this.#defaultTtlMs = positiveInteger(
      options.defaultTtlMs ?? DEFAULT_CURSOR_TTL_MS,
      "defaultTtlMs"
    );
    this.#maxEncodedLength = positiveInteger(
      options.maxEncodedLength ?? MAX_OPAQUE_CURSOR_LENGTH,
      "maxEncodedLength"
    );
    if (this.#maxEncodedLength > MAX_OPAQUE_CURSOR_LENGTH) {
      throw new RangeError(
        `maxEncodedLength must not exceed ${MAX_OPAQUE_CURSOR_LENGTH}`
      );
    }
  }

  encode(input: CursorEncodeInput): string {
    assertEncodeInput(input);
    const payload: DecodedCursor = {
      version: CURSOR_CODEC_VERSION,
      tool: input.tool,
      region: input.region,
      queryFingerprint: input.queryFingerprint,
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      offset: input.offset,
      ...(input.remoteCursor === undefined
        ? {}
        : { remoteCursor: input.remoteCursor }),
      expiresAt: normalizeExpiresAt(
        input.expiresAt,
        this.#clock,
        this.#defaultTtlMs
      )
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url"
    );
    const signedValue = `${CURSOR_PREFIX}.${encodedPayload}`;
    const signature = createHmac("sha256", this.#key)
      .update(signedValue, "utf8")
      .digest("base64url");
    const cursor = `${signedValue}.${signature}`;
    if (cursor.length > this.#maxEncodedLength) {
      throw new RangeError(
        `Encoded cursor exceeds the ${this.#maxEncodedLength} character limit`
      );
    }
    return cursor;
  }

  decode(cursor: string, expected: CursorDecodeContext): DecodedCursor {
    try {
      if (
        typeof cursor !== "string" ||
        cursor.length === 0 ||
        cursor.length > this.#maxEncodedLength
      ) {
        return staleCursor();
      }
      const parts = cursor.split(".");
      if (
        parts.length !== 3 ||
        parts[0] !== CURSOR_PREFIX ||
        !BASE64URL.test(parts[1]!) ||
        !BASE64URL.test(parts[2]!)
      ) {
        return staleCursor();
      }
      const signedValue = `${parts[0]}.${parts[1]}`;
      const expectedSignature = createHmac("sha256", this.#key)
        .update(signedValue, "utf8")
        .digest();
      const actualSignature = Buffer.from(parts[2]!, "base64url");
      if (
        actualSignature.byteLength !== expectedSignature.byteLength ||
        actualSignature.toString("base64url") !== parts[2] ||
        !timingSafeEqual(actualSignature, expectedSignature)
      ) {
        return staleCursor();
      }
      const payloadBytes = Buffer.from(parts[1]!, "base64url");
      if (payloadBytes.toString("base64url") !== parts[1]) {
        return staleCursor();
      }
      const payload = parsePayload(JSON.parse(payloadBytes.toString("utf8")));
      if (payload === undefined) {
        return staleCursor();
      }
      if (
        !validTool(expected.tool) ||
        !validRegion(expected.region) ||
        !validFingerprint(expected.queryFingerprint) ||
        (expected.profileId !== undefined && !validProfileId(expected.profileId)) ||
        payload.tool !== expected.tool ||
        payload.region !== expected.region ||
        payload.queryFingerprint !== expected.queryFingerprint ||
        payload.profileId !== expected.profileId ||
        Date.parse(payload.expiresAt) <= this.#clock.now().getTime()
      ) {
        return staleCursor();
      }
      return Object.freeze({ ...payload });
    } catch (error) {
      if (error instanceof LeetCodeToolError && error.code === "STALE_CURSOR") {
        throw error;
      }
      return staleCursor();
    }
  }
}

export function createHmacCursorCodec(
  options: HmacCursorCodecOptions
): CursorCodec {
  return new HmacCursorCodec(options);
}
