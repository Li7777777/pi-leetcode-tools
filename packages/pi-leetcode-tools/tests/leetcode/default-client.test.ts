import { describe, expect, it, vi } from "vitest";

import { DefaultLeetCodeClient } from "../../src/leetcode/default-client.js";
import { LeetCodeToolError } from "../../src/leetcode/errors.js";
import {
  LEETCODE_CN_NOTES_ENDPOINT,
  LEETCODE_MANAGED_NOTE_SUMMARY,
  type LeetCodeNotesPort,
  type LeetCodeNotesPorts,
  type LeetCodeUserNotesPort
} from "../../src/leetcode/notes-port.js";
import type {
  LeetCodeReadAdapter,
  LeetCodeReadAdapters
} from "../../src/leetcode/read-adapter.js";
import type { CredentialProvider } from "../../src/runtime/credentials.js";
import { createHmacCursorCodec } from "../../src/runtime/cursor-codec.js";
import type {
  LeetCodeWriteAdapter,
  LeetCodeWriteAdapters
} from "../../src/leetcode/write-adapter.js";
import { CONTRACT_VERSION } from "../../src/tool-calls/contract.js";
import type { NotesCapability, OperationStatus, Region } from "../../src/types.js";

function readAdapter(region: Region): LeetCodeReadAdapter {
  return {
    region,
    getDaily: vi.fn(async () => ({
      date: "2026-07-15",
      link: "https://leetcode.com/problems/two-sum/",
      regionalPayload: {
        date: "2026-07-15",
        userStatus: null,
        question: {
          questionId: "1", frontendQuestionId: "1", title: "Two Sum", titleCn: "两数之和",
          titleSlug: "two-sum", difficulty: "Easy", paidOnly: false, acRate: 50,
          status: null, freqBar: null, isFavor: false, solutionNum: 0,
          hasVideoSolution: false, topicTags: [], extra: { topCompanyTags: [] }
        },
        lastSubmission: null
      },
      problem: {
        questionId: "1",
        frontendId: "1",
        title: "Two Sum",
        titleSlug: "two-sum",
        difficulty: "easy" as const,
        paidOnly: false,
        topicTags: []
      }
    })),
    searchProblems: vi.fn(async () => ({
      items: [],
      page: { offset: 0, limit: 20, totalKind: "exact" as const, total: 0, hasMore: false }
    })),
    getProblem: vi.fn(async () => {
      throw new LeetCodeToolError("NOT_FOUND", "Problem not found");
    }),
    searchSolutions: vi.fn(async (input) => ({
      titleSlug: input.titleSlug,
      items: [],
      page: { offset: 0, limit: 10, totalKind: "exact" as const, total: 0, hasMore: false }
    })),
    getSolution: vi.fn(async (input) => ({
      title: "Solution",
      slug: input.slug ?? "solution",
      ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
      content: "Answer",
      tags: []
    })),
    getUserProfile: vi.fn(async (input) => ({
      username: input.username,
      ranking: 42
    })),
    getUserContest: vi.fn(async (input) => ({
      username: input.username,
      ranking: { attendedContestsCount: 3, rating: 1_500 },
      history: [],
      page: { offset: 0, limit: 50, totalKind: "exact" as const, total: 0, hasMore: false }
    })),
    getProgress: vi.fn(async () => ({
      filters: { offset: 0, limit: 100 },
      items: [],
      page: { offset: 0, limit: 100, totalKind: "exact" as const, total: 0, hasMore: false }
    })),
    getHistory: vi.fn(async () => ({
      items: [],
      page: { offset: 0, limit: 20, totalKind: "exact" as const, total: 0, hasMore: false }
    })),
    getUserSubmissions: vi.fn(async (input) => ({
      username: input.username,
      mode: input.mode,
      items: [],
      page: { offset: 0, limit: 10, totalKind: "lower_bound" as const, total: 0, hasMore: false }
    })),
    getSubmissionDetail: vi.fn(async (input) => ({
      id: input.submissionId,
      titleSlug: "two-sum",
      language: "cpp" as const
    })),
    getUserStatus: vi.fn(async () => ({
      isSignedIn: true,
      username: "active_user",
      isAdmin: false
    }))
  };
}

function operation(region: Region, operationId: string): OperationStatus {
  return {
    operationId,
    kind: "run",
    state: "completed",
    region,
    titleSlug: "two-sum",
    language: "typescript",
    codeHash: "abc",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:01.000Z",
    remoteId: "123",
    result: { state: "SUCCESS", verdict: "Accepted" }
  };
}

function writeAdapter(region: Region): LeetCodeWriteAdapter {
  return {
    region,
    runCode: vi.fn(async () =>
      operation(region, "operation-" + region + "-run")
    ),
    submitCode: vi.fn(async () =>
      operation(region, "operation-" + region + "-submit")
    ),
    getOperationStatus: vi.fn(async (operationId) =>
      operation(region, operationId)
    ),
    close: vi.fn(async () => undefined)
  };
}

function notesPort(region: Region, supported: boolean): LeetCodeNotesPort {
  const capability = (runtimeAvailable: boolean): NotesCapability => ({
    supported,
    configured: supported,
    currentlyAvailable: supported && runtimeAvailable,
    ...(!supported
      ? { reason: "unsupported_region" }
      : runtimeAvailable
        ? {}
        : { reason: "runtime_closed" }),
    revisionMode: supported ? "best-effort-compare-and-set" : "unsupported",
    maxSize: supported ? 16_384 : 0
  });
  return {
    region,
    getCapability: capability,
    read: vi.fn(async (input) => ({
      target: input.target,
      content: "stored",
      byteLength: 6,
      revision: `sha256:${"1".repeat(64)}`,
      revisionMode: "best-effort-compare-and-set" as const
    })),
    write: vi.fn(async (input) => ({
      target: input.target,
      content: input.content,
      byteLength: new TextEncoder().encode(input.content).byteLength,
      revision: `sha256:${"2".repeat(64)}`,
      revisionMode: "best-effort-compare-and-set" as const
    }))
  };
}

function userNotesPort(): LeetCodeUserNotesPort {
  return {
    region: "cn",
    search: vi.fn(async (input) => ({
      filters: { orderBy: input.orderBy ?? "DESCENDING" },
      pagination: { limit: input.limit ?? 10, skip: input.skip ?? 0, totalCount: 0 },
      notes: []
    })),
    get: vi.fn(async (input) => ({
      questionId: input.questionId,
      count: 0,
      pagination: { limit: input.limit ?? 10, skip: input.skip ?? 0 },
      notes: []
    })),
    create: vi.fn(async (input) => ({
      success: true,
      note: { id: "created-1", content: input.content, targetId: input.questionId }
    })),
    update: vi.fn(async (input) => ({
      success: true,
      note: { id: input.noteId, content: input.content ?? "", targetId: "1" }
    }))
  };
}

function regionSet<T extends { region: Region }>(
  global: T,
  cn: T
): { global: T; cn: T; forRegion(region: Region): T } {
  return {
    global,
    cn,
    forRegion(region) {
      return region === "cn" ? cn : global;
    }
  };
}

describe("DefaultLeetCodeClient", () => {
  it("wraps read results in the stable tool envelope", async () => {
    const client = new DefaultLeetCodeClient({
      readAdapters: regionSet(
        readAdapter("global"),
        readAdapter("cn")
      ) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters
    });

    const result = await client.getDaily("global");
    expect(result.ok).toBe(true);
    expect(result.meta).toMatchObject({
      region: "global",
      packageVersion: "0.1.1",
      contractVersion: CONTRACT_VERSION
    });
  });

  it("normalizes adapter failures without leaking the original error", async () => {
    const client = new DefaultLeetCodeClient({
      readAdapters: regionSet(
        readAdapter("global"),
        readAdapter("cn")
      ) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters
    });

    const result = await client.getProblem({
      region: "global",
      titleSlug: "missing"
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Problem not found" }
    });
  });

  it("routes public profile, contest, and authenticated status reads by region", async () => {
    const global = readAdapter("global");
    const cn = readAdapter("cn");
    const client = new DefaultLeetCodeClient({
      readAdapters: regionSet(global, cn) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters
    });

    await expect(
      client.getUserProfile({ region: "cn", username: "public-cn" })
    ).resolves.toMatchObject({ ok: true, data: { username: "public-cn" } });
    await expect(
      client.getUserContest({ region: "global", username: "public_user", attendedOnly: false })
    ).resolves.toMatchObject({ ok: true, data: { username: "public_user" } });
    await expect(client.getUserStatus("cn")).resolves.toMatchObject({
      ok: true,
      data: { isSignedIn: true, username: "active_user" }
    });

    expect(cn.getUserProfile).toHaveBeenCalledWith(
      { region: "cn", username: "public-cn" },
      undefined
    );
    expect(global.getUserContest).toHaveBeenCalledWith(
      { region: "global", username: "public_user", attendedOnly: false },
      undefined
    );
    expect(cn.getUserStatus).toHaveBeenCalledWith(undefined);
  });

  it("keeps profile and contest public while session status follows regional auth readiness", () => {
    const credentialProvider: CredentialProvider = {
      isConfigured: (region, purpose) => region === "cn" && purpose === "session",
      getCredentials: async () => undefined
    };
    const client = new DefaultLeetCodeClient({
      credentialProvider,
      readAdapters: regionSet(readAdapter("global"), readAdapter("cn")) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters
    });

    const capabilities = client.getCapabilities(false);
    expect(capabilities.tools.find(({ name }) => name === "lc_profile")).toMatchObject({
      requiresAuth: false,
      configured: true,
      currentlyAvailable: true,
      consequence: "read"
    });
    expect(capabilities.tools.find(({ name }) => name === "lc_contest")).toMatchObject({
      requiresAuth: false,
      configured: true,
      currentlyAvailable: true,
      consequence: "read"
    });
    expect(capabilities.regionReadiness).toMatchObject({
      global: { sessionReads: false },
      cn: { sessionReads: true }
    });
  });

  it("advances contextRevision when credential bytes rotate without changing readiness", () => {
    let credentialRevision = 7;
    const credentialProvider: CredentialProvider = {
      getCredentials: async (region) => ({
        profileId: "profile-a",
        region,
        session: `session-${credentialRevision}`,
        csrfToken: `csrf-${credentialRevision}`
      }),
      getActiveProfileId: () => "profile-a",
      getRevision: () => credentialRevision,
      isConfigured: () => true
    };
    const client = new DefaultLeetCodeClient({
      credentialProvider,
      readAdapters: regionSet(readAdapter("global"), readAdapter("cn")) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters
    });

    const before = client.getCapabilities(false);
    credentialRevision += 1;
    const after = client.getCapabilities(false);

    expect(after.contextRevision).toBe(before.contextRevision + 1);
    expect(after.activeAccountProfileId).toBe("profile-a");
    expect(after.regionReadiness).toEqual(before.regionReadiness);
  });

  it.each([
    ["operation-global_00000000-0000-4000-8000-000000000001", "global"],
    ["operation-cn_00000000-0000-4000-8000-000000000002", "cn"]
  ] as const)(
    "routes generated operation id %s to the %s adapter",
    async (operationId, expectedRegion) => {
      const global = writeAdapter("global");
      const cn = writeAdapter("cn");
      const client = new DefaultLeetCodeClient({
        readAdapters: regionSet(
          readAdapter("global"),
          readAdapter("cn")
        ) as LeetCodeReadAdapters,
        writeAdapters: regionSet(global, cn) as LeetCodeWriteAdapters
      });

      const result = await client.getOperationStatus(operationId);
      const selected = expectedRegion === "global" ? global : cn;
      const unselected = expectedRegion === "global" ? cn : global;

      expect(result.ok).toBe(true);
      expect(selected.getOperationStatus).toHaveBeenCalledWith(
        operationId,
        undefined
      );
      expect(unselected.getOperationStatus).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["operation-global-legacy", "global"],
    ["operation-cn-legacy", "cn"]
  ] as const)(
    "continues routing legacy operation id %s to the %s adapter",
    async (operationId, expectedRegion) => {
      const global = writeAdapter("global");
      const cn = writeAdapter("cn");
      const client = new DefaultLeetCodeClient({
        readAdapters: regionSet(
          readAdapter("global"),
          readAdapter("cn")
        ) as LeetCodeReadAdapters,
        writeAdapters: regionSet(global, cn) as LeetCodeWriteAdapters
      });

      const result = await client.getOperationStatus(operationId);
      const selected = expectedRegion === "global" ? global : cn;
      const unselected = expectedRegion === "global" ? cn : global;

      expect(result.ok).toBe(true);
      expect(selected.getOperationStatus).toHaveBeenCalledWith(
        operationId,
        undefined
      );
      expect(unselected.getOperationStatus).not.toHaveBeenCalled();
    }
  );

  it("binds search cursors to the exact query and restores the normalized offset", async () => {
    const global = readAdapter("global");
    global.searchProblems = vi.fn(async (input) => ({
      items: input.offset === 0
        ? [
            {
              questionId: "1",
              frontendId: "1",
              title: "Two Sum",
              titleSlug: "two-sum",
              difficulty: "easy" as const,
              paidOnly: false,
              topicTags: []
            }
          ]
        : [],
      page: {
        offset: input.offset ?? 0,
        limit: input.limit ?? 20,
        totalKind: "exact" as const,
        total: 21,
        hasMore: (input.offset ?? 0) === 0
      }
    }));
    const client = new DefaultLeetCodeClient({
      readAdapters: regionSet(global, readAdapter("cn")) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters,
      cursorCodec: createHmacCursorCodec({ key: "search-cursor-key-material-32bytes" })
    });

    const first = await client.searchProblems({
      region: "global",
      query: "two sum",
      limit: 20
    });
    expect(first.ok).toBe(true);
    const cursor = first.ok ? first.data.page.nextCursor : undefined;
    expect(cursor).toMatch(/^lc1\./u);
    if (cursor === undefined) {
      throw new Error("Expected a search cursor");
    }

    const second = await client.searchProblems({
      region: "global",
      query: "two sum",
      limit: 20,
      cursor
    });
    expect(second.ok).toBe(true);
    expect(global.searchProblems).toHaveBeenLastCalledWith(
      { region: "global", query: "two sum", limit: 20, offset: 20 },
      undefined
    );

    const crossQuery = await client.searchProblems({
      region: "global",
      query: "three sum",
      limit: 20,
      cursor
    });
    expect(crossQuery).toMatchObject({
      ok: false,
      error: { code: "STALE_CURSOR" }
    });
  });

  it("wraps CN remote history cursors and binds them to the active profile", async () => {
    const cn = readAdapter("cn");
    cn.getHistory = vi.fn(async (input) => ({
      items: [],
      page: {
        offset: input.offset ?? 0,
        limit: input.limit ?? 20,
        totalKind: "exact" as const,
        total: 21,
        hasMore: input.cursor === undefined,
        ...(input.cursor === undefined ? { nextCursor: "remote-last-key" } : {})
      }
    }));
    let profileId = "profile-a";
    const credentialProvider: CredentialProvider = {
      getCredentials: async (region) => ({
        profileId,
        region,
        session: "session",
        csrfToken: "csrf"
      })
    };
    const client = new DefaultLeetCodeClient({
      credentialProvider,
      readAdapters: regionSet(readAdapter("global"), cn) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters,
      cursorCodec: createHmacCursorCodec({ key: "history-cursor-key-material-32byt" })
    });

    const first = await client.getHistory({
      region: "cn",
      titleSlug: "two-sum",
      limit: 20
    });
    expect(first.ok).toBe(true);
    const cursor = first.ok ? first.data.page.nextCursor : undefined;
    expect(cursor).toMatch(/^lc1\./u);
    if (cursor === undefined) {
      throw new Error("Expected a history cursor");
    }

    const second = await client.getHistory({
      region: "cn",
      titleSlug: "two-sum",
      limit: 20,
      cursor
    });
    expect(second.ok).toBe(true);
    expect(cn.getHistory).toHaveBeenLastCalledWith(
      {
        region: "cn",
        titleSlug: "two-sum",
        limit: 20,
        offset: 20,
        cursor: "remote-last-key"
      },
      undefined
    );

    profileId = "profile-b";
    const wrongProfile = await client.getHistory({
      region: "cn",
      titleSlug: "two-sum",
      limit: 20,
      cursor
    });
    expect(wrongProfile).toMatchObject({
      ok: false,
      error: { code: "STALE_CURSOR" }
    });
  });

  it("rejects legacy operation ids that cannot be routed safely", async () => {
    const client = new DefaultLeetCodeClient({
      readAdapters: regionSet(
        readAdapter("global"),
        readAdapter("cn")
      ) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters
    });

    const result = await client.getOperationStatus("operation-legacy");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
  });

  it("routes NotesPort through the injected regional ports and reports capabilities", async () => {
    const globalNotes = notesPort("global", false);
    const cnNotes = notesPort("cn", true);
    const client = new DefaultLeetCodeClient({
      readAdapters: regionSet(
        readAdapter("global"),
        readAdapter("cn")
      ) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters,
      notesPorts: regionSet(globalNotes, cnNotes) as LeetCodeNotesPorts
    });

    const read = await client.readNotes({ region: "cn", target: "two-sum" });
    expect(read).toMatchObject({
      ok: true,
      data: {
        target: "two-sum",
        content: "stored",
        revision: `sha256:${"1".repeat(64)}`
      }
    });
    const written = await client.writeNotes({
      region: "cn",
      target: "two-sum",
      content: "next",
      expectedRevision: `sha256:${"1".repeat(64)}`
    });
    expect(written).toMatchObject({
      ok: true,
      data: { content: "next", revision: `sha256:${"2".repeat(64)}` }
    });
    expect(cnNotes.read).toHaveBeenCalledOnce();
    expect(cnNotes.write).toHaveBeenCalledOnce();
    expect(client.getCapabilities(true).notesPort).toMatchObject({
      global: { supported: false, revisionMode: "unsupported" },
      cn: {
        supported: true,
        currentlyAvailable: true,
        revisionMode: "best-effort-compare-and-set"
      }
    });
  });

  it("routes the separate current-user Notes API without applying managed NotesPort semantics", async () => {
    const userNotes = userNotesPort();
    const client = new DefaultLeetCodeClient({
      readAdapters: regionSet(readAdapter("global"), readAdapter("cn")) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters,
      userNotesPort: userNotes
    });

    await expect(
      client.searchUserNotes({ keyword: "hash" }, undefined, "profile-a")
    ).resolves.toMatchObject({
      ok: true,
      data: { filters: { orderBy: "DESCENDING" }, notes: [] },
      meta: { region: "cn" }
    });
    await expect(
      client.createUserNote(
        { questionId: "1", content: "private", title: "title" },
        undefined,
        "profile-a"
      )
    ).resolves.toMatchObject({
      ok: true,
      data: { success: true, note: { content: "private", targetId: "1" } }
    });
    expect(userNotes.search).toHaveBeenCalledWith(
      { keyword: "hash" },
      undefined,
      "profile-a"
    );
    expect(userNotes.create).toHaveBeenCalledWith(
      { questionId: "1", content: "private", title: "title" },
      undefined,
      "profile-a"
    );
  });

  it("composes the real CN NotesPort with the problem resolver and fixed endpoint", async () => {
    const cnRead = readAdapter("cn");
    cnRead.getProblem = vi.fn(async () => ({
      questionId: "1",
      frontendId: "1",
      title: "Two Sum",
      titleSlug: "two-sum",
      difficulty: "easy" as const,
      paidOnly: false,
      topicTags: [],
      content: "problem",
      exampleTestcases: [],
      availableLanguages: [],
      selectedCodeSnippet: null,
      enableRunCode: true,
      hints: [],
      similarQuestions: [],
      codeSnippets: []
    }));
    const requests: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response(
        JSON.stringify({
          data: {
            noteOneTargetCommonNote: {
              count: 1,
              userNotes: [
                {
                  id: "managed-1",
                  summary: LEETCODE_MANAGED_NOTE_SUMMARY,
                  content: "stored state"
                }
              ]
            }
          }
        }),
        { headers: { "content-type": "application/json" } }
      );
    };
    const credentialProvider: CredentialProvider = {
      isConfigured: (region) => region === "cn",
      getCredentials: async (region) =>
        region === "cn"
          ? {
              profileId: "profile-cn",
              region: "cn",
              session: "session-value",
              csrfToken: "csrf-value"
            }
          : undefined
    };
    const client = new DefaultLeetCodeClient({
      credentialProvider,
      readAdapters: regionSet(readAdapter("global"), cnRead) as LeetCodeReadAdapters,
      writeAdapters: regionSet(
        writeAdapter("global"),
        writeAdapter("cn")
      ) as LeetCodeWriteAdapters,
      fetch: fetchImpl
    });

    const result = await client.readNotes({ region: "cn", target: "two-sum" });
    expect(result).toMatchObject({
      ok: true,
      data: { content: "stored state", target: "two-sum" }
    });
    expect(cnRead.getProblem).toHaveBeenCalledWith(
      { region: "cn", titleSlug: "two-sum" },
      undefined
    );
    expect(String(requests[0]?.input)).toBe(LEETCODE_CN_NOTES_ENDPOINT);
    expect(client.getCapabilities(true).notesPort.cn).toMatchObject({
      supported: true,
      configured: true,
      currentlyAvailable: true
    });
  });

  it("closes both regional writers and reports unavailable capabilities", async () => {
    const global = writeAdapter("global");
    const cn = writeAdapter("cn");
    const client = new DefaultLeetCodeClient({
      readAdapters: regionSet(
        readAdapter("global"),
        readAdapter("cn")
      ) as LeetCodeReadAdapters,
      writeAdapters: regionSet(global, cn) as LeetCodeWriteAdapters
    });

    await client.close();
    expect(global.close).toHaveBeenCalledOnce();
    expect(cn.close).toHaveBeenCalledOnce();
    expect(
      client.getCapabilities(true).tools.every((tool) => !tool.currentlyAvailable)
    ).toBe(true);
  });
});
