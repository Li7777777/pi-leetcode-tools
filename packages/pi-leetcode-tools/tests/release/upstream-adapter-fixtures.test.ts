import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Clock, IdGenerator } from "../../src/runtime/abstractions.js";
import type { CredentialProvider } from "../../src/runtime/credentials.js";
import type { RateLimiter } from "../../src/runtime/rate-limiter.js";
import type { LeetCodeFetch } from "../../src/leetcode/read-adapter.js";
import type { LeetCodeWriteFetch } from "../../src/leetcode/write-adapter.js";
import { createLeetCodeReadAdapter } from "../../src/leetcode/read-adapter.js";
import { createLeetCodeWriteAdapter } from "../../src/leetcode/write-adapter.js";
import { createToolGateway } from "../../src/tool-calls/gateway.js";
import { FakeLeetCodeClient } from "../tool-calls/fake-client.js";

interface CapturedRequest {
  input: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fakeFetch(...responses: Response[]): {
  fetch: LeetCodeFetch;
  requests: CapturedRequest[];
} {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({ input: String(input), init });
      const response = queue.shift();
      if (response === undefined) throw new Error("Unexpected fixture request");
      return response;
    }
  };
}

function body(request: CapturedRequest): Record<string, any> {
  return JSON.parse(String(request.init?.body)) as Record<string, any>;
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    questionId: "1",
    questionFrontendId: "1",
    title: "Two Sum",
    translatedTitle: "两数之和",
    titleSlug: "two-sum",
    difficulty: "Easy",
    isPaidOnly: false,
    acRate: 54.25,
    status: null,
    topicTags: [{ name: "Array", slug: "array", translatedName: "数组" }],
    ...overrides
  };
}

function problemResource(): Record<string, unknown> {
  return {
    ...summary(),
    boundTopicId: null,
    content: "<p>Problem</p>",
    translatedContent: null,
    likes: 10,
    dislikes: 1,
    isLiked: null,
    similarQuestions: "[]",
    exampleTestcases: "[2,7,11,15]\n9",
    contributors: [],
    companyTagStats: null,
    codeSnippets: [{ lang: "C++", langSlug: "cpp", code: "class Solution {};" }],
    stats: "{}",
    hints: [],
    solution: null,
    sampleTestCase: "[2,7,11,15]\n9",
    metaData: "{}",
    judgerAvailable: true,
    judgeType: "large",
    mysqlSchemas: [],
    enableRunCode: true,
    enableTestMode: true,
    enableDebugger: false,
    envInfo: "{}",
    libraryUrl: null,
    adminUrl: null,
    challengeQuestion: null,
    note: null
  };
}

const credential = {
  profileId: "fixture-profile",
  region: "global" as const,
  session: "fixture-session",
  csrfToken: "fixture-csrf"
};

function readAdapter(...responses: Response[]) {
  const transport = fakeFetch(...responses);
  return {
    transport,
    adapter: createLeetCodeReadAdapter("global", {
      fetch: transport.fetch,
      credentialLookup: () => credential,
      now: () => new Date("2026-07-15T00:00:00.000Z")
    })
  };
}

function assertGraphqlRequest(request: CapturedRequest, operationName: string): void {
  expect(request.input).toBe("https://leetcode.com/graphql/");
  expect(body(request).operationName).toBe(operationName);
}

class FixtureClock implements Clock {
  #epoch = Date.parse("2026-07-15T00:00:00.000Z");
  now(): Date { return new Date(this.#epoch); }
  async sleep(delayMs: number): Promise<void> { this.#epoch += delayMs; }
}

class FixtureIds implements IdGenerator {
  #next = 0;
  generate(prefix = "id"): string { this.#next += 1; return `${prefix}-${this.#next}`; }
}

class FixtureLimiter implements RateLimiter {
  async acquire(): Promise<void> {}
  close(): void {}
}

function credentialProvider(): CredentialProvider {
  return { async getCredentials() { return credential; } };
}

const temporaryDirectories: string[] = [];
const closeables: Array<{ close(): void | Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
    )
  );
});

async function writeFixture(kind: "run" | "submit") {
  const directory = await mkdtemp(join(tmpdir(), "pi-leetcode-upstream-adapter-"));
  temporaryDirectories.push(directory);
  const remoteId = kind === "run" ? "run-fixture-1" : 303;
  const responses = [
    jsonResponse({ data: { question: { questionId: "1" } } }),
    jsonResponse(kind === "run" ? { interpret_id: remoteId } : { submission_id: remoteId }),
    jsonResponse({ state: "SUCCESS", status_msg: "Accepted", status_runtime: "3 ms" })
  ];
  const transport = fakeFetch(...responses);
  const adapter = createLeetCodeWriteAdapter("global", {
    fetch: transport.fetch as LeetCodeWriteFetch,
    credentialProvider: credentialProvider(),
    storageDirectory: directory,
    rateLimiter: new FixtureLimiter(),
    clock: new FixtureClock(),
    idGenerator: new FixtureIds()
  });
  closeables.push(adapter);
  const common = {
    region: "global" as const,
    titleSlug: "two-sum",
    language: "cpp" as const,
    code: "class Solution {};",
    timeoutMs: 5_000,
    pollIntervalMs: 250
  };
  const result = kind === "run"
    ? await adapter.runCode({ ...common, testcase: "[2,7,11,15]\n9" })
    : await adapter.submitCode(common);
  return { result, requests: transport.requests };
}

describe("TOOLS-ENG-UPSTREAM-ADAPTER-FIXTURES native adapter invocations", () => {
  it("tool:get_daily_challenge", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { activeDailyCodingChallengeQuestion: { date: "2026-07-15", link: "/problems/two-sum/", question: problemResource() } } }));
    expect((await adapter.getDaily()).problem.titleSlug).toBe("two-sum");
    assertGraphqlRequest(transport.requests[0]!, "dailyCodingChallengeV2");
  });

  it("tool:get_problem", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { question: problemResource() } }));
    expect((await adapter.getProblem({ region: "global", titleSlug: "two-sum", language: "cpp" })).selectedCodeSnippet?.language).toBe("cpp");
    assertGraphqlRequest(transport.requests[0]!, "questionData");
  });

  it("resource:problem-detail", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { question: problemResource() } }));
    expect((await adapter.getProblem({ region: "global", titleSlug: "two-sum", includeResourcePayload: true })).resourcePayload).toMatchObject({ titleSlug: "two-sum" });
    assertGraphqlRequest(transport.requests[0]!, "questionData");
  });

  it("tool:search_problems", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { problemsetQuestionList: { total: 1, hasMore: false, questions: [summary()] } } }));
    expect((await adapter.searchProblems({ region: "global", query: " two sum ", limit: 1 })).items).toHaveLength(1);
    assertGraphqlRequest(transport.requests[0]!, "problemsetQuestionList");
    expect(body(transport.requests[0]!).variables.filters.searchKeywords).toBe("two sum");
  });

  it("tool:get_user_profile", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { matchedUser: { username: "fixture_user", profile: { ranking: 42 }, submitStats: { acSubmissionNum: [], totalSubmissionNum: [] } } } }));
    expect((await adapter.getUserProfile({ region: "global", username: "fixture_user" })).ranking).toBe(42);
    assertGraphqlRequest(transport.requests[0]!, "userProfile");
  });

  it("tool:get_recent_submissions", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { recentSubmissionList: [{ title: "Two Sum", titleSlug: "two-sum", timestamp: "1720000000", statusDisplay: "Wrong Answer", lang: "cpp" }] } }));
    expect((await adapter.getUserSubmissions({ region: "global", username: "fixture_user", mode: "recent" })).items).toHaveLength(1);
    assertGraphqlRequest(transport.requests[0]!, "recentSubmissions");
  });

  it("tool:get_recent_ac_submissions", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { recentAcSubmissionList: [{ id: "789", title: "Two Sum", titleSlug: "two-sum", timestamp: "1720000000", statusDisplay: "Accepted", lang: "cpp" }] } }));
    expect((await adapter.getUserSubmissions({ region: "global", username: "fixture_user", mode: "accepted" })).mode).toBe("accepted");
    assertGraphqlRequest(transport.requests[0]!, "recentAcSubmissions");
  });

  it("tool:get_problem_submission_report", async () => {
    const submission = { id: 123, runtimeDisplay: "0 ms", memoryDisplay: "8 MB", code: "class Solution {};", timestamp: 1720000000, statusCode: 10, lang: { name: "cpp", verboseName: "C++" }, question: { questionId: "1", titleSlug: "two-sum" }, totalCorrect: 63, totalTestcases: 63 };
    const { adapter, transport } = readAdapter(jsonResponse({ data: { submissionDetails: submission } }));
    expect((await adapter.getSubmissionDetail({ region: "global", submissionId: "123", includeCode: false })).id).toBe("123");
    assertGraphqlRequest(transport.requests[0]!, "submissionDetails");
  });

  it("tool:get_problem_progress", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { userProgressQuestionList: { totalNum: 1, questions: [{ frontendId: "1", difficulty: "EASY", lastSubmittedAt: "1720000000", numSubmitted: 1, questionStatus: "SOLVED", title: "Two Sum", titleSlug: "two-sum" }] } } }));
    expect((await adapter.getProgress({ region: "global", limit: 1 })).items).toHaveLength(1);
    assertGraphqlRequest(transport.requests[0]!, "userProgressQuestionList");
  });

  it("tool:get_all_submissions", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { submissionList: { lastKey: null, hasNext: false, submissions: [] } } }));
    expect((await adapter.getHistory({ region: "global", titleSlug: "two-sum" })).items).toEqual([]);
    assertGraphqlRequest(transport.requests[0]!, "submissionList");
  });

  it("tool:get_user_contest_ranking", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { userContestRanking: { attendedContestsCount: 1, rating: 1500 }, userContestRankingHistory: [] } }));
    expect((await adapter.getUserContest({ region: "global", username: "fixture_user" })).ranking?.rating).toBe(1500);
    assertGraphqlRequest(transport.requests[0]!, "userContestRankingInfo");
  });

  it("tool:list_problem_solutions", async () => {
    const { adapter, transport } = readAdapter(jsonResponse({ data: { ugcArticleSolutionArticles: { totalNum: 1, pageInfo: { hasNextPage: false }, edges: [{ node: { title: "Hash map", topicId: "12345", slug: "hash-map", canSee: true, hasVideoArticle: false } }] } } }));
    expect((await adapter.searchSolutions({ region: "global", titleSlug: "two-sum" })).items).toHaveLength(1);
    assertGraphqlRequest(transport.requests[0]!, "ugcArticleSolutionArticles");
  });

  it("tool:get_problem_solution", async () => {
    const payload = { title: "Hash map", slug: "hash-map", content: "Use a map.", tags: [{ slug: "hash-table" }], topic: { id: "12345" } };
    const { adapter, transport } = readAdapter(jsonResponse({ data: { ugcArticleSolutionArticle: payload } }));
    expect((await adapter.getSolution({ region: "global", topicId: "12345" })).content).toBe("Use a map.");
    assertGraphqlRequest(transport.requests[0]!, "ugcArticleSolutionArticle");
  });

  it("resource:problem-solution", async () => {
    const payload = { title: "Hash map", slug: "hash-map", content: "Use a map.", tags: [], topic: { id: "12345" } };
    const { adapter, transport } = readAdapter(jsonResponse({ data: { ugcArticleSolutionArticle: payload } }));
    expect((await adapter.getSolution({ region: "global", topicId: "12345" })).topicId).toBe("12345");
    assertGraphqlRequest(transport.requests[0]!, "ugcArticleSolutionArticle");
  });

  it("tool:run_code", async () => {
    const { result, requests } = await writeFixture("run");
    expect(result).toMatchObject({ kind: "run", state: "completed", questionId: "1" });
    expect(requests.map((item) => item.input)).toEqual([
      "https://leetcode.com/graphql/",
      "https://leetcode.com/problems/two-sum/interpret_solution/",
      "https://leetcode.com/submissions/detail/run-fixture-1/check/"
    ]);
  }, 30_000);

  it("tool:submit_solution", async () => {
    const { result, requests } = await writeFixture("submit");
    expect(result).toMatchObject({ kind: "submit", state: "completed", remoteId: "303" });
    expect(requests[1]?.input).toBe("https://leetcode.com/problems/two-sum/submit/");
  }, 30_000);
});

function gatewayFixture() {
  const client = new FakeLeetCodeClient();
  const gateway = createToolGateway({
    client,
    interactiveUI: true,
    now: () => new Date("2026-07-15T00:00:00.000Z")
  });
  closeables.push(gateway);
  return { client, gateway };
}

const confirmed = { hasUI: true as const, async confirm() { return true; } };

describe("TOOLS-ENG-UPSTREAM-ADAPTER-FIXTURES Gateway capability invocations", () => {
  it("tool:get_user_status", async () => {
    const { client, gateway } = gatewayFixture();
    expect((await gateway.getUserStatus({ region: "global" }, { requestId: "fixture-status" })).ok).toBe(true);
    expect(client.calls.at(-1)?.method).toBe("getUserStatus");
  });

  it("tool:search_notes", async () => {
    const { client, gateway } = gatewayFixture();
    expect((await gateway.searchUserNotes({ region: "cn", keyword: "dp" }, { requestId: "fixture-search" })).ok).toBe(true);
    expect(client.calls.at(-1)?.method).toBe("searchUserNotes");
  });

  it("tool:get_note", async () => {
    const { client, gateway } = gatewayFixture();
    expect((await gateway.getUserNotes({ region: "cn", questionId: "1" }, { requestId: "fixture-get" })).ok).toBe(true);
    expect(client.calls.at(-1)?.method).toBe("getUserNotes");
  });

  it("tool:create_note", async () => {
    const { client, gateway } = gatewayFixture();
    expect((await gateway.createUserNote({ region: "cn", questionId: "1", content: "fixture" }, { requestId: "fixture-create", interaction: confirmed })).ok).toBe(true);
    expect(client.calls.at(-1)?.method).toBe("createUserNote");
  });

  it("tool:update_note", async () => {
    const { client, gateway } = gatewayFixture();
    expect((await gateway.updateUserNote({ region: "cn", noteId: "note-1", content: "fixture" }, { requestId: "fixture-update", interaction: confirmed })).ok).toBe(true);
    expect(client.calls.at(-1)?.method).toBe("updateUserNote");
  });
});
