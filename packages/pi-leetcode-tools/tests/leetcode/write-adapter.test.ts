import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Clock, IdGenerator } from "../../src/runtime/abstractions.js";
import type { CredentialProvider } from "../../src/runtime/credentials.js";
import type { RateLimiter } from "../../src/runtime/rate-limiter.js";
import type { Region } from "../../src/types.js";
import type { LeetCodeWriteFetch } from "../../src/leetcode/write-adapter.js";
import { createLeetCodeWriteAdapter } from "../../src/leetcode/write-adapter.js";

interface RequestRecord {
  url: string;
  init: RequestInit | undefined;
}

class AdvancingClock implements Clock {
  #now = Date.parse("2026-07-15T00:00:00.000Z");
  readonly sleeps: number[] = [];

  now(): Date {
    return new Date(this.#now);
  }

  async sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    this.sleeps.push(delayMs);
    this.#now += delayMs;
  }
}

class SequenceIds implements IdGenerator {
  #next = 0;

  generate(prefix = "id"): string {
    this.#next += 1;
    return `${prefix}-${this.#next}`;
  }
}

class UnlimitedRateLimiter implements RateLimiter {
  readonly acquire = vi.fn(async (_key: string, signal?: AbortSignal) => {
    if (signal?.aborted === true) {
      throw new DOMException("Aborted", "AbortError");
    }
  });

  close(): void {}
}

function credentials(region: Region = "global"): CredentialProvider {
  return {
    async getCredentials(requestedRegion) {
      return {
        profileId: "profile-a",
        region: requestedRegion,
        session: `${region}-session-token`,
        csrfToken: `${region}-csrf-token`
      };
    }
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fakeFetch(
  ...responses: Array<Response | Error | ((request: RequestRecord) => Response)>
): { fetch: LeetCodeWriteFetch; requests: RequestRecord[] } {
  const requests: RequestRecord[] = [];
  const fetch = vi.fn<LeetCodeWriteFetch>(async (input, init) => {
    const request = { url: String(input), init };
    requests.push(request);
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("Unexpected request");
    }
    if (next instanceof Error) {
      throw next;
    }
    return typeof next === "function" ? next(request) : next;
  });
  return { fetch, requests };
}

function requestBody(request: RequestRecord): Record<string, unknown> {
  return JSON.parse(String(request.init?.body)) as Record<string, unknown>;
}

const directories: string[] = [];
const closeables: Array<{ close(): void | Promise<void> }> = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-leetcode-write-adapter-"));
  directories.push(directory);
  return directory;
}

async function persistedOperationText(directory: string): Promise<string> {
  const entries = await readdir(directory, { recursive: true });
  const operationFile = entries.find((entry) => entry.endsWith("operations.json"));
  if (operationFile === undefined) {
    throw new Error("Operation store was not written");
  }
  return readFile(join(directory, operationFile), "utf8");
}

function trackedWriteAdapter(
  ...args: Parameters<typeof createLeetCodeWriteAdapter>
): ReturnType<typeof createLeetCodeWriteAdapter> {
  const adapter = createLeetCodeWriteAdapter(...args);
  closeables.push(adapter);
  return adapter;
}

afterEach(async () => {
  const closeResults = await Promise.allSettled(
    closeables.splice(0).reverse().map((resource) => resource.close())
  );
  const directoryResults = await Promise.allSettled(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50
      })
    )
  );
  const failure = [...closeResults, ...directoryResults].find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure !== undefined) {
    throw failure.reason;
  }
});

describe("LeetCode write adapter", { timeout: 30_000 }, () => {
  it("runs code through fixed HTTPS endpoints and persists only a minimal result", async () => {
    const directory = await temporaryDirectory();
    const code = "console.log('雪')\r\n";
    const startResponse = {
      interpret_id: "run-101",
      start_canary: "ephemeral-start"
    };
    const terminalCheck = {
      state: "SUCCESS",
      status_msg: "Accepted",
      status_runtime: "52 ms",
      status_memory: "17.2 MB",
      stdout: "visible stdout",
      expected_output: "expected output",
      last_testcase: "[2,7,11,15]\n9",
      response_canary: "ephemeral-check"
    };
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse(startResponse),
      jsonResponse({ state: "PENDING", status_msg: "Judging" }),
      jsonResponse(terminalCheck)
    );
    const limiter = new UnlimitedRateLimiter();
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: limiter,
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "javascript",
      code,
      testcase: "[2,7,11,15]\n9",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://leetcode.com/graphql/",
      "https://leetcode.com/problems/two-sum/interpret_solution/",
      "https://leetcode.com/submissions/detail/run-101/check/",
      "https://leetcode.com/submissions/detail/run-101/check/"
    ]);
    expect(transport.requests.every((request) => request.url.startsWith("https://leetcode.com/"))).toBe(true);
    expect(requestBody(transport.requests[1]!)).toEqual({
      lang: "javascript",
      question_id: "1",
      typed_code: code,
      data_input: "[2,7,11,15]\n9"
    });
    const headers = new Headers(transport.requests[1]!.init?.headers);
    expect(headers.get("cookie")).toBe(
      "LEETCODE_SESSION=global-session-token; csrftoken=global-csrf-token"
    );
    expect(headers.get("x-csrftoken")).toBe("global-csrf-token");
    expect(result).toMatchObject({
      kind: "run",
      state: "completed",
      remoteId: "run-101",
      questionId: "1",
      start: startResponse,
      checkUrl: "https://leetcode.com/submissions/detail/run-101/check/",
      check: terminalCheck,
      codeHash: createHash("sha256").update(Buffer.from(code, "utf8")).digest("hex"),
      result: {
        state: "SUCCESS",
        verdict: "Accepted",
        runtime: "52 ms",
        memory: "17.2 MB",
        stdout: "visible stdout",
        expectedOutput: "expected output",
        input: "[2,7,11,15]\n9"
      }
    });
    expect(limiter.acquire).toHaveBeenCalledTimes(4);

    const persisted = await persistedOperationText(directory);
    expect(persisted).not.toContain(code);
    expect(persisted).not.toContain("visible stdout");
    expect(persisted).not.toContain("[2,7,11,15]\\n9");
    expect(persisted).not.toContain("ephemeral-start");
    expect(persisted).not.toContain("ephemeral-check");
    await adapter.close();
  });

  it("normalizes Global judge output arrays without treating the terminal response as schema drift", async () => {
    const directory = await temporaryDirectory();
    const terminalCheck = {
      state: "SUCCESS",
      status_code: 10,
      status_msg: "Accepted",
      status_runtime: "40 ms",
      status_memory: "17.1 MB",
      code_answer: ["0", "1"],
      code_output: [],
      std_output_list: ["first", "second"],
      expected_code_answer: ["0", "1"],
      expected_code_output: [],
      expected_std_output_list: ["expected first", "expected second"],
      run_success: true,
      total_correct: 1,
      total_testcases: 1
    };
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-array-output-1" }),
      jsonResponse({ state: "PENDING" }),
      jsonResponse(terminalCheck)
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "class Solution: pass",
      testcase: "[2,7,11,15]\n9",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "completed",
      check: terminalCheck,
      result: {
        state: "SUCCESS",
        verdict: "Accepted",
        stdout: "first\nsecond",
        expectedOutput: "expected first\nexpected second"
      }
    });
    await adapter.close();
  });

  it("fails closed when a judge output array contains non-string values", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-invalid-array-output-1" }),
      jsonResponse({
        state: "SUCCESS",
        status_msg: "Accepted",
        std_output: "preferred output",
        code_output: ["safe", 1]
      })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "class Solution: pass",
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "REMOTE_SCHEMA_CHANGED"
    });
    expect(result).not.toHaveProperty("check");
    await adapter.close();
  });

  it("uses Global answer arrays when no stdout-oriented output field is present", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-answer-array-1" }),
      jsonResponse({
        state: "SUCCESS",
        status_msg: "Accepted",
        code_answer: ["0", "1"],
        expected_code_answer: ["0", "1"]
      })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "class Solution: pass",
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "completed",
      result: {
        stdout: "0\n1",
        expectedOutput: "0\n1"
      }
    });
    await adapter.close();
  });

  it("rejects judge output arrays whose combined normalized text exceeds the limit", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-oversized-array-output-1" }),
      jsonResponse({
        state: "SUCCESS",
        status_msg: "Accepted",
        code_output: ["a".repeat(100_000), "b".repeat(100_000)]
      })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "class Solution: pass",
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "REMOTE_SCHEMA_CHANGED"
    });
    await adapter.close();
  });

  it("rejects source-code fields nested inside judge response arrays", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-nested-source-1" }),
      jsonResponse({
        state: "SUCCESS",
        status_msg: "Accepted",
        diagnostics: [{ typed_code: "source-canary" }]
      })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "class Solution: pass",
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "REMOTE_SCHEMA_CHANGED"
    });
    expect(await persistedOperationText(directory)).not.toContain("source-canary");
    await adapter.close();
  });

  it("fails closed when an upstream operation response unexpectedly echoes source code", async () => {
    const directory = await temporaryDirectory();
    const code = "print('source-canary')";
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-source-1" }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted", code })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code,
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "failed",
      remoteId: "run-source-1",
      errorCode: "REMOTE_SCHEMA_CHANGED"
    });
    expect(result).not.toHaveProperty("check");
    expect(await persistedOperationText(directory)).not.toContain("source-canary");
    await adapter.close();
  });

  it("rejects prototype-pollution keys in transient upstream envelopes", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-pollution-1" }),
      new Response(
        '{"state":"SUCCESS","status_msg":"Accepted","__proto__":{"polluted":true}}',
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "print(1)",
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "REMOTE_SCHEMA_CHANGED"
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await adapter.close();
  });

  it("accepts dotted CN run ids without allowing path traversal", async () => {
    const directory = await temporaryDirectory();
    const remoteId = "runcode_1664329851.69111_evj0kaqgk6";
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: remoteId }),
      jsonResponse({ state: "STARTED" }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted" })
    );
    const adapter = trackedWriteAdapter("cn", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "cn",
      titleSlug: "two-sum",
      language: "cpp",
      code: "class Solution {};",
      testcase: "[2,7,11,15]\n9",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({ state: "completed", remoteId });
    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://leetcode.cn/graphql/",
      "https://leetcode.cn/problems/two-sum/interpret_solution/",
      `https://leetcode.cn/submissions/detail/${remoteId}/check/`,
      `https://leetcode.cn/submissions/detail/${remoteId}/check/`
    ]);
    await adapter.close();
  });

  it.each([".", "..", "../check", "x/y", "x%2Fy", "x..y"])(
    "rejects unsafe remote id %s before polling",
    async (remoteId) => {
      const directory = await temporaryDirectory();
      const transport = fakeFetch(
        jsonResponse({ data: { question: { questionId: "1" } } }),
        jsonResponse({ interpret_id: remoteId })
      );
      const adapter = trackedWriteAdapter("cn", {
        fetch: transport.fetch,
        credentialProvider: credentials(),
        storageDirectory: directory,
        rateLimiter: new UnlimitedRateLimiter(),
        clock: new AdvancingClock(),
        idGenerator: new SequenceIds()
      });

      const result = await adapter.runCode({
        region: "cn",
        titleSlug: "two-sum",
        language: "cpp",
        code: "class Solution {};",
        testcase: "[2,7,11,15]\n9",
        timeoutMs: 5_000,
        pollIntervalMs: 250
      });
      expect(result).toMatchObject({
        state: "unknown"
      });
      expect(result).not.toHaveProperty("remoteId");
      expect(transport.requests).toHaveLength(2);
      await adapter.close();
    }
  );

  it("uses the exact remote default testcase and maps canonical languages", async () => {
    const directory = await temporaryDirectory();
    const defaultTestcase = "  [1,2]\n3\n";
    const transport = fakeFetch(
      jsonResponse({
        data: { question: { questionId: "1", sampleTestCase: defaultTestcase } }
      }),
      jsonResponse({ interpret_id: "run-go-1" }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted" })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "golang",
      code: "package main",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({ state: "completed", language: "go" });
    expect(requestBody(transport.requests[1]!)).toEqual({
      lang: "golang",
      question_id: "1",
      typed_code: "package main",
      data_input: defaultTestcase
    });
    await adapter.close();
  });

  it("uses the pinned 1500 ms polling default when the caller omits it", async () => {
    const directory = await temporaryDirectory();
    const clock = new AdvancingClock();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-defaults-1" }),
      jsonResponse({ state: "PENDING" }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted" })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock,
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "print(1)",
      testcase: "1"
    });

    expect(result.state).toBe("completed");
    expect(clock.sleeps).toEqual([1_500]);
    await adapter.close();
  });

  it("honors Retry-After and continues polling after a judge 429", async () => {
    const directory = await temporaryDirectory();
    const clock = new AdvancingClock();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-rate-limit-1" }),
      new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "1"
        }
      }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted" })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock,
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "print(1)",
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result.state).toBe("completed");
    expect(clock.sleeps).toEqual([1_000]);
    expect(transport.requests).toHaveLength(4);
    await adapter.close();
  });

  it.each([
    {
      name: "wrong answer",
      check: {
        state: "SUCCESS",
        status_msg: "Wrong Answer",
        std_output: "actual\n",
        expected_output: "expected\n",
        last_testcase: "[1,2]\n4"
      },
      expected: {
        verdict: "Wrong Answer",
        stdout: "actual\n",
        expectedOutput: "expected\n",
        input: "[1,2]\n4"
      }
    },
    {
      name: "compile error",
      check: {
        state: "SUCCESS",
        status_msg: "Compile Error",
        full_compile_error: "compiler diagnostic\n"
      },
      expected: {
        verdict: "Compile Error",
        compileError: "compiler diagnostic\n"
      }
    },
    {
      name: "runtime error",
      check: {
        state: "SUCCESS",
        status_msg: "Runtime Error",
        runtime_error: "AddressSanitizer diagnostic\n"
      },
      expected: {
        verdict: "Runtime Error",
        runtimeError: "AddressSanitizer diagnostic\n"
      }
    }
  ])("preserves the complete $name terminal check while normalizing diagnostics", async ({ check, expected }) => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-terminal-1" }),
      jsonResponse(check)
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "cpp",
      code: "int main() {}",
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "completed",
      check,
      result: { state: "SUCCESS", ...expected }
    });
    await adapter.close();
  });

  it("uses the CN submit endpoint and returns the complete submit envelope", async () => {
    const directory = await temporaryDirectory();
    const start = { submission_id: 303, submission_canary: "submit-start" };
    const check = {
      state: "SUCCESS",
      status_msg: "Accepted",
      status_runtime: "3 ms"
    };
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse(start),
      jsonResponse(check)
    );
    const adapter = trackedWriteAdapter("cn", {
      fetch: transport.fetch,
      credentialProvider: credentials("cn"),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.submitCode({
      region: "cn",
      titleSlug: "two-sum",
      language: "cpp",
      code: "class Solution {};",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(transport.requests.map((request) => request.url)).toEqual([
      "https://leetcode.cn/graphql/",
      "https://leetcode.cn/problems/two-sum/submit/",
      "https://leetcode.cn/submissions/detail/303/check/"
    ]);
    expect(requestBody(transport.requests[1]!)).toEqual({
      lang: "cpp",
      question_id: "1",
      typed_code: "class Solution {};"
    });
    expect(result).toMatchObject({
      kind: "submit",
      state: "completed",
      remoteId: "303",
      questionId: "1",
      start,
      checkUrl: "https://leetcode.cn/submissions/detail/303/check/",
      check
    });
    expect(await persistedOperationText(directory)).not.toContain("submit-start");
    await adapter.close();
  });

  it.each([
    { status: 401, errorCode: "AUTH_EXPIRED" },
    { status: 403, errorCode: "AUTH_EXPIRED" },
    { status: 404, errorCode: "NOT_FOUND" },
    { status: 429, errorCode: "RATE_LIMITED" }
  ] as const)("records a known submit HTTP $status rejection as $errorCode", async ({ status, errorCode }) => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ message: "known rejection" }, status)
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.submitCode({
      region: "global",
      titleSlug: "two-sum",
      language: "cpp",
      code: "class Solution {};",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({ state: "failed", errorCode });
    expect(result).not.toHaveProperty("remoteId");
    expect(transport.requests).toHaveLength(2);
    await adapter.close();
  });

  it("fails validation before a run dispatch when no testcase default exists", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    await expect(
      adapter.runCode({
        region: "global",
        titleSlug: "two-sum",
        language: "python3",
        code: "print(1)"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(transport.requests).toHaveLength(1);
    expect(
      transport.requests.some((request) => request.url.includes("interpret_solution"))
    ).toBe(false);
    await adapter.close();
  });

  it("rejects oversized judge control fields instead of silently slicing them", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-oversized-1" }),
      jsonResponse({ state: "SUCCESS", status_msg: "x".repeat(257) })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode({
      region: "global",
      titleSlug: "two-sum",
      language: "python3",
      code: "print(1)",
      testcase: "1",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });

    expect(result).toMatchObject({
      state: "failed",
      remoteId: "run-oversized-1",
      errorCode: "REMOTE_SCHEMA_CHANGED"
    });
    await adapter.close();
  });

  it("returns the recorded result for an exact completed duplicate without redispatch", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ submission_id: 202 }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted" })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });
    const input = {
      region: "global" as const,
      titleSlug: "two-sum",
      language: "typescript",
      code: "function twoSum(): number[] { return []; }",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    };

    const first = await adapter.submitCode(input);
    const duplicate = await adapter.submitCode(input);

    expect(first.state).toBe("completed");
    expect(duplicate).toMatchObject({
      operationId: first.operationId,
      state: "completed",
      remoteId: "202",
      result: { state: "SUCCESS", verdict: "Accepted" }
    });
    expect(duplicate).not.toHaveProperty("start");
    expect(transport.requests).toHaveLength(3);
    expect(
      transport.requests.filter((request) => request.url.endsWith("/submit/"))
    ).toHaveLength(1);
    await adapter.close();
  });

  it("requires an explicit completed operation reference before submitting the same code again", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ submission_id: "submit-first" }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted" }),
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ submission_id: "submit-again" }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted" })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });
    const input = {
      region: "global" as const,
      titleSlug: "two-sum",
      language: "typescript",
      code: "export const answer = 42;",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    };

    const first = await adapter.submitCode(input);
    const repeated = await adapter.submitCode({
      ...input,
      resubmitCompletedOperationId: first.operationId
    });

    expect(repeated).toMatchObject({
      state: "completed",
      remoteId: "submit-again",
      repeatsOperationId: first.operationId
    });
    expect(repeated.operationId).not.toBe(first.operationId);
    expect(transport.requests.filter((request) => request.url.endsWith("/submit/"))).toHaveLength(2);

    await expect(
      adapter.submitCode({
        ...input,
        retryUnknownOperationId: first.operationId,
        resubmitCompletedOperationId: first.operationId
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(transport.requests.filter((request) => request.url.endsWith("/submit/"))).toHaveLength(2);
    await adapter.close();
  });

  it("returns unknown after a remote id and recovers through operation status without redispatch", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ submission_id: "submit-303" }),
      new TypeError("socket reset"),
      jsonResponse({
        state: "SUCCESS",
        status_msg: "Wrong Answer",
        status_runtime: "41 ms"
      })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const unknown = await adapter.submitCode({
      region: "global",
      titleSlug: "two-sum",
      language: "typescript",
      code: "export {};",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    });
    expect(unknown).toMatchObject({
      state: "unknown",
      remoteId: "submit-303"
    });
    expect(unknown).not.toHaveProperty("errorCode");
    expect(unknown.operationId).toMatch(/^operation-/);

    const recovered = await adapter.getOperationStatus(unknown.operationId);
    expect(recovered).toMatchObject({
      operationId: unknown.operationId,
      state: "completed",
      remoteId: "submit-303",
      result: { state: "SUCCESS", verdict: "Wrong Answer", runtime: "41 ms" }
    });
    expect(
      transport.requests.filter((request) => request.url.endsWith("/submit/"))
    ).toHaveLength(1);
    expect(transport.requests).toHaveLength(4);
    await adapter.close();
  });

  it("requires both session and CSRF credentials before any network request", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch();
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: {
        async getCredentials() {
          return {
            profileId: "profile-a",
            region: "global",
            session: "session-token",
            csrfToken: ""
          };
        }
      },
      storageDirectory: directory
    });

    await expect(
      adapter.runCode({
        region: "global",
        titleSlug: "two-sum",
        language: "python3",
        code: "print(1)"
      })
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(transport.requests).toHaveLength(0);
    await adapter.close();
  });

  it("records cancellation before dispatch and performs zero network writes", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch();
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));

    const cancelled = await adapter.runCode(
      {
        region: "global",
        titleSlug: "two-sum",
        language: "python3",
        code: "print(1)"
      },
      controller.signal
    );
    expect(cancelled).toMatchObject({
      kind: "run",
      state: "cancelled",
      errorCode: "CANCELLED"
    });
    expect(cancelled).not.toHaveProperty("remoteId");
    expect(transport.requests).toHaveLength(0);

    await expect(adapter.getOperationStatus(cancelled.operationId)).resolves.toEqual(cancelled);
    await adapter.close();
  });

  it("persists a submit dispatch intent and requires an explicit reference before retry", async () => {
    const directory = await temporaryDirectory();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ message: "uncertain server failure" }, 500),
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ submission_id: "submit-retry-1" }),
      jsonResponse({ state: "SUCCESS", status_msg: "Accepted" })
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });
    const input = {
      region: "global" as const,
      titleSlug: "two-sum",
      language: "typescript",
      code: "export const answer = 1;",
      timeoutMs: 5_000,
      pollIntervalMs: 250
    };

    const unknown = await adapter.submitCode(input);
    expect(unknown).toMatchObject({ state: "unknown" });
    expect(unknown).not.toHaveProperty("remoteId");
    expect(transport.requests.filter((request) => request.url.endsWith("/submit/"))).toHaveLength(1);

    await expect(adapter.submitCode(input)).rejects.toMatchObject({
      code: "STALE_OPERATION",
      operationId: unknown.operationId
    });
    expect(transport.requests).toHaveLength(2);

    const retried = await adapter.submitCode({
      ...input,
      retryUnknownOperationId: unknown.operationId
    });
    expect(retried).toMatchObject({
      state: "completed",
      remoteId: "submit-retry-1",
      supersedesOperationId: unknown.operationId
    });
    expect(transport.requests.filter((request) => request.url.endsWith("/submit/"))).toHaveLength(2);
    await adapter.close();
  });

  it("records unknown rather than cancelled when polling is aborted after dispatch", async () => {
    const directory = await temporaryDirectory();
    const controller = new AbortController();
    const transport = fakeFetch(
      jsonResponse({ data: { question: { questionId: "1" } } }),
      jsonResponse({ interpret_id: "run-abort-1" }),
      () => {
        controller.abort(new DOMException("Cancelled", "AbortError"));
        throw new TypeError("aborted transport");
      }
    );
    const adapter = trackedWriteAdapter("global", {
      fetch: transport.fetch,
      credentialProvider: credentials(),
      storageDirectory: directory,
      rateLimiter: new UnlimitedRateLimiter(),
      clock: new AdvancingClock(),
      idGenerator: new SequenceIds()
    });

    const result = await adapter.runCode(
      {
        region: "global",
        titleSlug: "two-sum",
        language: "python3",
        code: "print(1)",
        testcase: "1"
      },
      controller.signal
    );
    expect(result).toMatchObject({
      state: "unknown",
      remoteId: "run-abort-1"
    });
    expect(result).not.toHaveProperty("errorCode");
    await adapter.close();
  });
});
