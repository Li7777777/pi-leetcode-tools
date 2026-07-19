import { createHash } from "node:crypto";

import type { CredentialProvider } from "../runtime/credentials.js";
import type {
  TransportPolicy,
  TransportRetryMode
} from "../runtime/transport-policy.js";
import { createDefaultTransportPolicy } from "../runtime/transport-policy.js";
import type {
  CredentialBundle,
  NotesCapability,
  NotesDocument,
  NotesReadInput,
  NotesWriteInput,
  Region,
  UserNote,
  UserNoteMutationResult,
  UserNotesCreateInput,
  UserNotesGetInput,
  UserNotesGetResult,
  UserNotesSearchInput,
  UserNotesSearchResult,
  UserNotesUpdateInput
} from "../types.js";
import { authRequired, LeetCodeToolError } from "./errors.js";

export const LEETCODE_CN_NOTES_ENDPOINT = "https://leetcode.cn/graphql/";
export const LEETCODE_CN_NOTES_MAX_BYTES = 16 * 1024;
export const LEETCODE_CN_USER_NOTE_MAX_BYTES = 200_000;
export const LEETCODE_MANAGED_NOTE_SUMMARY = "pi-leetcode-tools-state:v1";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const TITLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NUMERIC_QUESTION_ID = /^[0-9]+$/u;

const NOTE_AGGREGATE_QUERY = /* GraphQL */ `
  query noteAggregateNote(
    $aggregateType: AggregateNoteEnum!
    $keyword: String
    $orderBy: AggregateNoteSortingOrderEnum
    $limit: Int = 100
    $skip: Int = 0
  ) {
    noteAggregateNote(
      aggregateType: $aggregateType
      keyword: $keyword
      orderBy: $orderBy
      limit: $limit
      skip: $skip
    ) {
      count
      userNotes {
        id
        summary
        content
        ... on NoteAggregateQuestionNoteNode {
          noteQuestion {
            linkTemplate
            questionId
            title
            translatedTitle
          }
        }
      }
    }
  }
`;

const NOTE_BY_QUESTION_ID_QUERY = /* GraphQL */ `
  query noteOneTargetCommonNote(
    $noteType: NoteCommonTypeEnum!
    $questionId: String!
    $limit: Int = 100
    $skip: Int = 0
  ) {
    noteOneTargetCommonNote(
      noteType: $noteType
      targetId: $questionId
      limit: $limit
      skip: $skip
    ) {
      count
      userNotes {
        id
        summary
        content
      }
    }
  }
`;

const NOTE_CREATE_MUTATION = /* GraphQL */ `
  mutation noteCreateCommonNote(
    $content: String!
    $noteType: NoteCommonTypeEnum!
    $targetId: String!
    $summary: String!
  ) {
    noteCreateCommonNote(
      content: $content
      noteType: $noteType
      targetId: $targetId
      summary: $summary
    ) {
      note {
        id
        content
        targetId
      }
      ok
    }
  }
`;

const NOTE_UPDATE_MUTATION = /* GraphQL */ `
  mutation noteUpdateUserNote(
    $content: String!
    $noteId: ID!
    $summary: String!
  ) {
    noteUpdateUserNote(
      content: $content
      noteId: $noteId
      summary: $summary
    ) {
      note {
        id
        content
        targetId
      }
      ok
    }
  }
`;

type UnknownRecord = Record<string, unknown>;

export type NotesFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type ResolveQuestionId = (
  titleSlug: string,
  signal?: AbortSignal
) => string | Promise<string>;

export interface LeetCodeNotesPortOptions {
  credentialProvider: CredentialProvider;
  resolveQuestionId?: ResolveQuestionId;
  accountProfileId?: string;
  fetch?: NotesFetch;
  transportPolicy?: TransportPolicy;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  configured?: boolean;
}

export interface LeetCodeNotesPort {
  readonly region: Region;
  getCapability(runtimeAvailable: boolean): NotesCapability;
  read(input: NotesReadInput, signal?: AbortSignal): Promise<NotesDocument>;
  write(input: NotesWriteInput, signal?: AbortSignal): Promise<NotesDocument>;
}

export interface LeetCodeNotesPorts {
  readonly global: LeetCodeNotesPort;
  readonly cn: LeetCodeNotesPort;
  forRegion(region: Region): LeetCodeNotesPort;
}

/**
 * Arbitrary personal notes belonging to the current authenticated CN account.
 * This is deliberately separate from the revisioned state NotesPort: it has no
 * titleSlug resolver, managed summary, revision, merge, or compare-and-set
 * semantics.
 */
export interface LeetCodeUserNotesPort {
  readonly region: "cn";
  search(
    input: UserNotesSearchInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<UserNotesSearchResult>;
  get(
    input: UserNotesGetInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<UserNotesGetResult>;
  create(
    input: UserNotesCreateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<UserNoteMutationResult>;
  update(
    input: UserNotesUpdateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<UserNoteMutationResult>;
}

interface ManagedNoteState {
  target: string;
  questionId: string;
  noteId?: string;
  content: string;
  revision: string | null;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validationError(message: string): LeetCodeToolError {
  return new LeetCodeToolError("VALIDATION_ERROR", message);
}

function throwIfNotesAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new LeetCodeToolError("CANCELLED", "LeetCode notes request was cancelled");
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): UnknownRecord {
  if (!isRecord(value)) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected notes response shape"
    );
  }
  return value;
}

function isSafeCredentialValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 16_384 &&
    !/[\u0000-\u0020\u007f;,]/u.test(value)
  );
}

function isSafeProfileId(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}

function revisionFor(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function validateTarget(input: NotesReadInput, region: Region): void {
  if (input.region !== region) {
    throw validationError(`Input region ${input.region} does not match ${region} NotesPort`);
  }
  if (!TITLE_SLUG.test(input.target)) {
    throw validationError("Notes target must be a valid LeetCode title slug");
  }
}

function validateUserNotesRegion(region: Region | undefined): void {
  if (region !== undefined && region !== "cn") {
    throw new LeetCodeToolError(
      "UNSUPPORTED_REGION",
      "Personal notes are available only on LeetCode cn"
    );
  }
}

function validateQuestionId(questionId: string): void {
  if (questionId.length > 20 || !NUMERIC_QUESTION_ID.test(questionId)) {
    throw validationError("questionId must be a numeric LeetCode CN question ID");
  }
}

function validateUserNoteId(noteId: string): void {
  if (
    noteId.length === 0 ||
    noteId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(noteId)
  ) {
    throw validationError("noteId is invalid");
  }
}

function validateUserNoteContent(content: string): void {
  if (utf8Length(content) > LEETCODE_CN_USER_NOTE_MAX_BYTES) {
    throw validationError(
      `Personal note content must not exceed ${LEETCODE_CN_USER_NOTE_MAX_BYTES} UTF-8 bytes`
    );
  }
}

function validateUserNoteTitle(title: string): void {
  if (title.length > 2_048) {
    throw validationError("Personal note title must not exceed 2048 characters");
  }
}

function normalizedUserNotesPage(
  limit: number | undefined,
  skip: number | undefined
): { limit: number; skip: number } {
  const normalizedLimit = limit ?? 10;
  const normalizedSkip = skip ?? 0;
  if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
    throw validationError("Personal notes limit must be an integer from 1 to 100");
  }
  if (!Number.isSafeInteger(normalizedSkip) || normalizedSkip < 0 || normalizedSkip > 1_000_000) {
    throw validationError("Personal notes skip must be an integer from 0 to 1000000");
  }
  return { limit: normalizedLimit, skip: normalizedSkip };
}

function decodeUserNote(value: unknown): UserNote {
  const note = record(value);
  if (
    typeof note.id !== "string" ||
    note.id.length === 0 ||
    note.id.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(note.id) ||
    typeof note.summary !== "string" ||
    note.summary.length > 2_048 ||
    typeof note.content !== "string" ||
    utf8Length(note.content) > LEETCODE_CN_USER_NOTE_MAX_BYTES
  ) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected personal note shape"
    );
  }

  let noteQuestion: UserNote["noteQuestion"];
  if (note.noteQuestion !== undefined && note.noteQuestion !== null) {
    const question = record(note.noteQuestion);
    if (
      typeof question.linkTemplate !== "string" ||
      question.linkTemplate.length === 0 ||
      question.linkTemplate.length > 2_048 ||
      typeof question.questionId !== "string" ||
      question.questionId.length > 20 ||
      !NUMERIC_QUESTION_ID.test(question.questionId) ||
      typeof question.title !== "string" ||
      question.title.length === 0 ||
      question.title.length > 512 ||
      (question.translatedTitle !== undefined &&
        question.translatedTitle !== null &&
        (typeof question.translatedTitle !== "string" ||
          question.translatedTitle.length > 512))
    ) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an unexpected note question shape"
      );
    }
    noteQuestion = {
      linkTemplate: question.linkTemplate,
      questionId: question.questionId,
      title: question.title,
      ...(question.translatedTitle === undefined
        ? {}
        : { translatedTitle: question.translatedTitle as string | null })
    };
  } else if (note.noteQuestion === null) {
    noteQuestion = null;
  }

  return {
    id: note.id,
    summary: note.summary,
    content: note.content,
    ...(noteQuestion === undefined ? {} : { noteQuestion })
  };
}

function decodeUserNotesAggregate(
  value: unknown
): { count: number; userNotes: UserNote[] } {
  const aggregate = record(value);
  if (!Array.isArray(aggregate.userNotes)) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected personal notes list"
    );
  }
  if (
    typeof aggregate.count !== "number" ||
    !Number.isSafeInteger(aggregate.count) ||
    aggregate.count < aggregate.userNotes.length ||
    aggregate.userNotes.length > 100
  ) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected personal notes count"
    );
  }
  return {
    count: aggregate.count,
    userNotes: aggregate.userNotes.map(decodeUserNote)
  };
}

function decodeUserNoteMutation(value: unknown): UserNoteMutationResult {
  const result = record(value);
  if (typeof result.ok !== "boolean") {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected personal note mutation result"
    );
  }
  if (result.note === null) {
    if (result.ok) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode acknowledged a personal note mutation without a note"
      );
    }
    return { success: false, note: null };
  }

  const note = record(result.note);
  if (
    typeof note.id !== "string" ||
    note.id.length === 0 ||
    note.id.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(note.id) ||
    typeof note.content !== "string" ||
    utf8Length(note.content) > LEETCODE_CN_USER_NOTE_MAX_BYTES ||
    typeof note.targetId !== "string" ||
    note.targetId.length === 0 ||
    note.targetId.length > 128
  ) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected personal note mutation payload"
    );
  }
  return {
    success: result.ok,
    note: { id: note.id, content: note.content, targetId: note.targetId }
  };
}

class UnsupportedNotesPort implements LeetCodeNotesPort {
  readonly region: Region;

  constructor(region: Region) {
    this.region = region;
  }

  getCapability(): NotesCapability {
    return {
      supported: false,
      configured: false,
      currentlyAvailable: false,
      reason: "unsupported_region",
      revisionMode: "unsupported",
      maxSize: 0
    };
  }

  read(input: NotesReadInput): Promise<NotesDocument> {
    validateTarget(input, this.region);
    return Promise.reject(
      new LeetCodeToolError(
        "CAPABILITY_UNAVAILABLE",
        `NotesPort is unavailable for LeetCode ${this.region}`
      )
    );
  }

  write(input: NotesWriteInput): Promise<NotesDocument> {
    return this.read(input);
  }
}

export class LeetCodeCnNotesPort implements LeetCodeNotesPort, LeetCodeUserNotesPort {
  readonly region = "cn" as const;

  readonly #credentialProvider: CredentialProvider;
  readonly #resolveQuestionId: ResolveQuestionId | undefined;
  readonly #fetchImpl: NotesFetch;
  readonly #transportPolicy: TransportPolicy;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #configured: boolean;
  readonly #accountProfileId: string | undefined;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: LeetCodeNotesPortOptions) {
    this.#credentialProvider = options.credentialProvider;
    this.#resolveQuestionId = options.resolveQuestionId;
    this.#fetchImpl = options.fetch ?? globalThis.fetch;
    this.#transportPolicy =
      options.transportPolicy ?? createDefaultTransportPolicy();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#configured =
      options.configured ??
      options.credentialProvider.isConfigured?.("cn", "operation") ??
      true;
    this.#accountProfileId = options.accountProfileId;

    if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw validationError("requestTimeoutMs must be a positive finite number");
    }
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1) {
      throw validationError("maxResponseBytes must be a positive integer");
    }
  }

  getCapability(runtimeAvailable: boolean): NotesCapability {
    const currentlyAvailable = runtimeAvailable && this.#configured;
    return {
      supported: true,
      configured: this.#configured,
      currentlyAvailable,
      ...(!runtimeAvailable
        ? { reason: "runtime_closed" }
        : this.#configured
          ? {}
          : { reason: "auth_required" }),
      revisionMode: "best-effort-compare-and-set",
      maxSize: LEETCODE_CN_NOTES_MAX_BYTES
    };
  }

  async search(
    input: UserNotesSearchInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<UserNotesSearchResult> {
    validateUserNotesRegion(input.region);
    if (input.keyword !== undefined && input.keyword.length > 2_048) {
      throw validationError("Personal notes keyword must not exceed 2048 characters");
    }
    if (
      input.orderBy !== undefined &&
      input.orderBy !== "ASCENDING" &&
      input.orderBy !== "DESCENDING"
    ) {
      throw validationError("Personal notes orderBy is invalid");
    }
    const { limit, skip } = normalizedUserNotesPage(input.limit, input.skip);
    const orderBy = input.orderBy ?? "DESCENDING";
    const credentials = await this.#credentials("session", expectedAccountProfileId);
    const aggregate = await this.#request(
      "noteAggregateNote",
      NOTE_AGGREGATE_QUERY,
      {
        aggregateType: "QUESTION_NOTE",
        ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
        orderBy,
        limit,
        skip
      },
      credentials,
      signal,
      "safe-read",
      true,
      (data) => decodeUserNotesAggregate(data.noteAggregateNote)
    );
    return {
      filters: {
        ...(input.keyword === undefined ? {} : { keyword: input.keyword }),
        orderBy
      },
      pagination: { limit, skip, totalCount: aggregate.count },
      notes: aggregate.userNotes
    };
  }

  async get(
    input: UserNotesGetInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<UserNotesGetResult> {
    validateUserNotesRegion(input.region);
    validateQuestionId(input.questionId);
    const { limit, skip } = normalizedUserNotesPage(input.limit, input.skip);
    const credentials = await this.#credentials("session", expectedAccountProfileId);
    const aggregate = await this.#request(
      "noteOneTargetCommonNote",
      NOTE_BY_QUESTION_ID_QUERY,
      {
        noteType: "COMMON_QUESTION",
        questionId: input.questionId,
        limit,
        skip
      },
      credentials,
      signal,
      "safe-read",
      true,
      (data) => decodeUserNotesAggregate(data.noteOneTargetCommonNote)
    );
    return {
      questionId: input.questionId,
      count: aggregate.count,
      pagination: { limit, skip },
      notes: aggregate.userNotes
    };
  }

  create(
    input: UserNotesCreateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<UserNoteMutationResult> {
    validateUserNotesRegion(input.region);
    validateQuestionId(input.questionId);
    validateUserNoteContent(input.content);
    const title = input.title ?? "";
    validateUserNoteTitle(title);
    return this.#serialized(`user-create:${input.questionId}`, signal, () =>
      this.#userMutation(
        "noteCreateCommonNote",
        NOTE_CREATE_MUTATION,
        {
          content: input.content,
          noteType: "COMMON_QUESTION",
          targetId: input.questionId,
          summary: title
        },
        signal,
        expectedAccountProfileId
      )
    );
  }

  update(
    input: UserNotesUpdateInput,
    signal?: AbortSignal,
    expectedAccountProfileId?: string
  ): Promise<UserNoteMutationResult> {
    validateUserNotesRegion(input.region);
    validateUserNoteId(input.noteId);
    const content = input.content ?? "";
    const title = input.title ?? "";
    validateUserNoteContent(content);
    validateUserNoteTitle(title);
    return this.#serialized(`user-update:${input.noteId}`, signal, () =>
      this.#userMutation(
        "noteUpdateUserNote",
        NOTE_UPDATE_MUTATION,
        { content, noteId: input.noteId, summary: title },
        signal,
        expectedAccountProfileId
      )
    );
  }

  async read(input: NotesReadInput, signal?: AbortSignal): Promise<NotesDocument> {
    validateTarget(input, this.region);
    const credentials = await this.#credentials("operation");
    const state = await this.#readState(input.target, credentials, signal);
    return this.#document(state);
  }

  write(input: NotesWriteInput, signal?: AbortSignal): Promise<NotesDocument> {
    validateTarget(input, this.region);
    if (utf8Length(input.content) > LEETCODE_CN_NOTES_MAX_BYTES) {
      return Promise.reject(
        validationError(
          `Notes content must not exceed ${LEETCODE_CN_NOTES_MAX_BYTES} UTF-8 bytes`
        )
      );
    }
    if (
      input.expectedRevision !== null &&
      !/^sha256:[a-f0-9]{64}$/u.test(input.expectedRevision)
    ) {
      return Promise.reject(validationError("expectedRevision is invalid"));
    }
    return this.#serialized(input.target, signal, async () => {
      const credentials = await this.#credentials("operation");
      const current = await this.#readState(input.target, credentials, signal);
      if (current.revision !== input.expectedRevision) {
        throw new LeetCodeToolError(
          "STALE_OPERATION",
          "LeetCode notes changed after they were read",
          {
            details: {
              revisionConflict: true,
              currentRevision: current.revision
            }
          }
        );
      }

      try {
        if (current.noteId === undefined) {
          await this.#mutate("noteCreateCommonNote", NOTE_CREATE_MUTATION, {
            content: input.content,
            noteType: "COMMON_QUESTION",
            targetId: current.questionId,
            summary: LEETCODE_MANAGED_NOTE_SUMMARY
          }, credentials, signal);
        } else {
          await this.#mutate("noteUpdateUserNote", NOTE_UPDATE_MUTATION, {
            content: input.content,
            noteId: current.noteId,
            summary: LEETCODE_MANAGED_NOTE_SUMMARY
          }, credentials, signal);
        }
      } catch (error) {
        if (
          error instanceof LeetCodeToolError &&
          (error.code === "CANCELLED" || error.code === "REMOTE_UNAVAILABLE")
        ) {
          throw new LeetCodeToolError(
            "UNKNOWN_WRITE_OUTCOME",
            "The LeetCode notes write outcome could not be verified; read before retrying",
            { details: { writeOutcomeUnverified: true } }
          );
        }
        throw error;
      }

      let verified: ManagedNoteState;
      try {
        verified = await this.#readState(input.target, credentials, signal);
      } catch (error) {
        throw new LeetCodeToolError(
          "UNKNOWN_WRITE_OUTCOME",
          "The LeetCode notes write could not be verified; read before retrying",
          { details: { writeVerificationFailed: true }, cause: error }
        );
      }
      if (verified.content !== input.content || verified.noteId === undefined) {
        throw new LeetCodeToolError(
          "UNKNOWN_WRITE_OUTCOME",
          "The LeetCode notes write did not match the requested content",
          { details: { writeVerificationFailed: true } }
        );
      }
      return this.#document(verified);
    });
  }

  async #serialized<T>(
    target: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.#tails.get(target) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(target, tail);
    await previous;
    if (signal?.aborted === true) {
      release();
      if (this.#tails.get(target) === tail) {
        this.#tails.delete(target);
      }
      throw new LeetCodeToolError("CANCELLED", "LeetCode notes request was cancelled");
    }
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(target) === tail) {
        this.#tails.delete(target);
      }
    }
  }

  #document(state: ManagedNoteState): NotesDocument {
    return {
      target: state.target,
      content: state.content,
      byteLength: utf8Length(state.content),
      revision: state.revision,
      revisionMode: "best-effort-compare-and-set"
    };
  }

  async #readState(
    target: string,
    credentials: CredentialBundle,
    signal?: AbortSignal
  ): Promise<ManagedNoteState> {
    if (signal?.aborted === true) {
      throw new LeetCodeToolError("CANCELLED", "LeetCode notes request was cancelled");
    }
    if (this.#resolveQuestionId === undefined) {
      throw new LeetCodeToolError(
        "CAPABILITY_UNAVAILABLE",
        "The revisioned NotesPort question resolver is unavailable"
      );
    }
    const questionId = await this.#resolveQuestionId(target, signal);
    if (
      typeof questionId !== "string" ||
      questionId.length === 0 ||
      questionId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(questionId)
    ) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an invalid question identifier"
      );
    }

    return this.#request(
      "noteOneTargetCommonNote",
      NOTE_BY_QUESTION_ID_QUERY,
      {
        noteType: "COMMON_QUESTION",
        questionId,
        limit: 100,
        skip: 0
      },
      credentials,
      signal,
      "safe-read",
      true,
      (data) => {
    const aggregate = record(data.noteOneTargetCommonNote);
    if (!Array.isArray(aggregate.userNotes)) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an unexpected notes response shape"
      );
    }
    if (
      typeof aggregate.count !== "number" ||
      !Number.isSafeInteger(aggregate.count) ||
      aggregate.count < aggregate.userNotes.length
    ) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an unexpected notes count"
      );
    }

    const managed = aggregate.userNotes.filter(
      (value) => isRecord(value) && value.summary === LEETCODE_MANAGED_NOTE_SUMMARY
    );
    if (managed.length > 1) {
      throw new LeetCodeToolError(
        "STALE_OPERATION",
        "Multiple managed LeetCode notes require manual reconciliation",
        { details: { duplicateManagedNotes: true } }
      );
    }
    if (managed.length === 0) {
      if (aggregate.count > aggregate.userNotes.length) {
        throw new LeetCodeToolError(
          "STALE_OPERATION",
          "The LeetCode notes list was truncated before the managed note could be identified",
          { details: { notesListTruncated: true } }
        );
      }
      return {
        target,
        questionId,
        content: "",
        revision: null
      };
    }

    const note = record(managed[0]);
    if (
      typeof note.id !== "string" ||
      note.id.length === 0 ||
      note.id.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(note.id) ||
      typeof note.content !== "string"
    ) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an unexpected managed note shape"
      );
    }
    if (utf8Length(note.content) > LEETCODE_CN_NOTES_MAX_BYTES) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "The managed LeetCode note exceeds the supported size limit"
      );
    }
    return {
      target,
      questionId,
      noteId: note.id,
      content: note.content,
      revision: revisionFor(note.content)
    };
      }
    );
  }

  async #mutate(
    operationName: "noteCreateCommonNote" | "noteUpdateUserNote",
    query: string,
    variables: UnknownRecord,
    credentials: CredentialBundle,
    signal?: AbortSignal
  ): Promise<void> {
    await this.#request(
      operationName,
      query,
      variables,
      credentials,
      signal,
      "never",
      false,
      (data) => {
        const result = record(data[operationName]);
        if (
          result.ok !== true ||
          !isRecord(result.note) ||
          typeof result.note.id !== "string"
        ) {
          throw new LeetCodeToolError(
            "EXECUTION_FAILED",
            "LeetCode did not acknowledge the notes write"
          );
        }
      },
      true
    );
  }

  async #userMutation(
    operationName: "noteCreateCommonNote" | "noteUpdateUserNote",
    query: string,
    variables: UnknownRecord,
    signal: AbortSignal | undefined,
    expectedAccountProfileId: string | undefined
  ): Promise<UserNoteMutationResult> {
    const credentials = await this.#credentials("operation", expectedAccountProfileId);
    try {
      return await this.#request(
        operationName,
        query,
        variables,
        credentials,
        signal,
        "never",
        false,
        (data) => decodeUserNoteMutation(data[operationName]),
        true
      );
    } catch (error) {
      if (
        error instanceof LeetCodeToolError &&
        (error.code === "CANCELLED" || error.code === "REMOTE_UNAVAILABLE")
      ) {
        throw new LeetCodeToolError(
          "UNKNOWN_WRITE_OUTCOME",
          "The LeetCode personal note write outcome is unknown; read before retrying",
          { details: { writeOutcomeUnverified: true } }
        );
      }
      throw error;
    }
  }

  async #credentials(
    requirement: "session" | "operation",
    expectedAccountProfileId = this.#accountProfileId
  ): Promise<CredentialBundle> {
    if (this.#credentialProvider.isConfigured?.("cn", requirement) === false) {
      throw authRequired("cn");
    }
    let credentials: CredentialBundle | undefined;
    try {
      credentials = await this.#credentialProvider.getCredentials("cn");
    } catch {
      throw authRequired("cn");
    }
    if (credentials === undefined || credentials.region !== "cn") {
      throw authRequired("cn");
    }
    if (
      !isSafeProfileId(credentials.profileId) ||
      !isSafeCredentialValue(credentials.session) ||
      (credentials.csrfToken.length > 0 && !isSafeCredentialValue(credentials.csrfToken)) ||
      (requirement === "operation" && credentials.csrfToken.length === 0)
    ) {
      throw authRequired("cn");
    }
    if (
      expectedAccountProfileId !== undefined &&
      credentials.profileId !== expectedAccountProfileId
    ) {
      throw new LeetCodeToolError(
        "STALE_OPERATION",
        "The active LeetCode credential profile changed"
      );
    }
    return credentials;
  }

  async #request<T>(
    operationName: string,
    query: string,
    variables: UnknownRecord,
    credentials: CredentialBundle,
    signal: AbortSignal | undefined,
    retryMode: TransportRetryMode,
    recoveryProbe: boolean,
    decode: (data: UnknownRecord) => T,
    uncertainOnAbort = false
  ): Promise<T> {
    throwIfNotesAborted(signal);
    const cookie =
      credentials.csrfToken.length === 0
        ? `LEETCODE_SESSION=${credentials.session}`
        : `LEETCODE_SESSION=${credentials.session}; csrftoken=${credentials.csrfToken}`;

    return this.#transportPolicy.execute(
      {
        region: "cn",
        operation: operationName,
        retryMode,
        recoveryProbe,
        profileId: credentials.profileId,
        requestTimeoutMs: this.#requestTimeoutMs,
        uncertainOnAbort,
        ...(signal === undefined ? {} : { signal })
      },
      async ({ signal: requestSignal }) => {
        try {
          const response = await this.#fetchImpl(LEETCODE_CN_NOTES_ENDPOINT, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              origin: "https://leetcode.cn",
              referer: "https://leetcode.cn/",
              cookie,
              ...(credentials.csrfToken.length === 0
                ? {}
                : { "x-csrftoken": credentials.csrfToken }),
              "x-requested-with": "XMLHttpRequest"
            },
            body: JSON.stringify({ operationName, query, variables }),
            redirect: "manual",
            cache: "no-store",
            signal: requestSignal
          });

      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new LeetCodeToolError(
          "REMOTE_UNAVAILABLE",
          "LeetCode returned a redirect that was not followed",
          { details: { redirectRejected: true } }
        );
      }
      if (response.url.length > 0) {
        let finalUrl: URL;
        try {
          finalUrl = new URL(response.url);
        } catch {
          throw new LeetCodeToolError(
            "REMOTE_UNAVAILABLE",
            "LeetCode returned an invalid response URL"
          );
        }
        if (finalUrl.protocol !== "https:" || finalUrl.origin !== "https://leetcode.cn") {
          throw new LeetCodeToolError(
            "REMOTE_UNAVAILABLE",
            "LeetCode response crossed the fixed host boundary",
            { details: { redirectRejected: true } }
          );
        }
      }
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        throw new LeetCodeToolError("RATE_LIMITED", "LeetCode rate limit was reached", {
          retryable: true,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs })
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new LeetCodeToolError(
          "AUTH_EXPIRED",
          "Authentication expired for LeetCode cn"
        );
      }
      if (response.status >= 500) {
        throw new LeetCodeToolError(
          "REMOTE_UNAVAILABLE",
          "LeetCode is temporarily unavailable",
          { retryable: true, details: { status: response.status } }
        );
      }
      if (!response.ok) {
        throw new LeetCodeToolError(
          "REMOTE_SCHEMA_CHANGED",
          "LeetCode rejected the notes request",
          { details: { status: response.status } }
        );
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        !contentType.startsWith("application/json") &&
        !contentType.startsWith("application/graphql-response+json")
      ) {
        throw new LeetCodeToolError(
          "REMOTE_SCHEMA_CHANGED",
          "LeetCode returned an unsupported content type"
        );
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const declaredLength = Number(contentLength);
        if (Number.isFinite(declaredLength) && declaredLength > this.#maxResponseBytes) {
          throw new LeetCodeToolError(
            "REMOTE_SCHEMA_CHANGED",
            "LeetCode response exceeded the configured size limit"
          );
        }
      }
      const responseText = await response.text();
      if (utf8Length(responseText) > this.#maxResponseBytes) {
        throw new LeetCodeToolError(
          "REMOTE_SCHEMA_CHANGED",
          "LeetCode response exceeded the configured size limit"
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new LeetCodeToolError(
          "REMOTE_SCHEMA_CHANGED",
          "LeetCode returned malformed JSON"
        );
      }
      const responseObject = record(payload);
      if (responseObject.errors !== undefined) {
        if (!Array.isArray(responseObject.errors)) {
          throw new LeetCodeToolError(
            "REMOTE_SCHEMA_CHANGED",
            "LeetCode returned an unexpected GraphQL error shape"
          );
        }
        if (responseObject.errors.length > 0) {
          const authError = responseObject.errors.some(
            (error) =>
              isRecord(error) &&
              typeof error.message === "string" &&
              /auth|login|sign(?:ed)?\s*in|permission|unauthorized/i.test(error.message)
          );
          throw new LeetCodeToolError(
            authError ? "AUTH_EXPIRED" : "REMOTE_SCHEMA_CHANGED",
            authError
              ? "Authentication expired for LeetCode cn"
              : "LeetCode returned a GraphQL error"
          );
        }
      }
          return decode(record(responseObject.data));
        } catch (error) {
          if (error instanceof LeetCodeToolError) {
            throw error;
          }
          throw new LeetCodeToolError(
            "REMOTE_UNAVAILABLE",
            "LeetCode notes request failed",
            {
              retryable: true,
              details: {
                ...(uncertainOnAbort ? { transportUncertain: true } : {})
              }
            }
          );
        }
      }
    );
  }
}

export function createLeetCodeNotesPorts(
  options: LeetCodeNotesPortOptions
): LeetCodeNotesPorts {
  const global = new UnsupportedNotesPort("global");
  const cn = new LeetCodeCnNotesPort(options);
  return {
    global,
    cn,
    forRegion(region) {
      return region === "cn" ? cn : global;
    }
  };
}

export function createLeetCodeUserNotesPort(
  options: Omit<LeetCodeNotesPortOptions, "resolveQuestionId" | "configured">
): LeetCodeUserNotesPort {
  return new LeetCodeCnNotesPort(options);
}
