import { join } from "node:path";

import type { RunCodeInput, SubmitCodeInput } from "./client.js";
import { authRequired, LeetCodeToolError } from "./errors.js";
import {
  MAX_TESTCASE_BYTES,
  canonicalLanguageToRemote,
  remoteLanguageToCanonical,
  type CanonicalLanguage
} from "../tool-calls/contract.js";
import type { Clock, IdGenerator } from "../runtime/abstractions.js";
import {
  randomIdGenerator,
  systemClock
} from "../runtime/abstractions.js";
import type { CredentialProvider } from "../runtime/credentials.js";
import type { LockStore } from "../runtime/file-lease-lock.js";
import {
  FileLeaseLock,
  LeaseLostError,
  LeaseUnavailableError
} from "../runtime/file-lease-lock.js";
import { sha256Hex } from "../runtime/hash.js";
import type { OperationStore } from "../runtime/operation-store.js";
import {
  AtomicJsonOperationStore,
  OperationStoreCapacityError,
  OperationStoreCorruptError,
  OperationStoreUnsupportedVersionError
} from "../runtime/operation-store.js";
import type { RateLimiter } from "../runtime/rate-limiter.js";
import {
  RateLimiterClosedError,
  RateLimitQueueFullError
} from "../runtime/rate-limiter.js";
import type {
  TransportPolicy,
  TransportRetryMode
} from "../runtime/transport-policy.js";
import { createDefaultTransportPolicy } from "../runtime/transport-policy.js";
import type {
  CredentialBundle,
  JudgeResult,
  OperationKind,
  OperationStatus,
  Region,
  ToolErrorCode
} from "../types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const MINIMUM_EFFECTIVE_POLL_INTERVAL_MS = 200;
const MAXIMUM_RATE_LIMIT_BACKOFF_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_LOCK_TTL_MS = 60_000;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_OPERATION_MAX_RECORDS = 2_048;
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CODE_BYTES = 400_000;
const MAX_REMOTE_PAYLOAD_DEPTH = 16;
const MAX_REMOTE_PAYLOAD_NODES = 8_192;
const MAX_REMOTE_OBJECT_PROPERTIES = 512;
const MAX_REMOTE_ARRAY_ITEMS = 2_048;
const MAX_REMOTE_KEY_LENGTH = 128;
const MAX_REMOTE_STRING_BYTES = 200_000;
const MAX_TRANSIENT_ENVELOPE_BYTES = 900_000;
const TITLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REMOTE_ID = /^(?=.{1,128}$)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type LedgerOperationState =
  | "prepared"
  | "confirmed"
  | "dispatch_intent"
  | "dispatched"
  | "polling"
  | "completed"
  | "unknown"
  | "failed"
  | "cancelled";

interface StoredOperation extends Omit<
  OperationStatus,
  "state" | "questionId" | "start" | "checkUrl" | "check"
> {
  state: LedgerOperationState;
}

const STORED_STATES = new Set<LedgerOperationState>([
  "prepared",
  "confirmed",
  "dispatch_intent",
  "dispatched",
  "polling",
  "completed",
  "unknown",
  "failed",
  "cancelled"
]);

const BLOCKING_SUBMIT_STATES = new Set<LedgerOperationState>([
  "prepared",
  "confirmed",
  "dispatch_intent",
  "dispatched",
  "polling",
  "completed",
  "unknown"
]);

type UnknownRecord = Record<string, unknown>;

const FORBIDDEN_REMOTE_PAYLOAD_KEYS = new Set([
  "authorization",
  "__proto__",
  "code",
  "constructor",
  "cookie",
  "csrf",
  "csrftoken",
  "headers",
  "leetcode_session",
  "session",
  "token",
  "typed_code",
  "typedcode",
  "prototype"
]);

interface RemotePayloadBudget {
  nodes: number;
}

interface RegionConfig {
  readonly origin: string;
  readonly graphqlEndpoint: string;
}

const REGION_CONFIG: Readonly<Record<Region, RegionConfig>> = Object.freeze({
  global: Object.freeze({
    origin: "https://leetcode.com",
    graphqlEndpoint: "https://leetcode.com/graphql/"
  }),
  cn: Object.freeze({
    origin: "https://leetcode.cn",
    graphqlEndpoint: "https://leetcode.cn/graphql/"
  })
});

export const LEETCODE_WRITE_ENDPOINTS: Readonly<
  Record<
    Region,
    {
      origin: string;
      graphql: string;
      run: string;
      submit: string;
      check: string;
    }
  >
> = Object.freeze({
  global: Object.freeze({
    origin: REGION_CONFIG.global.origin,
    graphql: REGION_CONFIG.global.graphqlEndpoint,
    run: "https://leetcode.com/problems/{titleSlug}/interpret_solution/",
    submit: "https://leetcode.com/problems/{titleSlug}/submit/",
    check: "https://leetcode.com/submissions/detail/{remoteId}/check/"
  }),
  cn: Object.freeze({
    origin: REGION_CONFIG.cn.origin,
    graphql: REGION_CONFIG.cn.graphqlEndpoint,
    run: "https://leetcode.cn/problems/{titleSlug}/interpret_solution/",
    submit: "https://leetcode.cn/problems/{titleSlug}/submit/",
    check: "https://leetcode.cn/submissions/detail/{remoteId}/check/"
  })
});

export const LEETCODE_WRITE_OPERATIONS = Object.freeze({
  run: "POST interpret_solution then GET check",
  submit: "POST submit then GET check"
});

const QUESTION_ID_QUERY = `
query questionId($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId
    sampleTestCase
  }
}`;

export type LeetCodeWriteFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface OperationStoreFactoryContext {
  readonly profileId: string;
  readonly region: Region;
  readonly namespace: string;
  readonly filePath: string;
}

export type OperationStoreFactory = (
  context: OperationStoreFactoryContext
) => OperationStore<StoredOperation>;

export interface LeetCodeWriteAdapterOptions {
  fetch?: LeetCodeWriteFetch;
  credentialProvider?: CredentialProvider;
  storageDirectory?: string;
  operationStoreFactory?: OperationStoreFactory;
  rateLimiter?: RateLimiter;
  transportPolicy?: TransportPolicy;
  lockStore?: LockStore;
  clock?: Clock;
  idGenerator?: IdGenerator;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  lockTtlMs?: number;
  lockWaitTimeoutMs?: number;
}

export interface LeetCodeWriteAdapter {
  readonly region: Region;
  runCode(input: RunCodeInput, signal?: AbortSignal): Promise<OperationStatus>;
  submitCode(input: SubmitCodeInput, signal?: AbortSignal): Promise<OperationStatus>;
  getOperationStatus(
    operationId: string,
    signal?: AbortSignal
  ): Promise<OperationStatus>;
  close(): Promise<void>;
}

export interface LeetCodeWriteAdapters {
  readonly global: LeetCodeWriteAdapter;
  readonly cn: LeetCodeWriteAdapter;
  forRegion(region: Region): LeetCodeWriteAdapter;
}

interface NormalizedOperationInput {
  region: Region;
  titleSlug: string;
  language: CanonicalLanguage;
  remoteLanguage: string;
  code: string;
  testcase?: string;
  retryUnknownOperationId?: string;
  resubmitCompletedOperationId?: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

interface StoreContext {
  readonly profileId: string;
  readonly namespace: string;
  readonly store: OperationStore<StoredOperation>;
}

interface PollResult {
  readonly pending: boolean;
  readonly result?: JudgeResult;
  readonly check?: UnknownRecord;
}

interface UpstreamExecutionEnvelope {
  readonly questionId: string;
  readonly start: UnknownRecord;
  readonly checkUrl: string;
  readonly check?: UnknownRecord;
}

interface ExecutionOutcome {
  readonly operation: StoredOperation;
  readonly upstream?: UpstreamExecutionEnvelope;
  readonly transientResult?: JudgeResult;
}

interface DispatchResult {
  readonly remoteId: string;
  readonly start: UnknownRecord;
}

interface QuestionExecutionContext {
  readonly questionId: string;
  readonly defaultTestcase?: string;
}

function validationError(message: string): LeetCodeToolError {
  return new LeetCodeToolError("VALIDATION_ERROR", message);
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function defaultStorageDirectory(): string {
  const codingAgentDirectory = process.env.PI_CODING_AGENT_DIR?.trim();
  if (codingAgentDirectory === undefined || codingAgentDirectory.length === 0) {
    throw new LeetCodeToolError(
      "CAPABILITY_UNAVAILABLE",
      "PI_CODING_AGENT_DIR is required for durable LeetCode operation state"
    );
  }
  return join(codingAgentDirectory, "leetcode-tools");
}

function positiveIntegerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw validationError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function normalizeInput(
  region: Region,
  input: RunCodeInput | SubmitCodeInput
): NormalizedOperationInput {
  if (input.region !== region) {
    throw validationError(`Input region ${input.region} does not match ${region} adapter`);
  }
  if (
    input.titleSlug.length > 128 ||
    !TITLE_SLUG.test(input.titleSlug)
  ) {
    throw validationError("titleSlug must be a valid LeetCode problem slug");
  }
  const language = remoteLanguageToCanonical(region, input.language);
  const remoteLanguage =
    language === undefined ? undefined : canonicalLanguageToRemote(region, language);
  if (language === undefined || remoteLanguage === undefined) {
    throw validationError("language is not a supported LeetCode language identifier");
  }

  const codeBytes = utf8Bytes(input.code).byteLength;
  if (input.code.length === 0 || codeBytes > MAX_CODE_BYTES) {
    throw validationError("code must contain between 1 and 400000 UTF-8 bytes");
  }

  const testcase = "testcase" in input ? input.testcase : undefined;
  if (testcase !== undefined && utf8Bytes(testcase).byteLength > MAX_TESTCASE_BYTES) {
    throw validationError(
      `testcase must not exceed ${MAX_TESTCASE_BYTES} UTF-8 bytes`
    );
  }
  const retryUnknownOperationId =
    "retryUnknownOperationId" in input ? input.retryUnknownOperationId : undefined;
  const resubmitCompletedOperationId =
    "resubmitCompletedOperationId" in input
      ? input.resubmitCompletedOperationId
      : undefined;
  if (
    retryUnknownOperationId !== undefined &&
    !OPERATION_ID.test(retryUnknownOperationId)
  ) {
    throw validationError("retryUnknownOperationId is invalid");
  }
  if (
    resubmitCompletedOperationId !== undefined &&
    !OPERATION_ID.test(resubmitCompletedOperationId)
  ) {
    throw validationError("resubmitCompletedOperationId is invalid");
  }
  if (
    retryUnknownOperationId !== undefined &&
    resubmitCompletedOperationId !== undefined
  ) {
    throw validationError(
      "retryUnknownOperationId and resubmitCompletedOperationId are mutually exclusive"
    );
  }

  return {
    region,
    titleSlug: input.titleSlug,
    language,
    remoteLanguage,
    code: input.code,
    ...(testcase === undefined ? {} : { testcase }),
    ...(retryUnknownOperationId !== undefined
      ? { retryUnknownOperationId }
      : {}),
    ...(resubmitCompletedOperationId !== undefined
      ? { resubmitCompletedOperationId }
      : {}),
    timeoutMs: positiveIntegerInRange(
      input.timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      "timeoutMs",
      1,
      120_000
    ),
    pollIntervalMs: positiveIntegerInRange(
      input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
      1,
      5_000
    )
  };
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

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseRecord(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected response shape",
      { details: { field } }
    );
  }
  return value;
}

function assertSafeUpstreamPayload(
  value: unknown,
  field: string,
  depth = 0,
  budget: RemotePayloadBudget = { nodes: 0 }
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_REMOTE_PAYLOAD_NODES) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an operation response with too many values",
      { details: { field } }
    );
  }
  if (depth > MAX_REMOTE_PAYLOAD_DEPTH) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an excessively nested operation response",
      { details: { field } }
    );
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_REMOTE_ARRAY_ITEMS) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an oversized operation response array",
        { details: { field } }
      );
    }
    for (let index = 0; index < value.length; index += 1) {
      assertSafeUpstreamPayload(
        value[index],
        `${field}[${index}]`,
        depth + 1,
        budget
      );
    }
    return;
  }
  if (typeof value === "string") {
    if (utf8Bytes(value).byteLength > MAX_REMOTE_STRING_BYTES) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an oversized operation response string",
        { details: { field } }
      );
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_REMOTE_OBJECT_PROPERTIES) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an operation response with too many fields",
      { details: { field } }
    );
  }
  for (const [key, item] of entries) {
    if (
      key.length === 0 ||
      key.length > MAX_REMOTE_KEY_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(key)
    ) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an invalid operation response key",
        { details: { field } }
      );
    }
    if (FORBIDDEN_REMOTE_PAYLOAD_KEYS.has(key.toLowerCase())) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned a forbidden sensitive operation field",
        { details: { field: `${field}.${key}` } }
      );
    }
    assertSafeUpstreamPayload(item, `${field}.${key}`, depth + 1, budget);
  }
}

function assertTransientEnvelopeSize(
  start: UnknownRecord,
  check?: UnknownRecord
): void {
  const serialized = JSON.stringify(
    check === undefined ? { start } : { start, check }
  );
  if (utf8Bytes(serialized).byteLength > MAX_TRANSIENT_ENVELOPE_BYTES) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an operation envelope that exceeds the RPC safety limit"
    );
  }
}

function boundedRemoteString(
  value: unknown,
  maximum: number,
  field: string
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > maximum) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an oversized control field",
      { details: { field } }
    );
  }
  return trimmed;
}

function boundedRemoteText(
  value: unknown,
  maximum: number,
  field: string
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    if (value.length > maximum) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an oversized judge output field",
        { details: { field } }
      );
    }
    return value;
  }
  if (!Array.isArray(value)) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an invalid judge output field",
      { details: { field } }
    );
  }
  if (value.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  let combinedLength = 0;
  for (const item of value) {
    if (typeof item !== "string") {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an invalid judge output field",
        { details: { field } }
      );
    }
    combinedLength += item.length + (parts.length === 0 ? 0 : 1);
    if (combinedLength > maximum) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode returned an oversized judge output field",
        { details: { field } }
      );
    }
    parts.push(item);
  }
  return parts.join("\n");
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), 24 * 60 * 60 * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.min(Math.max(0, date - Date.now()), 24 * 60 * 60 * 1_000);
}

function operationResult(payload: UnknownRecord): PollResult {
  assertSafeUpstreamPayload(payload, "check");
  const state =
    boundedRemoteString(payload.state, 64, "state") ??
    boundedRemoteString(payload.status, 64, "status") ??
    boundedRemoteString(payload.status_state, 64, "status_state");
  const verdict =
    boundedRemoteString(payload.status_msg, 128, "status_msg") ??
    boundedRemoteString(payload.verdict, 128, "verdict");
  if (state === undefined) {
    throw new LeetCodeToolError(
      "REMOTE_SCHEMA_CHANGED",
      "LeetCode returned an unexpected judge status"
    );
  }

  const marker = `${state ?? ""} ${verdict ?? ""}`.toLowerCase();
  if (
    marker.includes("pending") ||
    marker.includes("judging") ||
    marker.includes("queued") ||
    marker.includes("started")
  ) {
    return { pending: true };
  }

  const result: JudgeResult = {
    state,
    ...(verdict === undefined ? {} : { verdict })
  };
  const statusMessage =
    boundedRemoteString(payload.status_message, 1_024, "status_message") ??
    boundedRemoteString(payload.statusMessage, 1_024, "statusMessage");
  const runtime =
    boundedRemoteString(payload.status_runtime, 128, "status_runtime") ??
    boundedRemoteString(payload.runtime, 128, "runtime");
  const memory =
    boundedRemoteString(payload.status_memory, 128, "status_memory") ??
    boundedRemoteString(payload.memory, 128, "memory");
  if (statusMessage !== undefined) {
    result.statusMessage = statusMessage;
  }
  if (runtime !== undefined) {
    result.runtime = runtime;
  }
  if (memory !== undefined) {
    result.memory = memory;
  }
  const normalizedStdOutput = boundedRemoteText(
    payload.std_output,
    200_000,
    "std_output"
  );
  const normalizedStdout = boundedRemoteText(
    payload.stdout,
    200_000,
    "stdout"
  );
  const normalizedCodeOutput = boundedRemoteText(
    payload.code_output,
    200_000,
    "code_output"
  );
  const normalizedStdOutputList = boundedRemoteText(
    payload.std_output_list,
    200_000,
    "std_output_list"
  );
  const normalizedCodeAnswer = boundedRemoteText(
    payload.code_answer,
    200_000,
    "code_answer"
  );
  const stdout =
    normalizedStdOutput ??
    normalizedStdout ??
    normalizedCodeOutput ??
    normalizedStdOutputList ??
    normalizedCodeAnswer;
  const normalizedExpectedOutput = boundedRemoteText(
    payload.expected_output,
    200_000,
    "expected_output"
  );
  const normalizedExpectedCodeOutput = boundedRemoteText(
    payload.expected_code_output,
    200_000,
    "expected_code_output"
  );
  const normalizedExpectedStdOutputList = boundedRemoteText(
    payload.expected_std_output_list,
    200_000,
    "expected_std_output_list"
  );
  const normalizedExpectedCodeAnswer = boundedRemoteText(
    payload.expected_code_answer,
    200_000,
    "expected_code_answer"
  );
  const expectedOutput =
    normalizedExpectedOutput ??
    normalizedExpectedCodeOutput ??
    normalizedExpectedStdOutputList ??
    normalizedExpectedCodeAnswer;
  const compileError =
    boundedRemoteText(payload.full_compile_error, 200_000, "full_compile_error") ??
    boundedRemoteText(payload.compile_error, 200_000, "compile_error");
  const runtimeError = boundedRemoteText(
    payload.runtime_error,
    200_000,
    "runtime_error"
  );
  const input =
    boundedRemoteText(payload.last_testcase, 200_000, "last_testcase") ??
    boundedRemoteText(payload.input, 200_000, "input");
  if (stdout !== undefined) {
    result.stdout = stdout;
  }
  if (expectedOutput !== undefined) {
    result.expectedOutput = expectedOutput;
  }
  if (compileError !== undefined) {
    result.compileError = compileError;
  }
  if (runtimeError !== undefined) {
    result.runtimeError = runtimeError;
  }
  if (input !== undefined) {
    result.input = input;
  }
  return { pending: false, result, check: payload };
}

function minimalJudgeResult(result: JudgeResult): JudgeResult {
  return {
    state: result.state,
    ...(result.verdict === undefined ? {} : { verdict: result.verdict }),
    ...(result.statusMessage === undefined
      ? {}
      : { statusMessage: result.statusMessage }),
    ...(result.runtime === undefined ? {} : { runtime: result.runtime }),
    ...(result.memory === undefined ? {} : { memory: result.memory })
  };
}

function isMinimalJudgeResult(value: unknown): value is JudgeResult {
  if (!isRecord(value) || typeof value.state !== "string") {
    return false;
  }
  const allowed = new Set(["state", "verdict", "statusMessage", "runtime", "memory"]);
  return Object.entries(value).every(
    ([key, item]) => allowed.has(key) && typeof item === "string"
  );
}

function isStoredOperation(value: unknown): value is StoredOperation {
  if (!isRecord(value)) {
    return false;
  }
  return (
    !("questionId" in value) &&
    !("start" in value) &&
    !("checkUrl" in value) &&
    !("check" in value) &&
    typeof value.operationId === "string" &&
    OPERATION_ID.test(value.operationId) &&
    (value.kind === "run" || value.kind === "submit") &&
    typeof value.state === "string" &&
    STORED_STATES.has(value.state as LedgerOperationState) &&
    (value.region === "global" || value.region === "cn") &&
    typeof value.titleSlug === "string" &&
    TITLE_SLUG.test(value.titleSlug) &&
    typeof value.language === "string" &&
    typeof value.codeHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.codeHash) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (value.remoteId === undefined ||
      (typeof value.remoteId === "string" && REMOTE_ID.test(value.remoteId))) &&
    (value.supersedesOperationId === undefined ||
      (typeof value.supersedesOperationId === "string" &&
        OPERATION_ID.test(value.supersedesOperationId))) &&
    (value.repeatsOperationId === undefined ||
      (typeof value.repeatsOperationId === "string" &&
        OPERATION_ID.test(value.repeatsOperationId))) &&
    (value.result === undefined || isMinimalJudgeResult(value.result)) &&
    (value.errorCode === undefined || typeof value.errorCode === "string")
  );
}

function publicOperationState(state: LedgerOperationState): OperationStatus["state"] {
  switch (state) {
    case "prepared":
    case "confirmed":
    case "dispatch_intent":
    case "dispatched":
      return "queued";
    case "polling":
    case "completed":
    case "unknown":
    case "failed":
    case "cancelled":
      return state;
  }
}

function toPublicOperation(
  operation: StoredOperation,
  upstream?: UpstreamExecutionEnvelope,
  transientResult?: JudgeResult
): OperationStatus {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    state: publicOperationState(operation.state),
    region: operation.region,
    titleSlug: operation.titleSlug,
    language: operation.language,
    codeHash: operation.codeHash,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.remoteId === undefined ? {} : { remoteId: operation.remoteId }),
    ...(upstream === undefined
      ? {}
      : {
          questionId: upstream.questionId,
          start: { ...upstream.start },
          checkUrl: upstream.checkUrl,
          ...(upstream.check === undefined ? {} : { check: { ...upstream.check } })
        }),
    ...(operation.supersedesOperationId === undefined
      ? {}
      : { supersedesOperationId: operation.supersedesOperationId }),
    ...(operation.repeatsOperationId === undefined
      ? {}
      : { repeatsOperationId: operation.repeatsOperationId }),
    ...(transientResult === undefined && operation.result === undefined
      ? {}
      : { result: { ...(transientResult ?? operation.result!) } }),
    ...(operation.errorCode === undefined ? {} : { errorCode: operation.errorCode })
  };
}

function mapError(error: unknown): LeetCodeToolError {
  if (error instanceof LeetCodeToolError) {
    return error;
  }
  if (error instanceof LeaseLostError) {
    return new LeetCodeToolError(
      "STALE_OPERATION",
      "The submission lease was lost before dispatch",
      { retryable: true }
    );
  }
  if (error instanceof LeaseUnavailableError) {
    return new LeetCodeToolError(
      "STALE_OPERATION",
      "Another submission operation is already in progress",
      { retryable: true, details: { state: "pending" } }
    );
  }
  if (error instanceof RateLimitQueueFullError) {
    return new LeetCodeToolError(
      "RATE_LIMITED",
      "The local LeetCode rate limit queue is full",
      { retryable: true }
    );
  }
  if (error instanceof RateLimiterClosedError) {
    return new LeetCodeToolError("CANCELLED", "The LeetCode runtime is closed");
  }
  if (error instanceof OperationStoreCapacityError) {
    return new LeetCodeToolError(
      "CAPABILITY_UNAVAILABLE",
      "The durable operation ledger is full of operations that still require recovery"
    );
  }
  if (
    error instanceof OperationStoreCorruptError ||
    error instanceof OperationStoreUnsupportedVersionError
  ) {
    return new LeetCodeToolError(
      "CAPABILITY_UNAVAILABLE",
      "The durable operation ledger cannot be safely opened"
    );
  }
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new LeetCodeToolError("CANCELLED", "LeetCode operation was cancelled");
  }
  return new LeetCodeToolError(
    "REMOTE_UNAVAILABLE",
    "LeetCode request failed",
    { retryable: true }
  );
}

function duplicateError(operation: StoredOperation): LeetCodeToolError {
  switch (operation.state) {
    case "unknown":
      return new LeetCodeToolError(
        "STALE_OPERATION",
        "An identical submission has an unknown outcome and requires an explicit retry reference",
        {
          operationId: operation.operationId,
          details: { state: "unknown", requiresExplicitRetry: true }
        }
      );
    case "completed":
      return new LeetCodeToolError(
        "STALE_OPERATION",
        "An identical submission is already recorded",
        { operationId: operation.operationId }
      );
    default:
      return new LeetCodeToolError(
        "STALE_OPERATION",
        "An identical submission is already pending",
        {
          operationId: operation.operationId,
          retryable: true,
          details: { state: operation.state }
        }
      );
  }
}

const OPERATION_TRANSITIONS: Readonly<
  Record<LedgerOperationState, ReadonlySet<LedgerOperationState>>
> = {
  prepared: new Set(["confirmed", "cancelled", "failed"]),
  confirmed: new Set(["dispatch_intent", "cancelled", "failed"]),
  dispatch_intent: new Set(["dispatched", "unknown", "failed"]),
  dispatched: new Set(["polling", "completed", "unknown", "failed"]),
  polling: new Set(["polling", "completed", "unknown", "failed"]),
  completed: new Set(["completed"]),
  unknown: new Set(["unknown", "polling", "completed", "failed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled", "unknown"])
};

function canTransition(current: StoredOperation, next: LedgerOperationState): boolean {
  if (current.state === "cancelled" && next === "unknown") {
    return current.remoteId !== undefined;
  }
  return OPERATION_TRANSITIONS[current.state].has(next);
}

function isTerminalStoredOperation(operation: StoredOperation): boolean {
  return (
    operation.state === "completed" ||
    operation.state === "failed" ||
    (operation.state === "cancelled" && operation.remoteId === undefined)
  );
}

class HttpWriteAdapter implements LeetCodeWriteAdapter {
  readonly region: Region;

  readonly #config: RegionConfig;
  readonly #fetchImpl: LeetCodeWriteFetch;
  readonly #credentialProvider: CredentialProvider | undefined;
  readonly #storageDirectory: string;
  readonly #operationStoreFactory: OperationStoreFactory;
  readonly #transportPolicy: TransportPolicy;
  readonly #lockStore: LockStore;
  readonly #clock: Clock;
  readonly #idGenerator: IdGenerator;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #lockTtlMs: number;
  readonly #lockWaitTimeoutMs: number;
  readonly #ownerId: string;
  readonly #stores = new Map<string, OperationStore<StoredOperation>>();
  readonly #lifecycle = new AbortController();
  readonly #ownsTransportPolicy: boolean;
  readonly #ownsLockStore: boolean;
  #closed = false;

  constructor(region: Region, options: LeetCodeWriteAdapterOptions) {
    this.region = region;
    this.#config = REGION_CONFIG[region];
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new LeetCodeToolError(
        "CAPABILITY_UNAVAILABLE",
        "A Fetch API implementation is required"
      );
    }
    this.#fetchImpl = fetchImpl.bind(globalThis);
    this.#credentialProvider = options.credentialProvider;
    this.#storageDirectory = options.storageDirectory ?? defaultStorageDirectory();
    if (this.#storageDirectory.trim().length === 0) {
      throw validationError("storageDirectory must not be empty");
    }
    this.#clock = options.clock ?? systemClock;
    this.#idGenerator = options.idGenerator ?? randomIdGenerator;
    this.#requestTimeoutMs = positiveIntegerInRange(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
      100,
      120_000
    );
    this.#maxResponseBytes = positiveIntegerInRange(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      1_024,
      10 * 1024 * 1024
    );
    this.#lockTtlMs = positiveIntegerInRange(
      options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
      "lockTtlMs",
      1_000,
      10 * 60_000
    );
    this.#lockWaitTimeoutMs = positiveIntegerInRange(
      options.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS,
      "lockWaitTimeoutMs",
      1,
      120_000
    );
    this.#ownerId = this.#idGenerator.generate("writer").slice(0, 128);

    this.#ownsTransportPolicy = options.transportPolicy === undefined;
    this.#transportPolicy =
      options.transportPolicy ??
      createDefaultTransportPolicy({
        clock: this.#clock,
        ...(options.rateLimiter === undefined
          ? {}
          : { rateLimiter: options.rateLimiter })
      });
    this.#ownsLockStore = options.lockStore === undefined;
    this.#lockStore =
      options.lockStore ??
      new FileLeaseLock({
        directory: join(this.#storageDirectory, "locks"),
        defaultTtlMs: this.#lockTtlMs,
        clock: this.#clock,
        idGenerator: this.#idGenerator
      });
    this.#operationStoreFactory =
      options.operationStoreFactory ??
      ((context) =>
        new AtomicJsonOperationStore<StoredOperation>(context.filePath, {
          validate: isStoredOperation,
          clock: this.#clock,
          retentionPolicy: {
            maxRecords: DEFAULT_OPERATION_MAX_RECORDS,
            terminalRetentionMs: DEFAULT_TERMINAL_RETENTION_MS,
            isTerminal: isTerminalStoredOperation,
            updatedAt: (operation) => operation.updatedAt
          },
          forbiddenKeys: [
            "start",
            "check",
            "checkUrl",
            "questionId",
            "stdout",
            "expectedOutput",
            "input",
            "hiddenTests",
            "testcases",
            "lastTestcase"
          ]
        }));
  }

  async runCode(input: RunCodeInput, signal?: AbortSignal): Promise<OperationStatus> {
    const outcome = await this.#execute(
      "run",
      normalizeInput(this.region, input),
      signal
    );
    return toPublicOperation(
      outcome.operation,
      outcome.upstream,
      outcome.transientResult
    );
  }

  async submitCode(input: SubmitCodeInput, signal?: AbortSignal): Promise<OperationStatus> {
    const outcome = await this.#execute(
      "submit",
      normalizeInput(this.region, input),
      signal
    );
    return toPublicOperation(
      outcome.operation,
      outcome.upstream,
      outcome.transientResult
    );
  }

  async getOperationStatus(
    operationId: string,
    signal?: AbortSignal
  ): Promise<OperationStatus> {
    return toPublicOperation(await this.#getStoredOperationStatus(operationId, signal));
  }

  async #getStoredOperationStatus(
    operationId: string,
    signal?: AbortSignal
  ): Promise<StoredOperation> {
    this.#assertOpen();
    if (!OPERATION_ID.test(operationId)) {
      throw validationError("operationId is invalid");
    }

    const credentials = await this.#credentials();
    const context = this.#storeContext(credentials.profileId);
    const operation = await this.#get(context, operationId);
    if (operation === undefined) {
      throw new LeetCodeToolError(
        "NOT_FOUND",
        "LeetCode operation was not found"
      );
    }
    if (
      operation.remoteId === undefined ||
      (operation.state !== "dispatched" &&
        operation.state !== "polling" &&
        operation.state !== "unknown" &&
        operation.state !== "cancelled")
    ) {
      return operation;
    }

    const combined = this.#combinedSignal(signal);
    if (combined.aborted) {
      return this.#setState(context, operationId, "unknown");
    }

    try {
      const status = await this.#requestJson(
        credentials,
        this.#statusEndpoint(operation.remoteId),
        "GET",
        undefined,
        combined,
        this.#requestTimeoutMs,
        `${this.#config.origin}/problems/${operation.titleSlug}/`,
        "operationStatus",
        "never",
        true,
        operationResult
      );
      if (status.pending) {
        return this.#setState(context, operationId, "polling");
      }
      return this.#complete(context, operationId, status.result!);
    } catch {
      return this.#setState(context, operationId, "unknown");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#lifecycle.abort(new DOMException("Runtime closed", "AbortError"));
    if (this.#ownsTransportPolicy) {
      this.#transportPolicy.close();
    }
    if (this.#ownsLockStore) {
      await this.#lockStore.close();
    }
  }

  async #execute(
    kind: OperationKind,
    input: NormalizedOperationInput,
    signal?: AbortSignal
  ): Promise<ExecutionOutcome> {
    this.#assertOpen();
    const credentials = await this.#credentials();
    const context = this.#storeContext(credentials.profileId);
    const codeHash = sha256Hex(utf8Bytes(input.code));
    const createdAt = this.#clock.now().toISOString();
    const prepared: StoredOperation = {
      operationId: this.#idGenerator.generate(`operation-${this.region}`),
      kind,
      state: "prepared",
      region: this.region,
      titleSlug: input.titleSlug,
      language: input.language,
      codeHash,
      createdAt,
      updatedAt: createdAt
    };
    if (!OPERATION_ID.test(prepared.operationId)) {
      throw new LeetCodeToolError(
        "CAPABILITY_UNAVAILABLE",
        "The operation id generator returned an invalid id"
      );
    }

    const combined = this.#combinedSignal(signal);
    if (combined.aborted) {
      await this.#save(context, {
        ...prepared,
        state: "cancelled",
        errorCode: "CANCELLED"
      });
      return { operation: (await this.#get(context, prepared.operationId))! };
    }
    const deadline = this.#clock.now().getTime() + input.timeoutMs;
    let prefetchedQuestion: QuestionExecutionContext | undefined;
    if (kind === "run" && input.testcase === undefined) {
      prefetchedQuestion = await this.#resolveQuestion(
        credentials,
        input.titleSlug,
        combined,
        deadline
      );
      if (prefetchedQuestion.defaultTestcase === undefined) {
        throw validationError(
          "testcase is required because this problem has no defaultTestcase"
        );
      }
      if (
        utf8Bytes(prefetchedQuestion.defaultTestcase).byteLength >
        MAX_TESTCASE_BYTES
      ) {
        throw validationError(
          `testcase must not exceed ${MAX_TESTCASE_BYTES} UTF-8 bytes`
        );
      }
      input = { ...input, testcase: prefetchedQuestion.defaultTestcase };
    }

    let submitLease:
      | Awaited<ReturnType<LockStore["acquire"]>>
      | undefined;
    if (kind === "submit") {
      try {
        submitLease = await this.#lockStore.acquire(
          `submit\u0000${credentials.profileId}\u0000${this.region}\u0000${input.titleSlug}`,
          {
            ownerId: this.#ownerId,
            ttlMs: this.#lockTtlMs,
            waitTimeoutMs: this.#lockWaitTimeoutMs,
            signal: combined
          }
        );
      } catch (error) {
        const mapped = mapError(error);
        if (mapped.code === "CANCELLED") {
          await this.#save(context, {
            ...prepared,
            state: "cancelled",
            errorCode: "CANCELLED"
          });
          return { operation: (await this.#get(context, prepared.operationId))! };
        }
        throw mapped;
      }

      const operations = await this.#list(context);
      let selectedTarget: StoredOperation | undefined;
      if (input.retryUnknownOperationId !== undefined) {
        selectedTarget = operations.find(
          (operation) => operation.operationId === input.retryUnknownOperationId
        );
        if (
          selectedTarget === undefined ||
          selectedTarget.kind !== "submit" ||
          (selectedTarget.state !== "dispatched" && selectedTarget.state !== "unknown") ||
          selectedTarget.titleSlug !== input.titleSlug ||
          selectedTarget.language !== input.language ||
          selectedTarget.codeHash !== codeHash ||
          operations.some(
            (operation) => operation.supersedesOperationId === selectedTarget?.operationId
          )
        ) {
          await submitLease.release();
          submitLease = undefined;
          throw new LeetCodeToolError(
            "STALE_OPERATION",
            "retryUnknownOperationId does not reference the matching unknown submission",
            { operationId: input.retryUnknownOperationId }
          );
        }
        prepared.supersedesOperationId = selectedTarget.operationId;
      } else if (input.resubmitCompletedOperationId !== undefined) {
        selectedTarget = operations.find(
          (operation) => operation.operationId === input.resubmitCompletedOperationId
        );
        if (
          selectedTarget === undefined ||
          selectedTarget.kind !== "submit" ||
          selectedTarget.state !== "completed" ||
          selectedTarget.titleSlug !== input.titleSlug ||
          selectedTarget.language !== input.language ||
          selectedTarget.codeHash !== codeHash ||
          operations.some(
            (operation) => operation.repeatsOperationId === selectedTarget?.operationId
          )
        ) {
          await submitLease.release();
          submitLease = undefined;
          throw new LeetCodeToolError(
            "STALE_OPERATION",
            "resubmitCompletedOperationId does not reference the matching completed submission",
            { operationId: input.resubmitCompletedOperationId }
          );
        }
        prepared.repeatsOperationId = selectedTarget.operationId;
      }

      const duplicates = operations.filter(
        (operation) =>
          operation.kind === "submit" &&
          operation.titleSlug === input.titleSlug &&
          operation.language === input.language &&
          operation.codeHash === codeHash &&
          operation.operationId !== selectedTarget?.operationId &&
          (BLOCKING_SUBMIT_STATES.has(operation.state) ||
            (operation.state === "cancelled" && operation.remoteId !== undefined))
      );
      const blockingDuplicate = duplicates.find(
        (operation) => operation.state !== "completed"
      );
      if (blockingDuplicate !== undefined) {
        await submitLease.release();
        submitLease = undefined;
        throw duplicateError(blockingDuplicate);
      }
      const completedDuplicate = duplicates.find(
        (operation) => operation.state === "completed"
      );
      if (completedDuplicate !== undefined) {
        await submitLease.release();
        submitLease = undefined;
        return { operation: completedDuplicate };
      }
    }

    await this.#save(context, prepared);
    let dispatchStarted = false;
    let remoteAcknowledged = false;
    let polling: StoredOperation | undefined;
    let earlyResult: StoredOperation | undefined;
    let upstream: UpstreamExecutionEnvelope | undefined;

    try {
      await this.#setState(context, prepared.operationId, "confirmed");
      const question =
        prefetchedQuestion ??
        (await this.#resolveQuestion(
          credentials,
          input.titleSlug,
          combined,
          deadline
        ));
      const runTestcase =
        kind === "run" ? (input.testcase ?? question.defaultTestcase) : undefined;
      if (kind === "run" && runTestcase === undefined) {
        throw validationError(
          "testcase is required because this problem has no defaultTestcase"
        );
      }
      if (
        runTestcase !== undefined &&
        utf8Bytes(runTestcase).byteLength > MAX_TESTCASE_BYTES
      ) {
        throw validationError(
          `testcase must not exceed ${MAX_TESTCASE_BYTES} UTF-8 bytes`
        );
      }
      if (combined.aborted) {
        throw new LeetCodeToolError("CANCELLED", "LeetCode operation was cancelled");
      }
      if (this.#remaining(deadline) <= 0) {
        throw new LeetCodeToolError(
          "REMOTE_UNAVAILABLE",
          "LeetCode operation timed out before dispatch",
          { retryable: true, details: { timedOut: true } }
        );
      }

      if (submitLease !== undefined) {
        await submitLease.assertOwned();
      }

      await this.#setState(context, prepared.operationId, "dispatch_intent");
      if (submitLease !== undefined) {
        await submitLease.assertOwned();
      }
      dispatchStarted = true;
      const dispatch = await this.#requestJson(
        credentials,
        this.#dispatchEndpoint(kind, input.titleSlug),
        "POST",
        kind === "run"
          ? {
              lang: input.remoteLanguage,
              question_id: question.questionId,
              typed_code: input.code,
              data_input: runTestcase
            }
          : {
              lang: input.remoteLanguage,
              question_id: question.questionId,
              typed_code: input.code
            },
        combined,
        Math.min(this.#requestTimeoutMs, this.#remaining(deadline)),
        `${this.#config.origin}/problems/${input.titleSlug}/`,
        kind === "run" ? "runDispatch" : "submitDispatch",
        "never",
        false,
        (payload): DispatchResult => {
          assertSafeUpstreamPayload(payload, "start");
          return {
            remoteId: this.#remoteId(payload, kind),
            start: payload
          };
        },
        true
      );
      remoteAcknowledged = true;
      upstream = {
        questionId: question.questionId,
        start: dispatch.start,
        checkUrl: this.#statusEndpoint(dispatch.remoteId)
      };
      assertTransientEnvelopeSize(dispatch.start);
      await this.#setDispatched(context, prepared.operationId, dispatch.remoteId);
      polling = await this.#setState(context, prepared.operationId, "polling");
    } catch (error) {
      const mapped = mapError(error);
      const status = mapped.details?.status;
      const uncertainDispatch =
        dispatchStarted &&
        (remoteAcknowledged ||
          mapped.code === "CANCELLED" ||
          mapped.details?.transportUncertain === true ||
          (mapped.code === "REMOTE_UNAVAILABLE" &&
            typeof status === "number" &&
            status >= 500) ||
          (mapped.code === "REMOTE_SCHEMA_CHANGED" && status === undefined));
      if (uncertainDispatch) {
        earlyResult = await this.#setState(
          context,
          prepared.operationId,
          "unknown"
        );
      } else if (mapped.code === "CANCELLED") {
        earlyResult = await this.#setState(
          context,
          prepared.operationId,
          "cancelled",
          "CANCELLED"
        );
      } else {
        earlyResult = await this.#setState(
          context,
          prepared.operationId,
          "failed",
          mapped.code
        );
      }
    } finally {
      await submitLease?.release();
    }

    if (earlyResult !== undefined) {
      return {
        operation: earlyResult,
        ...(upstream === undefined ? {} : { upstream })
      };
    }
    return this.#poll(
      credentials,
      context,
      polling!,
      input,
      combined,
      deadline,
      upstream!
    );
  }

  async #poll(
    credentials: CredentialBundle,
    context: StoreContext,
    operation: StoredOperation,
    input: NormalizedOperationInput,
    signal: AbortSignal,
    deadline: number,
    upstream: UpstreamExecutionEnvelope
  ): Promise<ExecutionOutcome> {
    let intervalMs = Math.max(
      MINIMUM_EFFECTIVE_POLL_INTERVAL_MS,
      input.pollIntervalMs
    );
    while (true) {
      if (signal.aborted) {
        return {
          operation: await this.#setState(
            context,
            operation.operationId,
            "unknown"
          ),
          upstream
        };
      }
      const remaining = this.#remaining(deadline);
      if (remaining <= 0) {
        return {
          operation: await this.#setState(
            context,
            operation.operationId,
            "unknown"
          ),
          upstream
        };
      }

      try {
        const status = await this.#requestJson(
          credentials,
          this.#statusEndpoint(operation.remoteId!),
          "GET",
          undefined,
          signal,
          Math.min(this.#requestTimeoutMs, remaining),
          `${this.#config.origin}/problems/${operation.titleSlug}/`,
          "operationStatus",
          "never",
          true,
          operationResult
        );
        if (!status.pending) {
          assertTransientEnvelopeSize(upstream.start, status.check!);
          const completed = await this.#complete(
            context,
            operation.operationId,
            status.result!
          );
          return {
            operation: completed,
            upstream: {
              ...upstream,
              check: status.check!
            },
            transientResult: status.result!
          };
        }
        operation = await this.#setState(context, operation.operationId, "polling");
      } catch (error) {
        const mapped = mapError(error);
        if (mapped.code === "REMOTE_SCHEMA_CHANGED") {
          return {
            operation: await this.#setState(
              context,
              operation.operationId,
              "failed",
              mapped.code
            ),
            upstream
          };
        }
        if (mapped.code === "RATE_LIMITED") {
          intervalMs =
            mapped.retryAfterMs === undefined
              ? Math.min(intervalMs * 2, MAXIMUM_RATE_LIMIT_BACKOFF_MS)
              : Math.max(
                  MINIMUM_EFFECTIVE_POLL_INTERVAL_MS,
                  Math.min(mapped.retryAfterMs, MAXIMUM_RATE_LIMIT_BACKOFF_MS)
                );
          try {
            await this.#clock.sleep(
              Math.min(intervalMs, Math.max(0, this.#remaining(deadline))),
              signal
            );
            continue;
          } catch {
            return {
              operation: await this.#setState(
                context,
                operation.operationId,
                "unknown"
              ),
              upstream
            };
          }
        }
        return {
          operation: await this.#setState(
            context,
            operation.operationId,
            "unknown"
          ),
          upstream
        };
      }

      try {
        await this.#clock.sleep(
          Math.min(intervalMs, Math.max(0, this.#remaining(deadline))),
          signal
        );
      } catch {
        return {
          operation: await this.#setState(
            context,
            operation.operationId,
            "unknown"
          ),
          upstream
        };
      }
    }
  }

  async #credentials(): Promise<CredentialBundle> {
    if (this.#credentialProvider === undefined) {
      throw authRequired(this.region);
    }
    let credentials: CredentialBundle | undefined;
    try {
      credentials = await this.#credentialProvider.getCredentials(this.region);
    } catch {
      throw authRequired(this.region);
    }
    if (
      credentials === undefined ||
      credentials.region !== this.region ||
      !isSafeProfileId(credentials.profileId) ||
      !isSafeCredentialValue(credentials.session) ||
      !isSafeCredentialValue(credentials.csrfToken)
    ) {
      throw authRequired(this.region);
    }
    return credentials;
  }

  #storeContext(profileId: string): StoreContext {
    const namespace = sha256Hex(utf8Bytes(`${profileId}\u0000${this.region}`));
    let store = this.#stores.get(namespace);
    if (store === undefined) {
      const filePath = join(
        this.#storageDirectory,
        "operations",
        namespace,
        "operations.json"
      );
      store = this.#operationStoreFactory({
        profileId,
        region: this.region,
        namespace,
        filePath
      });
      this.#stores.set(namespace, store);
    }
    return { profileId, namespace, store };
  }

  async #save(context: StoreContext, operation: StoredOperation): Promise<void> {
    try {
      await this.#withLedgerLease(context, () => context.store.save(operation));
    } catch (error) {
      throw mapError(error);
    }
  }

  async #get(
    context: StoreContext,
    operationId: string
  ): Promise<StoredOperation | undefined> {
    try {
      return await this.#withLedgerLease(context, () => context.store.get(operationId));
    } catch (error) {
      throw mapError(error);
    }
  }

  async #list(context: StoreContext): Promise<StoredOperation[]> {
    try {
      return await this.#withLedgerLease(context, () => context.store.list());
    } catch (error) {
      throw mapError(error);
    }
  }

  async #update(
    context: StoreContext,
    operationId: string,
    updater: (operation: StoredOperation) => StoredOperation
  ): Promise<StoredOperation> {
    let updated: StoredOperation | undefined;
    try {
      updated = await this.#withLedgerLease(context, () =>
        context.store.update(operationId, (current) =>
          current === undefined ? undefined : updater(current)
        )
      );
    } catch (error) {
      throw mapError(error);
    }
    if (updated === undefined) {
      throw new LeetCodeToolError(
        "STALE_OPERATION",
        "LeetCode operation ledger entry was lost",
        { operationId }
      );
    }
    return updated;
  }

  async #withLedgerLease<T>(
    context: StoreContext,
    operation: () => Promise<T>
  ): Promise<T> {
    const lease = await this.#lockStore.acquire(
      `ledger\u0000${context.namespace}`,
      {
        ownerId: this.#ownerId,
        ttlMs: this.#lockTtlMs,
        waitTimeoutMs: this.#lockWaitTimeoutMs
      }
    );
    try {
      await lease.assertOwned();
      return await operation();
    } finally {
      await lease.release();
    }
  }

  #setState(
    context: StoreContext,
    operationId: string,
    state: Exclude<LedgerOperationState, "dispatched">,
    errorCode?: ToolErrorCode
  ): Promise<StoredOperation> {
    return this.#update(context, operationId, (current) => {
      if (!canTransition(current, state)) {
        return current;
      }
      const next: StoredOperation = {
        ...current,
        state,
        updatedAt: this.#clock.now().toISOString()
      };
      delete next.result;
      delete next.errorCode;
      if (errorCode !== undefined) {
        next.errorCode = errorCode;
      }
      return next;
    });
  }

  #setDispatched(
    context: StoreContext,
    operationId: string,
    remoteId: string
  ): Promise<StoredOperation> {
    return this.#update(context, operationId, (current) => {
      if (!canTransition(current, "dispatched")) {
        return current;
      }
      const next: StoredOperation = {
        ...current,
        state: "dispatched",
        updatedAt: this.#clock.now().toISOString(),
        remoteId
      };
      delete next.result;
      delete next.errorCode;
      return next;
    });
  }

  #complete(
    context: StoreContext,
    operationId: string,
    result: JudgeResult
  ): Promise<StoredOperation> {
    return this.#update(context, operationId, (current) => {
      if (!canTransition(current, "completed")) {
        return current;
      }
      const next: StoredOperation = {
        ...current,
        state: "completed",
        updatedAt: this.#clock.now().toISOString(),
        result: minimalJudgeResult(result)
      };
      delete next.errorCode;
      return next;
    });
  }

  async #resolveQuestion(
    credentials: CredentialBundle,
    titleSlug: string,
    signal: AbortSignal,
    deadline: number
  ): Promise<QuestionExecutionContext> {
    return this.#requestJson(
      credentials,
      this.#config.graphqlEndpoint,
      "POST",
      {
        operationName: "questionId",
        query: QUESTION_ID_QUERY,
        variables: { titleSlug }
      },
      signal,
      Math.min(this.#requestTimeoutMs, this.#remaining(deadline)),
      `${this.#config.origin}/problems/${titleSlug}/`,
      "questionId",
      "safe-read",
      true,
      (payload) => {
        if (Array.isArray(payload.errors) && payload.errors.length > 0) {
          const authError = payload.errors.some((error) => {
            if (!isRecord(error)) {
              return false;
            }
            const message =
              boundedRemoteString(error.message, 500, "errors[].message")
                ?.toLowerCase() ?? "";
            return message.includes("login") || message.includes("auth");
          });
          throw new LeetCodeToolError(
            authError ? "AUTH_EXPIRED" : "REMOTE_SCHEMA_CHANGED",
            authError
              ? `Authentication expired for LeetCode ${this.region}`
              : "LeetCode rejected the question lookup"
          );
        }
        const data = responseRecord(payload.data, "data");
        if (data.question === null) {
          throw new LeetCodeToolError(
            "NOT_FOUND",
            "LeetCode problem was not found"
          );
        }
        const question = responseRecord(data.question, "data.question");
        const questionId = boundedRemoteString(
          question.questionId,
          64,
          "data.question.questionId"
        );
        if (questionId === undefined || !REMOTE_ID.test(questionId)) {
          throw new LeetCodeToolError(
            "REMOTE_SCHEMA_CHANGED",
            "LeetCode did not return a valid question id"
          );
        }
        const defaultTestcase = question.sampleTestCase;
        if (
          defaultTestcase !== undefined &&
          defaultTestcase !== null &&
          typeof defaultTestcase !== "string"
        ) {
          throw new LeetCodeToolError(
            "REMOTE_SCHEMA_CHANGED",
            "LeetCode returned an invalid default testcase",
            { details: { field: "data.question.sampleTestCase" } }
          );
        }
        return {
          questionId,
          ...(typeof defaultTestcase === "string" ? { defaultTestcase } : {})
        };
      }
    );
  }

  #remoteId(payload: UnknownRecord, kind: OperationKind): string {
    const candidate =
      kind === "run" ? payload.interpret_id : payload.submission_id;
    const remoteId =
      typeof candidate === "number" && Number.isSafeInteger(candidate)
        ? String(candidate)
        : boundedRemoteString(candidate, 128, `${kind}.remoteId`);
    if (remoteId === undefined || !REMOTE_ID.test(remoteId)) {
      throw new LeetCodeToolError(
        "REMOTE_SCHEMA_CHANGED",
        "LeetCode did not acknowledge the operation"
      );
    }
    return remoteId;
  }

  #dispatchEndpoint(kind: OperationKind, titleSlug: string): string {
    const template =
      kind === "run"
        ? LEETCODE_WRITE_ENDPOINTS[this.region].run
        : LEETCODE_WRITE_ENDPOINTS[this.region].submit;
    return template.replace("{titleSlug}", titleSlug);
  }

  #statusEndpoint(remoteId: string): string {
    if (!REMOTE_ID.test(remoteId)) {
      throw new LeetCodeToolError(
        "STALE_OPERATION",
        "Stored LeetCode remote id is invalid"
      );
    }
    return LEETCODE_WRITE_ENDPOINTS[this.region].check.replace(
      "{remoteId}",
      remoteId
    );
  }

  async #requestJson<T>(
    credentials: CredentialBundle,
    endpoint: string,
    method: "GET" | "POST",
    body: UnknownRecord | undefined,
    signal: AbortSignal,
    timeoutMs: number,
    referer: string,
    operation: string,
    retryMode: TransportRetryMode,
    recoveryProbe: boolean,
    decode: (payload: UnknownRecord) => T,
    uncertainOnAbort = false
  ): Promise<T> {
    if (signal.aborted) {
      throw new LeetCodeToolError("CANCELLED", "LeetCode operation was cancelled");
    }
    if (timeoutMs <= 0) {
      throw new LeetCodeToolError(
        "REMOTE_UNAVAILABLE",
        "LeetCode request timed out",
        {
          retryable: true,
          details: { timedOut: true, transportUncertain: true }
        }
      );
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      cookie: `LEETCODE_SESSION=${credentials.session}; csrftoken=${credentials.csrfToken}`,
      origin: this.#config.origin,
      referer,
      "x-csrftoken": credentials.csrfToken,
      "x-requested-with": "XMLHttpRequest"
    };
    const init: RequestInit = {
      method,
      headers,
      redirect: "manual",
      cache: "no-store"
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    return this.#transportPolicy.execute(
      {
        region: this.region,
        operation,
        retryMode,
        recoveryProbe,
        profileId: credentials.profileId,
        requestTimeoutMs: Math.max(1, Math.min(timeoutMs, this.#requestTimeoutMs)),
        uncertainOnAbort,
        signal
      },
      async ({ signal: requestSignal }) => {
        try {
          const response = await this.#fetchImpl(endpoint, {
            ...init,
            signal: requestSignal
          });
      const expectedOrigin = new URL(endpoint).origin;
      if (response.redirected) {
        throw new LeetCodeToolError(
          "REMOTE_UNAVAILABLE",
          "LeetCode returned a redirect that was not followed",
          { details: { redirectRejected: true } }
        );
      }
      if (response.url.length > 0) {
        const finalUrl = new URL(response.url);
        if (finalUrl.protocol !== "https:" || finalUrl.origin !== expectedOrigin) {
          throw new LeetCodeToolError(
            "REMOTE_UNAVAILABLE",
            "LeetCode response crossed the fixed host boundary",
            { details: { redirectRejected: true } }
          );
        }
      }
      if (response.status >= 300 && response.status < 400) {
        throw new LeetCodeToolError(
          "REMOTE_UNAVAILABLE",
          "LeetCode returned a redirect that was not followed",
          { details: { redirectRejected: true } }
        );
      }
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        throw new LeetCodeToolError(
          "RATE_LIMITED",
          "LeetCode rate limit was reached",
          {
            retryable: true,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs })
          }
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new LeetCodeToolError(
          "AUTH_EXPIRED",
          `Authentication expired for LeetCode ${this.region}`
        );
      }
      if (response.status === 404) {
        throw new LeetCodeToolError("NOT_FOUND", "LeetCode resource was not found");
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
          "LeetCode rejected the operation request",
          { details: { status: response.status } }
        );
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("application/json")) {
        throw new LeetCodeToolError(
          "REMOTE_SCHEMA_CHANGED",
          "LeetCode returned an unsupported content type"
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > this.#maxResponseBytes
      ) {
        throw new LeetCodeToolError(
          "REMOTE_SCHEMA_CHANGED",
          "LeetCode response exceeded the configured size limit"
        );
      }
      const responseText = await response.text();
      if (utf8Bytes(responseText).byteLength > this.#maxResponseBytes) {
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
          return decode(responseRecord(payload, "response"));
        } catch (error) {
          if (error instanceof LeetCodeToolError) {
            throw error;
          }
          throw new LeetCodeToolError(
            "REMOTE_UNAVAILABLE",
            "LeetCode request failed",
            {
              retryable: true,
              details: { transportUncertain: true }
            }
          );
        }
      }
    );
  }

  #combinedSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.#lifecycle.signal
      : AbortSignal.any([this.#lifecycle.signal, signal]);
  }

  #remaining(deadline: number): number {
    return Math.max(0, deadline - this.#clock.now().getTime());
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new LeetCodeToolError("CANCELLED", "The LeetCode runtime is closed");
    }
  }
}

export function createLeetCodeWriteAdapter(
  region: Region,
  options: LeetCodeWriteAdapterOptions = {}
): LeetCodeWriteAdapter {
  return new HttpWriteAdapter(region, options);
}

export function createLeetCodeWriteAdapters(
  options: LeetCodeWriteAdapterOptions = {}
): LeetCodeWriteAdapters {
  const transportPolicy =
    options.transportPolicy ??
    createDefaultTransportPolicy({
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.rateLimiter === undefined
        ? {}
        : { rateLimiter: options.rateLimiter })
    });
  const sharedOptions: LeetCodeWriteAdapterOptions = {
    ...options,
    transportPolicy
  };
  const global = createLeetCodeWriteAdapter("global", sharedOptions);
  const cn = createLeetCodeWriteAdapter("cn", sharedOptions);
  return {
    global,
    cn,
    forRegion(region: Region): LeetCodeWriteAdapter {
      switch (region) {
        case "global":
          return global;
        case "cn":
          return cn;
        default:
          throw new LeetCodeToolError(
            "UNSUPPORTED_REGION",
            `Unsupported LeetCode region: ${String(region)}`
          );
      }
    }
  };
}
