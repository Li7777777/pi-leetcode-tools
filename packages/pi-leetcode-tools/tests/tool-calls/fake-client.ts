import type {
  GetHistoryInput,
  GetProblemInput,
  GetProgressInput,
  GetSolutionInput,
  GetSolutionSearchInput,
  GetSubmissionDetailInput,
  GetUserContestInput,
  GetUserProfileInput,
  GetUserSubmissionsInput,
  LeetCodeClient,
  RunCodeInput,
  SearchProblemsInput,
  SubmitCodeInput
} from "../../src/leetcode/client.js";
import {
  CONTRACT_VERSION,
  BEHAVIOR_MANIFEST_DIGEST,
  CAPABILITY_MANIFEST_DIGEST,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_DIGEST,
  TOOL_NAMES
} from "../../src/tool-calls/contract.js";
import type {
  CapabilityManifest,
  DailyChallenge,
  NotesDocument,
  NotesReadInput,
  NotesWriteInput,
  OperationStatus,
  ProblemDetail,
  ProblemProgressResult,
  Region,
  SearchProblemsResult,
  SolutionDetail,
  SolutionSearchResult,
  SubmissionDetail,
  SubmissionHistoryResult,
  ToolResult,
  UserContestResult,
  UserNoteMutationResult,
  UserNotesCreateInput,
  UserNotesGetInput,
  UserNotesGetResult,
  UserNotesSearchInput,
  UserNotesSearchResult,
  UserNotesUpdateInput,
  UserProfile,
  UserStatus,
  UserSubmissionsResult
} from "../../src/types.js";

export interface ClientCall {
  method: string;
  input: unknown;
  signal: AbortSignal | undefined;
}

const problem = {
  questionId: "1",
  frontendId: "1",
  title: "Two Sum",
  titleSlug: "two-sum",
  difficulty: "easy" as const,
  paidOnly: false,
  topicTags: []
};

export function createManifest(
  interactiveUI: boolean,
  instanceId = "instance-1"
): CapabilityManifest {
  return {
    packageName: PACKAGE_NAME,
    providerId: "pi-leetcode-tools",
    instanceId,
    contextRevision: 1,
    activeAccountProfileId: "profile-a",
    packageVersion: PACKAGE_VERSION,
    contractVersion: CONTRACT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    schemaDigest: SCHEMA_DIGEST,
    behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
    capabilityManifestDigest: CAPABILITY_MANIFEST_DIGEST,
    snapshotRevision: 1,
    observedAt: "2026-07-15T00:00:00.000Z",
    supportedRegions: ["global", "cn"],
    tools: TOOL_NAMES.map((name) => ({
      name,
      version: CONTRACT_VERSION,
      supported: true,
      configured: true,
      currentlyAvailable: true,
      requiresAuth: ![
        "lc_daily",
        "lc_search",
        "lc_problem",
        "lc_solution_search",
        "lc_solution",
        "lc_profile",
        "lc_contest",
        "lc_user_submissions"
      ].includes(name),
      consequence:
        name === "lc_submit"
          ? "external_write"
          : name === "lc_run"
            ? "execution"
            : name === "lc_submission"
              ? "sensitive_read"
              : name === "lc_solution_search" || name === "lc_solution"
                ? "answer_read"
                : "read",
      ...(name === "lc_solution_search" || name === "lc_solution"
        ? { disclosureRisk: "solution" as const }
        : {})
    })),
    notesPort: {
      global: {
        supported: false,
        configured: false,
        currentlyAvailable: false,
        reason: "unsupported_region",
        revisionMode: "unsupported",
        maxSize: 0
      },
      cn: {
        supported: true,
        configured: true,
        currentlyAvailable: true,
        revisionMode: "best-effort-compare-and-set",
        maxSize: 16_384
      }
    },
    regionReadiness: {
      global: {
        configured: true,
        publicReads: true,
        sessionReads: true,
        execution: true,
        externalWrite: interactiveUI,
        notes: false
      },
      cn: {
        configured: true,
        publicReads: true,
        sessionReads: true,
        execution: true,
        externalWrite: interactiveUI,
        notes: true
      }
    },
    interactiveUI
  };
}

function success<T>(data: T, region: Region = "global"): ToolResult<T> {
  return {
    ok: true,
    data,
    meta: {
      region,
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      schemaDigest: SCHEMA_DIGEST,
      behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
      instanceId: "instance-1",
      contextRevision: 1,
      accountProfileId: "profile-a",
      requestId: "client-request"
    }
  };
}

export class FakeLeetCodeClient implements LeetCodeClient {
  readonly calls: ClientCall[] = [];
  closeCount = 0;
  error: unknown | undefined;
  result: ToolResult<unknown> | undefined;

  constructor(readonly instanceId = "instance-1") {}

  getCapabilities(interactiveUI: boolean): CapabilityManifest {
    return createManifest(interactiveUI, this.instanceId);
  }

  async getDaily(
    region: Region,
    signal?: AbortSignal
  ): Promise<ToolResult<DailyChallenge>> {
    return this.respond("getDaily", region, signal, {
      date: "2026-07-15",
      link: "/problems/two-sum/",
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
      problem
    });
  }

  async searchProblems(
    input: SearchProblemsInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SearchProblemsResult>> {
    return this.respond("searchProblems", input, signal, {
      items: [problem],
      page: { offset: 0, limit: 20, totalKind: "exact", total: 1, hasMore: false }
    });
  }

  async getProblem(
    input: GetProblemInput,
    signal?: AbortSignal
  ): Promise<ToolResult<ProblemDetail>> {
    return this.respond("getProblem", input, signal, {
      ...problem,
      content: "Add two numbers.",
      defaultTestcase: "[2,7,11,15]\n9",
      exampleTestcases: ["[2,7,11,15]\n9"],
      availableLanguages: [],
      selectedCodeSnippet: null,
      enableRunCode: true,
      hints: [],
      similarQuestions: [],
      codeSnippets: []
    });
  }

  async searchSolutions(
    input: GetSolutionSearchInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SolutionSearchResult>> {
    return this.respond("searchSolutions", input, signal, {
      titleSlug: input.titleSlug,
      items: [
        {
          topicId: "100",
          slug: "two-sum-solution",
          title: "Two Sum Solution",
          summary: "Use a hash map.",
          canSee: true,
          hasVideoArticle: false
        }
      ],
      page: { offset: 0, limit: 10, totalKind: "exact", total: 1, hasMore: false }
    });
  }

  async getSolution(
    input: GetSolutionInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SolutionDetail>> {
    return this.respond("getSolution", input, signal, {
      title: "Two Sum Solution",
      slug: input.slug ?? "two-sum-solution",
      ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
      content: "Use a hash map.",
      tags: ["hash-table"]
    });
  }

  async getUserProfile(
    input: GetUserProfileInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserProfile>> {
    return this.respond("getUserProfile", input, signal, {
      username: input.username,
      ranking: 42
    });
  }

  async getUserContest(
    input: GetUserContestInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserContestResult>> {
    return this.respond("getUserContest", input, signal, {
      username: input.username,
      ranking: { attendedContestsCount: 3, rating: 1_500 },
      history: [],
      page: { offset: 0, limit: 50, totalKind: "exact", total: 0, hasMore: false }
    });
  }

  async getProgress(
    input: GetProgressInput,
    signal?: AbortSignal
  ): Promise<ToolResult<ProblemProgressResult>> {
    return this.respond("getProgress", input, signal, {
      filters: { offset: 0, limit: 100 },
      items: [],
      page: { offset: 0, limit: 100, totalKind: "exact", total: 0, hasMore: false }
    });
  }

  async getHistory(
    input: GetHistoryInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SubmissionHistoryResult>> {
    return this.respond("getHistory", input, signal, {
      items: [],
      page: {
        offset: 0,
        limit: 20,
        totalKind: "lower_bound",
        total: 0,
        hasMore: false
      }
    });
  }

  async getUserSubmissions(
    input: GetUserSubmissionsInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserSubmissionsResult>> {
    return this.respond("getUserSubmissions", input, signal, {
      username: input.username,
      mode: input.mode,
      items: [],
      page: {
        offset: 0,
        limit: input.limit ?? 10,
        totalKind: "lower_bound",
        total: 0,
        hasMore: false
      }
    });
  }

  async getSubmissionDetail(
    input: GetSubmissionDetailInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SubmissionDetail>> {
    return this.respond("getSubmissionDetail", input, signal, {
      id: input.submissionId,
      titleSlug: "two-sum",
      language: "cpp",
      status: "Accepted",
      ...(input.includeCode === true ? { code: "class Solution {};" } : {})
    });
  }

  async getUserStatus(
    region: Region,
    signal?: AbortSignal
  ): Promise<ToolResult<UserStatus>> {
    return this.respond("getUserStatus", region, signal, {
      isSignedIn: true,
      username: "active_user",
      isAdmin: false
    });
  }

  async runCode(
    input: RunCodeInput,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>> {
    return this.respond("runCode", input, signal, this.operation("run", input));
  }

  async submitCode(
    input: SubmitCodeInput,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>> {
    return this.respond("submitCode", input, signal, this.operation("submit", input));
  }

  async getOperationStatus(
    operationId: string,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>> {
    return this.respond("getOperationStatus", operationId, signal, {
      ...this.operation("run", {
        region: "global",
        titleSlug: "two-sum",
        language: "typescript"
      }),
      operationId
    });
  }

  async readNotes(
    input: NotesReadInput,
    signal?: AbortSignal
  ): Promise<ToolResult<NotesDocument>> {
    return this.respond("readNotes", input, signal, {
      target: input.target,
      content: "managed-state",
      byteLength: 13,
      revision: `sha256:${"1".repeat(64)}`,
      revisionMode: "best-effort-compare-and-set"
    });
  }

  async writeNotes(
    input: NotesWriteInput,
    signal?: AbortSignal
  ): Promise<ToolResult<NotesDocument>> {
    return this.respond("writeNotes", input, signal, {
      target: input.target,
      content: input.content,
      byteLength: new TextEncoder().encode(input.content).byteLength,
      revision: `sha256:${"2".repeat(64)}`,
      revisionMode: "best-effort-compare-and-set"
    });
  }

  async searchUserNotes(
    input: UserNotesSearchInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNotesSearchResult>> {
    return this.respond("searchUserNotes", { input, expectedAccountProfileId }, signal, {
      filters: {
        ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
        orderBy: input.orderBy ?? "DESCENDING"
      },
      pagination: {
        limit: input.limit ?? 10,
        skip: input.skip ?? 0,
        totalCount: 1
      },
      notes: [{ id: "note-1", summary: "title", content: "private-note" }]
    }, "cn");
  }

  async getUserNotes(
    input: UserNotesGetInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNotesGetResult>> {
    return this.respond("getUserNotes", { input, expectedAccountProfileId }, signal, {
      questionId: input.questionId,
      count: 1,
      pagination: { limit: input.limit ?? 10, skip: input.skip ?? 0 },
      notes: [{ id: "note-1", summary: "title", content: "private-note" }]
    }, "cn");
  }

  async createUserNote(
    input: UserNotesCreateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNoteMutationResult>> {
    return this.respond("createUserNote", { input, expectedAccountProfileId }, signal, {
      success: true,
      note: { id: "note-created", content: input.content, targetId: input.questionId }
    }, "cn");
  }

  async updateUserNote(
    input: UserNotesUpdateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNoteMutationResult>> {
    return this.respond("updateUserNote", { input, expectedAccountProfileId }, signal, {
      success: true,
      note: { id: input.noteId, content: input.content ?? "", targetId: "1" }
    }, "cn");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  private operation(
    kind: "run" | "submit",
    input: { region: Region; titleSlug: string; language: string }
  ): OperationStatus {
    return {
      operationId: `${kind}-1`,
      kind,
      state: "completed",
      region: input.region,
      titleSlug: input.titleSlug,
      language: input.language as OperationStatus["language"],
      codeHash: "hash",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:01.000Z"
    };
  }

  private async respond<T>(
    method: string,
    input: unknown,
    signal: AbortSignal | undefined,
    data: T,
    region: Region = "global"
  ): Promise<ToolResult<T>> {
    this.calls.push({ method, input, signal });
    if (this.error !== undefined) {
      throw this.error;
    }
    return (this.result ?? success(data, region)) as ToolResult<T>;
  }
}
