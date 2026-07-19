import { describe, expect, it } from "vitest";

import { LeetCodeToolError } from "../../src/leetcode/errors.js";
import type { Clock } from "../../src/runtime/abstractions.js";
import {
  canonicalCursorQueryFingerprint,
  createHmacCursorCodec,
  MAX_OPAQUE_CURSOR_LENGTH
} from "../../src/runtime/cursor-codec.js";

class FakeClock implements Clock {
  #now = Date.parse("2026-07-15T00:00:00.000Z");

  now(): Date {
    return new Date(this.#now);
  }

  async sleep(): Promise<void> {}

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

const key = new Uint8Array(32).fill(7);

function expectStale(operation: () => unknown): void {
  try {
    operation();
    throw new Error("Expected cursor decoding to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(LeetCodeToolError);
    expect(error).toMatchObject({ code: "STALE_CURSOR" });
  }
}

describe("HmacCursorCodec", () => {
  it("creates deterministic fingerprints independent of object key order", () => {
    const first = canonicalCursorQueryFingerprint({
      query: "graph",
      filters: { difficulty: "hard", tags: ["graph", "dfs"] }
    });
    const second = canonicalCursorQueryFingerprint({
      filters: { tags: ["graph", "dfs"], difficulty: "hard" },
      query: "graph"
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      canonicalCursorQueryFingerprint({ query: "graph", tags: ["dfs", "graph"] })
    ).not.toBe(
      canonicalCursorQueryFingerprint({ query: "graph", tags: ["graph", "dfs"] })
    );
    expect(() => canonicalCursorQueryFingerprint({ value: undefined })).toThrow(
      TypeError
    );
  });

  it("round-trips signed search and authenticated history cursors", () => {
    const clock = new FakeClock();
    const codec = createHmacCursorCodec({ key, clock, defaultTtlMs: 60_000 });
    const searchFingerprint = canonicalCursorQueryFingerprint({
      query: "two sum",
      difficulty: "easy",
      limit: 20
    });
    const searchCursor = codec.encode({
      tool: "search",
      region: "global",
      queryFingerprint: searchFingerprint,
      offset: 20
    });

    expect(searchCursor.length).toBeLessThanOrEqual(MAX_OPAQUE_CURSOR_LENGTH);
    expect(
      codec.decode(searchCursor, {
        tool: "search",
        region: "global",
        queryFingerprint: searchFingerprint
      })
    ).toMatchObject({
      version: 1,
      tool: "search",
      region: "global",
      offset: 20,
      expiresAt: "2026-07-15T00:01:00.000Z"
    });

    const historyFingerprint = canonicalCursorQueryFingerprint({
      titleSlug: "two-sum",
      limit: 20
    });
    const historyCursor = codec.encode({
      tool: "history",
      region: "cn",
      queryFingerprint: historyFingerprint,
      profileId: "profile-a",
      offset: 40,
      remoteCursor: "remote-page-key"
    });
    expect(
      codec.decode(historyCursor, {
        tool: "history",
        region: "cn",
        queryFingerprint: historyFingerprint,
        profileId: "profile-a"
      })
    ).toMatchObject({
      profileId: "profile-a",
      offset: 40,
      remoteCursor: "remote-page-key"
    });
  });

  it("rejects tampering and tokens signed by another key", () => {
    const clock = new FakeClock();
    const fingerprint = canonicalCursorQueryFingerprint({ query: "graph" });
    const codec = createHmacCursorCodec({ key, clock });
    const cursor = codec.encode({
      tool: "search",
      region: "global",
      queryFingerprint: fingerprint,
      offset: 20
    });
    const last = cursor.at(-1)!;
    const tampered = `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;

    expectStale(() =>
      codec.decode(tampered, {
        tool: "search",
        region: "global",
        queryFingerprint: fingerprint
      })
    );
    const otherCodec = createHmacCursorCodec({
      key: new Uint8Array(32).fill(8),
      clock
    });
    expectStale(() =>
      otherCodec.decode(cursor, {
        tool: "search",
        region: "global",
        queryFingerprint: fingerprint
      })
    );
  });

  it("rejects expired and cross-context cursor reuse", () => {
    const clock = new FakeClock();
    const codec = createHmacCursorCodec({ key, clock, defaultTtlMs: 1_000 });
    const fingerprint = canonicalCursorQueryFingerprint({ titleSlug: "two-sum" });
    const cursor = codec.encode({
      tool: "history",
      region: "cn",
      queryFingerprint: fingerprint,
      profileId: "profile-a",
      offset: 20,
      remoteCursor: "next"
    });

    const mismatches = [
      {
        tool: "search" as const,
        region: "cn" as const,
        queryFingerprint: fingerprint,
        profileId: "profile-a"
      },
      {
        tool: "history" as const,
        region: "global" as const,
        queryFingerprint: fingerprint,
        profileId: "profile-a"
      },
      {
        tool: "history" as const,
        region: "cn" as const,
        queryFingerprint: canonicalCursorQueryFingerprint({ titleSlug: "three-sum" }),
        profileId: "profile-a"
      },
      {
        tool: "history" as const,
        region: "cn" as const,
        queryFingerprint: fingerprint,
        profileId: "profile-b"
      },
      {
        tool: "history" as const,
        region: "cn" as const,
        queryFingerprint: fingerprint
      }
    ];
    for (const expected of mismatches) {
      expectStale(() => codec.decode(cursor, expected));
    }

    clock.advance(1_000);
    expectStale(() =>
      codec.decode(cursor, {
        tool: "history",
        region: "cn",
        queryFingerprint: fingerprint,
        profileId: "profile-a"
      })
    );
  });

  it("enforces key strength and the 1000-character encoded limit", () => {
    expect(() => createHmacCursorCodec({ key: "too-short" })).toThrow(RangeError);
    expect(() =>
      createHmacCursorCodec({ key, maxEncodedLength: MAX_OPAQUE_CURSOR_LENGTH + 1 })
    ).toThrow(RangeError);

    const codec = createHmacCursorCodec({ key });
    const fingerprint = canonicalCursorQueryFingerprint({ titleSlug: "two-sum" });
    expect(() =>
      codec.encode({
        tool: "history",
        region: "cn",
        queryFingerprint: fingerprint,
        profileId: "profile-a",
        offset: 20,
        remoteCursor: "x".repeat(900)
      })
    ).toThrow(/Encoded cursor exceeds/u);
    expectStale(() =>
      codec.decode("x".repeat(MAX_OPAQUE_CURSOR_LENGTH + 1), {
        tool: "history",
        region: "cn",
        queryFingerprint: fingerprint,
        profileId: "profile-a"
      })
    );
  });
});
