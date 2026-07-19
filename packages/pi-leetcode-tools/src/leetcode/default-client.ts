import { randomBytes, randomUUID } from "node:crypto";

import type {
  CredentialProvider,
  CursorCodec,
  TransportPolicy
} from "../runtime/index.js";
import {
  canonicalCursorQueryFingerprint,
  createHmacCursorCodec,
  createDefaultTransportPolicy,
  createDefaultCredentialProvider
} from "../runtime/index.js";
import {
  BEHAVIOR_MANIFEST_DIGEST,
  CONTRACT_VERSION,
  CAPABILITY_MANIFEST_DIGEST,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_DIGEST,
  TOOL_NAMES
} from "../tool-calls/contract.js";
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
  ToolMeta,
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
} from "../types.js";
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
} from "./client.js";
import { LeetCodeToolError, toToolFailure } from "./errors.js";
import {
  createLeetCodeNotesPorts,
  createLeetCodeUserNotesPort,
  type LeetCodeNotesPorts,
  type LeetCodeUserNotesPort
} from "./notes-port.js";
import {
  createLeetCodeReadAdapters,
  type LeetCodeReadAdapters,
  type LeetCodeReadAdapterOptions
} from "./read-adapter.js";
import {
  createLeetCodeWriteAdapters,
  type LeetCodeWriteAdapters,
  type LeetCodeWriteAdapterOptions
} from "./write-adapter.js";
import {
  takeNormalizationMeta,
  type NormalizationMeta
} from "./adapters/read-normalization.js";

export interface DefaultLeetCodeClientOptions {
  credentialProvider?: CredentialProvider;
  readAdapters?: LeetCodeReadAdapters;
  writeAdapters?: LeetCodeWriteAdapters;
  notesPorts?: LeetCodeNotesPorts;
  userNotesPort?: LeetCodeUserNotesPort;
  fetch?: typeof globalThis.fetch;
  storageDirectory?: string;
  cursorCodec?: CursorCodec;
  transportPolicy?: TransportPolicy;
}

function meta(
  region: Region,
  startedAt: number,
  instanceId: string,
  contextRevision: number,
  accountProfileId?: string,
  normalizationMeta?: NormalizationMeta
): ToolMeta {
  return {
    region,
    packageVersion: PACKAGE_VERSION,
    contractVersion: CONTRACT_VERSION,
    schemaDigest: SCHEMA_DIGEST,
    behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
    instanceId,
    contextRevision,
    ...(accountProfileId === undefined ? {} : { accountProfileId }),
    requestId: randomUUID(),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ...(normalizationMeta === undefined
      ? {}
      : {
          truncated: normalizationMeta.truncated,
          omittedFields: [...normalizationMeta.omittedFields]
        })
  };
}

function operationRegion(operationId: string): Region {
  if (
    operationId.startsWith("operation-global_") ||
    operationId.startsWith("operation-global-")
  ) {
    return "global";
  }
  if (
    operationId.startsWith("operation-cn_") ||
    operationId.startsWith("operation-cn-")
  ) {
    return "cn";
  }
  throw new LeetCodeToolError(
    "VALIDATION_ERROR",
    "operationId does not contain a supported LeetCode region"
  );
}

function searchCursorFingerprint(input: SearchProblemsInput): string {
  return canonicalCursorQueryFingerprint({
    category: input.category ?? "all-code-essentials",
    query: input.query ?? null,
    tags: [...(input.tags ?? [])].sort(),
    difficulty: input.difficulty ?? null,
    limit: input.limit ?? 10
  });
}

function historyCursorFingerprint(input: GetHistoryInput): string {
  return canonicalCursorQueryFingerprint({
    scope: input.scope ?? (input.titleSlug === undefined ? "account" : "problem"),
    titleSlug: input.titleSlug ?? null,
    language: input.language ?? null,
    status: input.status ?? null,
    limit: input.limit ?? 20
  });
}

export class DefaultLeetCodeClient implements LeetCodeClient {
  readonly #credentials: CredentialProvider;
  readonly #read: LeetCodeReadAdapters;
  readonly #write: LeetCodeWriteAdapters;
  readonly #notes: LeetCodeNotesPorts;
  readonly #userNotes: LeetCodeUserNotesPort;
  readonly #cursorCodec: CursorCodec;
  readonly #transportPolicy: TransportPolicy;
  readonly #ownsTransportPolicy: boolean;
  readonly #instanceId = randomUUID();
  #activeAccountProfileId: string | undefined;
  #contextRevision = 1;
  #credentialContextSignature: string;
  #closed = false;

  constructor(options: DefaultLeetCodeClientOptions = {}) {
    this.#credentials = options.credentialProvider ?? createDefaultCredentialProvider();
    this.#activeAccountProfileId = this.#credentials.getActiveProfileId?.();
    this.#credentialContextSignature = this.#currentCredentialContextSignature();
    this.#cursorCodec =
      options.cursorCodec ?? createHmacCursorCodec({ key: randomBytes(32) });
    this.#ownsTransportPolicy = options.transportPolicy === undefined;
    this.#transportPolicy =
      options.transportPolicy ?? createDefaultTransportPolicy();

    const readOptions: LeetCodeReadAdapterOptions = {
      credentialLookup: (region) => this.#credentials.getCredentials(region),
      transportPolicy: this.#transportPolicy,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    };
    const writeOptions: LeetCodeWriteAdapterOptions = {
      credentialProvider: this.#credentials,
      transportPolicy: this.#transportPolicy,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.storageDirectory === undefined
        ? {}
        : { storageDirectory: options.storageDirectory })
    };

    this.#read = options.readAdapters ?? createLeetCodeReadAdapters(readOptions);
    this.#write =
      options.writeAdapters ?? createLeetCodeWriteAdapters(writeOptions);
    this.#notes =
      options.notesPorts ??
      createLeetCodeNotesPorts({
        credentialProvider: this.#credentials,
        transportPolicy: this.#transportPolicy,
        ...(this.#activeAccountProfileId === undefined
          ? {}
          : { accountProfileId: this.#activeAccountProfileId }),
        resolveQuestionId: async (titleSlug, signal) => {
          const problem = await this.#read.cn.getProblem(
            { region: "cn", titleSlug },
            signal
          );
          return problem.questionId;
        },
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      });
    this.#userNotes =
      options.userNotesPort ??
      createLeetCodeUserNotesPort({
        credentialProvider: this.#credentials,
        transportPolicy: this.#transportPolicy,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
      });
  }

  getCapabilities(interactiveUI: boolean): CapabilityManifest {
    this.#refreshCredentialContext();
    const globalSessionConfigured =
      this.#credentials.isConfigured?.("global", "session") ?? true;
    const cnSessionConfigured =
      this.#credentials.isConfigured?.("cn", "session") ?? true;
    const globalOperationConfigured =
      this.#credentials.isConfigured?.("global", "operation") ?? true;
    const cnOperationConfigured =
      this.#credentials.isConfigured?.("cn", "operation") ?? true;
    const sessionConfigured = globalSessionConfigured || cnSessionConfigured;
    const operationConfigured = globalOperationConfigured || cnOperationConfigured;
    const globalNotes = this.#notes.global.getCapability(!this.#closed);
    const cnNotes = this.#notes.cn.getCapability(!this.#closed);
    const observedAt = new Date().toISOString();
    return {
      packageName: PACKAGE_NAME,
      providerId: "pi-leetcode-tools",
      instanceId: this.#instanceId,
      contextRevision: this.#contextRevision,
      ...(this.#activeAccountProfileId === undefined
        ? {}
        : { activeAccountProfileId: this.#activeAccountProfileId }),
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest: SCHEMA_DIGEST,
      behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
      capabilityManifestDigest: CAPABILITY_MANIFEST_DIGEST,
      snapshotRevision: this.#contextRevision,
      observedAt,
      supportedRegions: ["global", "cn"],
      tools: TOOL_NAMES.map((name) => {
        const requiresAuth =
          name === "lc_progress" ||
          name === "lc_history" ||
          name === "lc_submission" ||
          name === "lc_run" ||
          name === "lc_submit" ||
          name === "lc_operation_status";
        const configured =
          !requiresAuth ||
          (name === "lc_progress" || name === "lc_history" || name === "lc_submission"
            ? sessionConfigured
            : operationConfigured);
        return {
          name,
          version: CONTRACT_VERSION,
          supported: true,
          configured,
          currentlyAvailable: !this.#closed && configured,
          ...(!this.#closed
            ? configured
              ? {}
              : { reason: "auth_required" }
            : { reason: "runtime_closed" }),
          requiresAuth,
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
        };
      }),
      notesPort: {
        global: globalNotes,
        cn: cnNotes
      },
      regionReadiness: {
        global: {
          configured: globalSessionConfigured || globalOperationConfigured,
          publicReads: !this.#closed,
          sessionReads: !this.#closed && globalSessionConfigured,
          execution: !this.#closed && globalOperationConfigured,
          externalWrite: !this.#closed && globalOperationConfigured,
          notes: globalNotes.currentlyAvailable
        },
        cn: {
          configured: cnSessionConfigured || cnOperationConfigured,
          publicReads: !this.#closed,
          sessionReads: !this.#closed && cnSessionConfigured,
          execution: !this.#closed && cnOperationConfigured,
          externalWrite: !this.#closed && cnOperationConfigured,
          notes: cnNotes.currentlyAvailable
        }
      },
      interactiveUI
    };
  }

  getDaily(
    region: Region,
    signal?: AbortSignal
  ): Promise<ToolResult<DailyChallenge>> {
    return this.#wrap(region, () => this.#read.forRegion(region).getDaily(signal));
  }

  searchProblems(
    input: SearchProblemsInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SearchProblemsResult>> {
    return this.#wrap(input.region, async () => {
      const queryFingerprint = searchCursorFingerprint(input);
      const decoded =
        input.cursor === undefined
          ? undefined
          : this.#cursorCodec.decode(input.cursor, {
              tool: "search",
              region: input.region,
              queryFingerprint
            });
      const { cursor: _cursor, ...rest } = input;
      const data = await this.#read.forRegion(input.region).searchProblems(
        { ...rest, offset: decoded?.offset ?? input.offset ?? 0 },
        signal
      );
      if (!data.page.hasMore) {
        const { nextCursor: _nextCursor, ...page } = data.page;
        return { ...data, page };
      }
      const nextOffset = data.page.offset + Math.max(data.items.length, data.page.limit);
      return {
        ...data,
        page: {
          ...data.page,
          nextCursor: this.#cursorCodec.encode({
            tool: "search",
            region: input.region,
            queryFingerprint,
            offset: nextOffset
          })
        }
      };
    });
  }

  getProblem(
    input: GetProblemInput,
    signal?: AbortSignal
  ): Promise<ToolResult<ProblemDetail>> {
    return this.#wrap(input.region, () =>
      this.#read.forRegion(input.region).getProblem(input, signal)
    );
  }

  searchSolutions(
    input: GetSolutionSearchInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SolutionSearchResult>> {
    return this.#wrap(input.region, () =>
      this.#read.forRegion(input.region).searchSolutions(input, signal)
    );
  }

  getSolution(
    input: GetSolutionInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SolutionDetail>> {
    return this.#wrap(input.region, () =>
      this.#read.forRegion(input.region).getSolution(input, signal)
    );
  }

  getUserProfile(
    input: GetUserProfileInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserProfile>> {
    return this.#wrap(input.region, () =>
      this.#read.forRegion(input.region).getUserProfile(input, signal)
    );
  }

  getUserContest(
    input: GetUserContestInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserContestResult>> {
    return this.#wrap(input.region, () =>
      this.#read.forRegion(input.region).getUserContest(input, signal)
    );
  }

  getProgress(
    input: GetProgressInput,
    signal?: AbortSignal
  ): Promise<ToolResult<ProblemProgressResult>> {
    return this.#wrap(input.region, () =>
      this.#read.forRegion(input.region).getProgress(input, signal)
    );
  }

  getHistory(
    input: GetHistoryInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SubmissionHistoryResult>> {
    return this.#wrap(input.region, async () => {
      const credentials = await this.#credentials.getCredentials(input.region);
      if (credentials === undefined) {
        throw new LeetCodeToolError(
          "AUTH_REQUIRED",
          `Authentication is required for LeetCode ${input.region}`
        );
      }
      const queryFingerprint = historyCursorFingerprint(input);
      const decoded =
        input.cursor === undefined
          ? undefined
          : this.#cursorCodec.decode(input.cursor, {
              tool: "history",
              region: input.region,
              queryFingerprint,
              profileId: credentials.profileId
            });
      const { cursor: _cursor, ...rest } = input;
      const data = await this.#read.forRegion(input.region).getHistory(
        {
          ...rest,
          offset: decoded?.offset ?? input.offset ?? 0,
          ...(decoded?.remoteCursor === undefined
            ? {}
            : { cursor: decoded.remoteCursor })
        },
        signal
      );
      if (!data.page.hasMore) {
        const { nextCursor: _nextCursor, ...page } = data.page;
        return { ...data, page };
      }
      const nextOffset = data.page.offset + Math.max(data.items.length, data.page.limit);
      return {
        ...data,
        page: {
          ...data.page,
          nextCursor: this.#cursorCodec.encode({
            tool: "history",
            region: input.region,
            queryFingerprint,
            profileId: credentials.profileId,
            offset: nextOffset,
            ...(data.page.nextCursor === undefined
              ? {}
              : { remoteCursor: data.page.nextCursor })
          })
        }
      };
    });
  }

  getUserSubmissions(
    input: GetUserSubmissionsInput,
    signal?: AbortSignal
  ): Promise<ToolResult<UserSubmissionsResult>> {
    return this.#wrap(input.region, () =>
      this.#read.forRegion(input.region).getUserSubmissions(input, signal)
    );
  }

  getSubmissionDetail(
    input: GetSubmissionDetailInput,
    signal?: AbortSignal
  ): Promise<ToolResult<SubmissionDetail>> {
    return this.#wrap(input.region, () =>
      this.#read.forRegion(input.region).getSubmissionDetail(input, signal)
    );
  }

  getUserStatus(
    region: Region,
    signal?: AbortSignal
  ): Promise<ToolResult<UserStatus>> {
    return this.#wrap(region, () => this.#read.forRegion(region).getUserStatus(signal));
  }

  runCode(
    input: RunCodeInput,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>> {
    return this.#wrap(input.region, () =>
      this.#write.forRegion(input.region).runCode(input, signal)
    );
  }

  submitCode(
    input: SubmitCodeInput,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>> {
    return this.#wrap(input.region, () =>
      this.#write.forRegion(input.region).submitCode(input, signal)
    );
  }

  getOperationStatus(
    operationId: string,
    signal?: AbortSignal
  ): Promise<ToolResult<OperationStatus>> {
    this.#refreshCredentialContext();
    let region: Region;
    try {
      region = operationRegion(operationId);
    } catch (error) {
      return Promise.resolve(
        toToolFailure(
          error,
          meta(
            "global",
            performance.now(),
            this.#instanceId,
            this.#contextRevision,
            this.#activeAccountProfileId
          )
        )
      );
    }
    return this.#wrap(region, () =>
      this.#write.forRegion(region).getOperationStatus(operationId, signal)
    );
  }

  readNotes(
    input: NotesReadInput,
    signal?: AbortSignal
  ): Promise<ToolResult<NotesDocument>> {
    return this.#wrap(input.region, () =>
      this.#notes.forRegion(input.region).read(input, signal)
    );
  }

  writeNotes(
    input: NotesWriteInput,
    signal?: AbortSignal
  ): Promise<ToolResult<NotesDocument>> {
    return this.#wrap(input.region, () =>
      this.#notes.forRegion(input.region).write(input, signal)
    );
  }

  searchUserNotes(
    input: UserNotesSearchInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNotesSearchResult>> {
    return this.#wrap("cn", () =>
      this.#userNotes.search(input, signal, expectedAccountProfileId)
    );
  }

  getUserNotes(
    input: UserNotesGetInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNotesGetResult>> {
    return this.#wrap("cn", () =>
      this.#userNotes.get(input, signal, expectedAccountProfileId)
    );
  }

  createUserNote(
    input: UserNotesCreateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNoteMutationResult>> {
    return this.#wrap("cn", () =>
      this.#userNotes.create(input, signal, expectedAccountProfileId)
    );
  }

  updateUserNote(
    input: UserNotesUpdateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<ToolResult<UserNoteMutationResult>> {
    return this.#wrap("cn", () =>
      this.#userNotes.update(input, signal, expectedAccountProfileId)
    );
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.allSettled([this.#write.global.close(), this.#write.cn.close()]);
    if (this.#ownsTransportPolicy) {
      this.#transportPolicy.close();
    }
  }

  async #wrap<T>(
    region: Region,
    operation: () => Promise<T>
  ): Promise<ToolResult<T>> {
    const startedAt = performance.now();
    this.#refreshCredentialContext();
    if (this.#closed) {
      return toToolFailure(
        new LeetCodeToolError("CANCELLED", "LeetCode runtime is closed"),
        meta(
          region,
          startedAt,
          this.#instanceId,
          this.#contextRevision,
          this.#activeAccountProfileId
        )
      );
    }
    try {
      const data = await operation();
      const normalizationMeta = takeNormalizationMeta(data);
      return {
        ok: true,
        data,
        meta: meta(
          region,
          startedAt,
          this.#instanceId,
          this.#contextRevision,
          this.#activeAccountProfileId,
          normalizationMeta
        )
      };
    } catch (error) {
      return toToolFailure(
        error,
        meta(
          region,
          startedAt,
          this.#instanceId,
          this.#contextRevision,
          this.#activeAccountProfileId
        )
      );
    }
  }

  #currentCredentialContextSignature(): string {
    const profileId = this.#credentials.getActiveProfileId?.();
    return JSON.stringify({
      profileId: profileId ?? null,
      credentialRevision: this.#credentials.getRevision?.() ?? null,
      globalSession:
        this.#credentials.isConfigured?.("global", "session") ?? null,
      globalOperation:
        this.#credentials.isConfigured?.("global", "operation") ?? null,
      cnSession: this.#credentials.isConfigured?.("cn", "session") ?? null,
      cnOperation:
        this.#credentials.isConfigured?.("cn", "operation") ?? null
    });
  }

  #refreshCredentialContext(): void {
    const signature = this.#currentCredentialContextSignature();
    if (signature !== this.#credentialContextSignature) {
      this.#credentialContextSignature = signature;
      this.#activeAccountProfileId = this.#credentials.getActiveProfileId?.();
      this.#contextRevision += 1;
    }
  }
}

export function createDefaultLeetCodeClient(
  options: DefaultLeetCodeClientOptions = {}
): LeetCodeClient {
  return new DefaultLeetCodeClient(options);
}
