import { createHash, randomUUID } from "node:crypto";

import { Check } from "typebox/value";

import type { LeetCodeClient } from "../leetcode/client.js";
import { toToolFailure } from "../leetcode/errors.js";
import type {
  CapabilityManifest,
  NotesDocument,
  NotesReadInput,
  NotesWriteInput,
  Region,
  ToolErrorCode,
  ToolFailure,
  ToolMeta,
  ToolResult,
  UserNoteMutationResult,
  UserNotesGetResult,
  UserNotesSearchResult,
  UserStatus
} from "../types.js";
import {
  BEHAVIOR_MANIFEST_DIGEST,
  CONTRACT_VERSION,
  CAPABILITY_MANIFEST_DIGEST,
  NotesReadInputSchema,
  NotesWriteInputSchema,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_DIGEST,
  TOOL_INPUT_SCHEMAS,
  UserNotesCreateInputSchema,
  UserNotesGetInputSchema,
  UserNotesSearchInputSchema,
  UserNotesUpdateInputSchema,
  UserStatusInputSchema,
  isToolName,
  normalizeToolInput,
  type ToolName
} from "./contract.js";
import {
  GatewayDiagnostics,
  type DiagnosticsOperation,
  type DiagnosticsSnapshot
} from "./diagnostics.js";

export interface SubmitConfirmationRequest {
  region: Region;
  titleSlug: string;
  language: string;
  codeHash: string;
}

export type GatewayInteractionBridge =
  | { hasUI: false }
  | {
      hasUI: true;
      confirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
    };

export interface GatewayExecuteOptions {
  signal?: AbortSignal;
  requestId?: string;
  interaction?: GatewayInteractionBridge;
}

export interface CreateGatewayOptions {
  client: LeetCodeClient;
  interactiveUI: boolean;
  now?: () => Date;
}

export interface ToolGateway {
  getCapabilities(): CapabilityManifest;
  getDiagnosticsSnapshot(): DiagnosticsSnapshot;
  updateDiagnosticsQueue(region: Region, depth: number, limit: number): void;
  recordDiagnosticsResult(
    operation: DiagnosticsOperation,
    region: Region,
    result: ToolResult<unknown>
  ): void;
  execute(
    name: ToolName | string,
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<unknown>>;
  readNotes(
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<NotesDocument>>;
  writeNotes(
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<NotesDocument>>;
  getUserStatus(
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<UserStatus>>;
  searchUserNotes(
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<UserNotesSearchResult>>;
  getUserNotes(
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<UserNotesGetResult>>;
  createUserNote(
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<UserNoteMutationResult>>;
  updateUserNote(
    input: unknown,
    options?: GatewayExecuteOptions
  ): Promise<ToolResult<UserNoteMutationResult>>;
  setProviderConflict(conflicted: boolean): void;
  close(): Promise<void>;
}

function inputRegion(input: unknown): Region {
  if (input !== null && typeof input === "object") {
    const region = (input as { region?: unknown }).region;
    if (region === "cn") {
      return "cn";
    }
  }
  return "global";
}

function userNotesInputRegion(input: unknown): Region {
  return input !== null &&
    typeof input === "object" &&
    (input as { region?: unknown }).region === "global"
    ? "global"
    : "cn";
}

function createMeta(
  requestId: string,
  region: Region,
  manifest?: CapabilityManifest,
  base?: ToolMeta
): ToolMeta {
  return {
    ...base,
    region,
    packageVersion: manifest?.packageVersion ?? PACKAGE_VERSION,
    contractVersion: CONTRACT_VERSION,
    schemaDigest: SCHEMA_DIGEST,
    behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
    instanceId: manifest?.instanceId ?? "inactive",
    contextRevision: manifest?.contextRevision ?? 0,
    ...(manifest?.activeAccountProfileId === undefined
      ? {}
      : { accountProfileId: manifest.activeAccountProfileId }),
    requestId
  };
}

function cloneManifest(manifest: CapabilityManifest): CapabilityManifest {
  return {
    ...manifest,
    supportedRegions: [...manifest.supportedRegions],
    tools: manifest.tools.map((tool) => ({ ...tool })),
    notesPort: {
      global: { ...manifest.notesPort.global },
      cn: { ...manifest.notesPort.cn }
    },
    regionReadiness: {
      global: { ...manifest.regionReadiness.global },
      cn: { ...manifest.regionReadiness.cn }
    }
  };
}

function normalizeRegionReadiness(
  manifest: CapabilityManifest,
  region: Region,
  interactiveUI: boolean
): CapabilityManifest["regionReadiness"]["global"] {
  return {
    ...manifest.regionReadiness[region],
    externalWrite: interactiveUI
      ? manifest.regionReadiness[region].externalWrite
      : false
  };
}

export function createGatewayFailure(
  code: ToolErrorCode,
  message: string,
  options: {
    requestId?: string;
    region?: Region;
    retryable?: boolean;
    operationId?: string;
    details?: Record<string, string | number | boolean | null>;
    manifest?: CapabilityManifest;
  } = {}
): ToolFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      ...(options.details === undefined ? {} : { details: options.details })
    },
    meta: createMeta(
      options.requestId ?? randomUUID(),
      options.region ?? "global",
      options.manifest
    )
  };
}

export function createUnavailableResult(
  name: string,
  input: unknown,
  requestId?: string
): ToolFailure {
  return createGatewayFailure("CAPABILITY_UNAVAILABLE", `${name} is unavailable because the LeetCode runtime is not active`, {
    region: inputRegion(input),
    ...(requestId === undefined ? {} : { requestId })
  });
}

function combinedSignal(lifecycle: AbortSignal, caller?: AbortSignal): AbortSignal {
  return caller === undefined ? lifecycle : AbortSignal.any([lifecycle, caller]);
}

export class LeetCodeToolGateway implements ToolGateway {
  readonly #client: LeetCodeClient;
  readonly #interactiveUI: boolean;
  readonly #diagnostics: GatewayDiagnostics;
  readonly #now: () => Date;
  #manifest: CapabilityManifest;
  readonly #lifecycle = new AbortController();
  #active = true;
  #providerConflict = false;
  #closePromise: Promise<void> | undefined;
  #capabilitySnapshotRevision = 0;
  #lastCapabilityObservedEpoch = -1;

  constructor(options: CreateGatewayOptions) {
    this.#client = options.client;
    this.#interactiveUI = options.interactiveUI;
    this.#now = options.now ?? (() => new Date());
    this.#diagnostics = new GatewayDiagnostics(options.now);

    const clientManifest = options.client.getCapabilities(options.interactiveUI);
    const observedAt = this.#nextCapabilityObservedAt();
    this.#manifest = cloneManifest({
      ...clientManifest,
      packageName: PACKAGE_NAME,
      contractVersion: CONTRACT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest: SCHEMA_DIGEST,
      behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
      capabilityManifestDigest: CAPABILITY_MANIFEST_DIGEST,
      snapshotRevision: this.#capabilitySnapshotRevision,
      observedAt,
      regionReadiness: {
        global: normalizeRegionReadiness(clientManifest, "global", options.interactiveUI),
        cn: normalizeRegionReadiness(clientManifest, "cn", options.interactiveUI)
      },
      interactiveUI: options.interactiveUI
    });
  }

  getCapabilities(): CapabilityManifest {
    this.#refreshManifest();
    const manifest = cloneManifest(this.#manifest);
    if (this.#providerConflict) {
      manifest.tools = manifest.tools.map((tool) => ({
        ...tool,
        currentlyAvailable: false,
        reason: "provider_conflict"
      }));
      manifest.notesPort.global.currentlyAvailable = false;
      manifest.notesPort.global.reason = "provider_conflict";
      manifest.notesPort.cn.currentlyAvailable = false;
      manifest.notesPort.cn.reason = "provider_conflict";
      manifest.regionReadiness.global = {
        ...manifest.regionReadiness.global,
        publicReads: false,
        sessionReads: false,
        execution: false,
        externalWrite: false,
        notes: false
      };
      manifest.regionReadiness.cn = {
        ...manifest.regionReadiness.cn,
        publicReads: false,
        sessionReads: false,
        execution: false,
        externalWrite: false,
        notes: false
      };
    }
    return manifest;
  }

  getDiagnosticsSnapshot(): DiagnosticsSnapshot {
    this.#refreshManifest();
    return this.#diagnostics.getSnapshot(this.#manifest);
  }

  updateDiagnosticsQueue(region: Region, depth: number, limit: number): void {
    this.#diagnostics.updateQueue(region, depth, limit);
  }

  recordDiagnosticsResult(
    operation: DiagnosticsOperation,
    region: Region,
    result: ToolResult<unknown>
  ): void {
    this.#diagnostics.observe(operation, region, result);
  }

  setProviderConflict(conflicted: boolean): void {
    this.#providerConflict = conflicted;
  }

  async execute(
    name: ToolName | string,
    input: unknown,
    options: GatewayExecuteOptions = {}
  ): Promise<ToolResult<unknown>> {
    const result = await this.#execute(name, input, options);
    if (isToolName(name)) {
      this.#diagnostics.observe(name, inputRegion(input), result);
    }
    return result;
  }

  async #execute(
    name: ToolName | string,
    input: unknown,
    options: GatewayExecuteOptions
  ): Promise<ToolResult<unknown>> {
    this.#refreshManifest();
    const requestId = options.requestId ?? randomUUID();
    const region = inputRegion(input);

    if (!this.#active) {
      return createGatewayFailure("CANCELLED", "LeetCode runtime is no longer active", {
        requestId,
        region,
        manifest: this.#manifest
      });
    }

    if (this.#providerConflict) {
      return createGatewayFailure(
        "PROVIDER_CONFLICT",
        "Multiple active pi-leetcode-tools providers were detected",
        { requestId, region, manifest: this.#manifest }
      );
    }

    if (!isToolName(name)) {
      return createGatewayFailure("CAPABILITY_UNAVAILABLE", "Unknown LeetCode tool", {
        requestId,
        region,
        manifest: this.#manifest
      });
    }

    if (!Check(TOOL_INPUT_SCHEMAS[name], input)) {
      return createGatewayFailure("VALIDATION_ERROR", `Invalid input for ${name}`, {
        requestId,
        region,
        manifest: this.#manifest
      });
    }

    if (
      name === "lc_submit" &&
      input !== null &&
      typeof input === "object" &&
      (input as { retryUnknownOperationId?: unknown }).retryUnknownOperationId !== undefined &&
      (input as { resubmitCompletedOperationId?: unknown }).resubmitCompletedOperationId !==
        undefined
    ) {
      return createGatewayFailure(
        "VALIDATION_ERROR",
        "retryUnknownOperationId and resubmitCompletedOperationId are mutually exclusive",
        { requestId, region, manifest: this.#manifest }
      );
    }

    if (
      (name === "lc_search" || name === "lc_history") &&
      input !== null &&
      typeof input === "object" &&
      "cursor" in input &&
      (input as { cursor?: unknown }).cursor !== undefined &&
      "offset" in input &&
      (input as { offset?: unknown }).offset !== undefined
    ) {
      return createGatewayFailure(
        "VALIDATION_ERROR",
        `${name} cannot use cursor and offset together`,
        { requestId, region, manifest: this.#manifest }
      );
    }

    if (name === "lc_history" && input !== null && typeof input === "object") {
      const historyInput = input as { scope?: unknown; titleSlug?: unknown };
      const scope =
        historyInput.scope ??
        (historyInput.titleSlug === undefined ? "account" : "problem");
      if (
        (scope === "problem" && historyInput.titleSlug === undefined) ||
        (scope === "account" && historyInput.titleSlug !== undefined)
      ) {
        return createGatewayFailure(
          "VALIDATION_ERROR",
          "lc_history scope and titleSlug are inconsistent",
          { requestId, region, manifest: this.#manifest }
        );
      }
    }

    const params = normalizeToolInput(name, input) as Record<string, unknown>;
    const signal = combinedSignal(this.#lifecycle.signal, options.signal);

    if (signal.aborted) {
      return createGatewayFailure("CANCELLED", "LeetCode request was cancelled", {
        requestId,
        region,
        manifest: this.#manifest
      });
    }

    try {
      if (name === "lc_submit") {
        const confirmationFailure = await this.#confirmSubmit(
          params,
          signal,
          requestId,
          options.interaction
        );
        if (confirmationFailure !== undefined) {
          return confirmationFailure;
        }
        const contextFailure = this.#contextFailure(requestId, region);
        if (contextFailure !== undefined) {
          return contextFailure;
        }
      }

      let result: ToolResult<unknown>;
      switch (name) {
        case "lc_daily":
          result = await this.#client.getDaily(params.region as Region, signal);
          break;
        case "lc_search":
          result = await this.#client.searchProblems(
            params as unknown as Parameters<LeetCodeClient["searchProblems"]>[0],
            signal
          );
          break;
        case "lc_problem":
          result = await this.#client.getProblem(
            params as unknown as Parameters<LeetCodeClient["getProblem"]>[0],
            signal
          );
          break;
        case "lc_solution_search":
          result = await this.#client.searchSolutions(
            params as unknown as Parameters<LeetCodeClient["searchSolutions"]>[0],
            signal
          );
          break;
        case "lc_solution":
          result = await this.#client.getSolution(
            params as unknown as Parameters<LeetCodeClient["getSolution"]>[0],
            signal
          );
          break;
        case "lc_profile":
          result = await this.#client.getUserProfile(
            params as unknown as Parameters<LeetCodeClient["getUserProfile"]>[0],
            signal
          );
          break;
        case "lc_contest":
          result = await this.#client.getUserContest(
            params as unknown as Parameters<LeetCodeClient["getUserContest"]>[0],
            signal
          );
          break;
        case "lc_progress":
          result = await this.#client.getProgress(
            params as unknown as Parameters<LeetCodeClient["getProgress"]>[0],
            signal
          );
          break;
        case "lc_history":
          result = await this.#client.getHistory(
            params as unknown as Parameters<LeetCodeClient["getHistory"]>[0],
            signal
          );
          break;
        case "lc_user_submissions":
          result = await this.#client.getUserSubmissions(
            params as unknown as Parameters<LeetCodeClient["getUserSubmissions"]>[0],
            signal
          );
          break;
        case "lc_submission":
          result = await this.#client.getSubmissionDetail(
            params as unknown as Parameters<LeetCodeClient["getSubmissionDetail"]>[0],
            signal
          );
          break;
        case "lc_run":
          result = await this.#client.runCode(
            params as unknown as Parameters<LeetCodeClient["runCode"]>[0],
            signal
          );
          break;
        case "lc_submit":
          result = await this.#client.submitCode(
            params as unknown as Parameters<LeetCodeClient["submitCode"]>[0],
            signal
          );
          break;
        case "lc_operation_status":
          result = await this.#client.getOperationStatus(
            params.operationId as string,
            signal
          );
          break;
      }
      return {
        ...result,
        meta: createMeta(requestId, region, this.#manifest, result.meta)
      };
    } catch (error) {
      if (signal.aborted) {
        return createGatewayFailure("CANCELLED", "LeetCode request was cancelled", {
          requestId,
          region,
          manifest: this.#manifest
        });
      }

      return toToolFailure(
        error,
        createMeta(requestId, region, this.#manifest),
        "REMOTE_UNAVAILABLE"
      );
    }
  }

  async readNotes(
    input: unknown,
    options: GatewayExecuteOptions = {}
  ): Promise<ToolResult<NotesDocument>> {
    const result = await this.#executeNotes("read", input, options);
    this.#diagnostics.observe("notes.read", inputRegion(input), result);
    return result;
  }

  async writeNotes(
    input: unknown,
    options: GatewayExecuteOptions = {}
  ): Promise<ToolResult<NotesDocument>> {
    const result = await this.#executeNotes("write", input, options);
    this.#diagnostics.observe("notes.write", inputRegion(input), result);
    return result;
  }

  async getUserStatus(
    input: unknown,
    options: GatewayExecuteOptions = {}
  ): Promise<ToolResult<UserStatus>> {
    this.#refreshManifest();
    const requestId = options.requestId ?? randomUUID();
    const region = inputRegion(input);

    if (!this.#active) {
      const result = createGatewayFailure("CANCELLED", "LeetCode runtime is no longer active", {
        requestId,
        region,
        manifest: this.#manifest
      });
      this.#diagnostics.observe("user.status", region, result);
      return result;
    }
    if (this.#providerConflict) {
      const result = createGatewayFailure(
        "PROVIDER_CONFLICT",
        "Multiple active pi-leetcode-tools providers were detected",
        { requestId, region, manifest: this.#manifest }
      );
      this.#diagnostics.observe("user.status", region, result);
      return result;
    }
    if (!Check(UserStatusInputSchema, input)) {
      const result = createGatewayFailure("VALIDATION_ERROR", "Invalid user.status input", {
        requestId,
        region,
        manifest: this.#manifest
      });
      this.#diagnostics.observe("user.status", region, result);
      return result;
    }

    const normalizedRegion = (input as { region?: Region }).region ?? "global";
    const signal = combinedSignal(this.#lifecycle.signal, options.signal);
    if (signal.aborted) {
      const result = createGatewayFailure("CANCELLED", "LeetCode user status request was cancelled", {
        requestId,
        region: normalizedRegion,
        manifest: this.#manifest
      });
      this.#diagnostics.observe("user.status", normalizedRegion, result);
      return result;
    }

    let result: ToolResult<UserStatus>;
    try {
      const clientResult = await this.#client.getUserStatus(normalizedRegion, signal);
      result = {
        ...clientResult,
        meta: createMeta(
          requestId,
          normalizedRegion,
          this.#manifest,
          clientResult.meta
        )
      };
    } catch (error) {
      result = signal.aborted
        ? createGatewayFailure("CANCELLED", "LeetCode user status request was cancelled", {
            requestId,
            region: normalizedRegion,
            manifest: this.#manifest
          })
        : toToolFailure(
            error,
            createMeta(requestId, normalizedRegion, this.#manifest),
            "REMOTE_UNAVAILABLE"
          );
    }
    this.#diagnostics.observe("user.status", normalizedRegion, result);
    return result;
  }

  async searchUserNotes(
    input: unknown,
    options: GatewayExecuteOptions = {}
  ): Promise<ToolResult<UserNotesSearchResult>> {
    const result = await this.#executeUserNotes("search", input, options);
    this.#diagnostics.observe("notes.search", userNotesInputRegion(input), result);
    return result as ToolResult<UserNotesSearchResult>;
  }

  async getUserNotes(
    input: unknown,
    options: GatewayExecuteOptions = {}
  ): Promise<ToolResult<UserNotesGetResult>> {
    const result = await this.#executeUserNotes("get", input, options);
    this.#diagnostics.observe("notes.get", userNotesInputRegion(input), result);
    return result as ToolResult<UserNotesGetResult>;
  }

  async createUserNote(
    input: unknown,
    options: GatewayExecuteOptions = {}
  ): Promise<ToolResult<UserNoteMutationResult>> {
    const result = await this.#executeUserNotes("create", input, options);
    this.#diagnostics.observe("notes.create", userNotesInputRegion(input), result);
    return result as ToolResult<UserNoteMutationResult>;
  }

  async updateUserNote(
    input: unknown,
    options: GatewayExecuteOptions = {}
  ): Promise<ToolResult<UserNoteMutationResult>> {
    const result = await this.#executeUserNotes("update", input, options);
    this.#diagnostics.observe("notes.update", userNotesInputRegion(input), result);
    return result as ToolResult<UserNoteMutationResult>;
  }

  async #executeUserNotes(
    operation: "search" | "get" | "create" | "update",
    input: unknown,
    options: GatewayExecuteOptions
  ): Promise<
    ToolResult<UserNotesSearchResult | UserNotesGetResult | UserNoteMutationResult>
  > {
    this.#refreshManifest();
    const requestId = options.requestId ?? randomUUID();
    const region = userNotesInputRegion(input);

    if (!this.#active) {
      return createGatewayFailure("CANCELLED", "LeetCode runtime is no longer active", {
        requestId,
        region,
        manifest: this.#manifest
      });
    }
    if (this.#providerConflict) {
      return createGatewayFailure(
        "PROVIDER_CONFLICT",
        "Multiple active pi-leetcode-tools providers were detected",
        { requestId, region, manifest: this.#manifest }
      );
    }

    const schema =
      operation === "search"
        ? UserNotesSearchInputSchema
        : operation === "get"
          ? UserNotesGetInputSchema
          : operation === "create"
            ? UserNotesCreateInputSchema
            : UserNotesUpdateInputSchema;
    if (!Check(schema, input)) {
      return createGatewayFailure(
        "VALIDATION_ERROR",
        `Invalid notes.${operation} input`,
        { requestId, region, manifest: this.#manifest }
      );
    }
    if (region !== "cn") {
      return createGatewayFailure(
        "UNSUPPORTED_REGION",
        "Personal notes are available only on LeetCode cn",
        { requestId, region, manifest: this.#manifest }
      );
    }

    const raw = input as Record<string, unknown>;
    const params: Record<string, unknown> = {
      ...raw,
      region: "cn",
      ...(operation === "search"
        ? {
            limit: raw.limit ?? 10,
            skip: raw.skip ?? 0,
            orderBy: raw.orderBy ?? "DESCENDING"
          }
        : operation === "get"
          ? { limit: raw.limit ?? 10, skip: raw.skip ?? 0 }
          : operation === "create"
            ? { title: raw.title ?? "" }
            : { content: raw.content ?? "", title: raw.title ?? "" })
    };
    const signal = combinedSignal(this.#lifecycle.signal, options.signal);
    if (signal.aborted) {
      return createGatewayFailure("CANCELLED", "LeetCode personal notes request was cancelled", {
        requestId,
        region: "cn",
        manifest: this.#manifest
      });
    }

    const isWrite = operation === "create" || operation === "update";
    if (isWrite) {
      if (!this.#manifest.interactiveUI || options.interaction?.hasUI !== true) {
        return createGatewayFailure(
          "INTERACTION_REQUIRED",
          `notes.${operation} requires interactive confirmation`,
          { requestId, region: "cn", manifest: this.#manifest }
        );
      }
      const content = params.content as string;
      const title = params.title as string;
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      const titleHash = createHash("sha256").update(title, "utf8").digest("hex");
      let confirmed: boolean;
      try {
        confirmed = await options.interaction.confirm(
          operation === "create"
            ? "Create a personal LeetCode note?"
            : "Update a personal LeetCode note?",
          [
            "Region: cn",
            `Instance: ${this.#manifest.instanceId}`,
            `Context revision: ${this.#manifest.contextRevision}`,
            ...(this.#manifest.activeAccountProfileId === undefined
              ? []
              : [`Profile: ${this.#manifest.activeAccountProfileId}`]),
            ...(operation === "create"
              ? [`Question ID: ${params.questionId as string}`]
              : [`Note ID: ${params.noteId as string}`]),
            `Title bytes: ${new TextEncoder().encode(title).byteLength}`,
            `Title SHA-256: ${titleHash}`,
            `Content bytes: ${new TextEncoder().encode(content).byteLength}`,
            `Content SHA-256: ${contentHash}`,
            "This writes the current authenticated user's personal note.",
            "The note body and title are not shown or persisted by confirmation."
          ].join("\n"),
          signal
        );
      } catch {
        return createGatewayFailure(
          signal.aborted ? "CANCELLED" : "INTERACTION_REQUIRED",
          signal.aborted
            ? "LeetCode personal note write was cancelled"
            : "LeetCode personal note confirmation could not be completed",
          { requestId, region: "cn", manifest: this.#manifest }
        );
      }
      if (signal.aborted) {
        return createGatewayFailure("CANCELLED", "LeetCode personal note write was cancelled", {
          requestId,
          region: "cn",
          manifest: this.#manifest
        });
      }
      if (!confirmed) {
        return createGatewayFailure(
          "PERMISSION_DENIED",
          "LeetCode personal note write was not confirmed",
          { requestId, region: "cn", manifest: this.#manifest }
        );
      }
      const contextFailure = this.#contextFailure(requestId, "cn");
      if (contextFailure !== undefined) {
        return contextFailure;
      }
    }

    try {
      const expectedAccountProfileId = this.#manifest.activeAccountProfileId;
      const result =
        operation === "search"
          ? await this.#client.searchUserNotes(
              params as unknown as Parameters<LeetCodeClient["searchUserNotes"]>[0],
              signal,
              expectedAccountProfileId
            )
          : operation === "get"
            ? await this.#client.getUserNotes(
                params as unknown as Parameters<LeetCodeClient["getUserNotes"]>[0],
                signal,
                expectedAccountProfileId
              )
            : operation === "create"
              ? await this.#client.createUserNote(
                  params as unknown as Parameters<LeetCodeClient["createUserNote"]>[0],
                  signal,
                  expectedAccountProfileId
                )
              : await this.#client.updateUserNote(
                  params as unknown as Parameters<LeetCodeClient["updateUserNote"]>[0],
                  signal,
                  expectedAccountProfileId
                );
      return {
        ...result,
        meta: createMeta(requestId, "cn", this.#manifest, result.meta)
      };
    } catch (error) {
      if (signal.aborted) {
        return createGatewayFailure(
          isWrite ? "UNKNOWN_WRITE_OUTCOME" : "CANCELLED",
          isWrite
            ? "The LeetCode personal note write outcome is unknown; read before retrying"
            : "LeetCode personal notes request was cancelled",
          {
            requestId,
            region: "cn",
            manifest: this.#manifest,
            ...(isWrite ? { details: { writeOutcomeUnverified: true } } : {})
          }
        );
      }
      return toToolFailure(
        error,
        createMeta(requestId, "cn", this.#manifest),
        "REMOTE_UNAVAILABLE"
      );
    }
  }

  async #executeNotes(
    operation: "read" | "write",
    input: unknown,
    options: GatewayExecuteOptions
  ): Promise<ToolResult<NotesDocument>> {
    this.#refreshManifest();
    const requestId = options.requestId ?? randomUUID();
    const region = inputRegion(input);

    if (!this.#active) {
      return createGatewayFailure("CANCELLED", "LeetCode runtime is no longer active", {
        requestId,
        region,
        manifest: this.#manifest
      });
    }
    if (this.#providerConflict) {
      return createGatewayFailure(
        "PROVIDER_CONFLICT",
        "Multiple active pi-leetcode-tools providers were detected",
        { requestId, region, manifest: this.#manifest }
      );
    }

    const schema = operation === "read" ? NotesReadInputSchema : NotesWriteInputSchema;
    if (!Check(schema, input)) {
      return createGatewayFailure("VALIDATION_ERROR", `Invalid NotesPort ${operation} input`, {
        requestId,
        region,
        manifest: this.#manifest
      });
    }

    const capability = this.#manifest.notesPort[region];
    if (!capability.supported || !capability.currentlyAvailable) {
      return createGatewayFailure(
        "CAPABILITY_UNAVAILABLE",
        `NotesPort is unavailable for LeetCode ${region}`,
        { requestId, region, manifest: this.#manifest }
      );
    }

    const signal = combinedSignal(this.#lifecycle.signal, options.signal);
    if (signal.aborted) {
      return createGatewayFailure("CANCELLED", "LeetCode notes request was cancelled", {
        requestId,
        region,
        manifest: this.#manifest
      });
    }

    if (operation === "write") {
      const params = input as NotesWriteInput;
      if (!this.#manifest.interactiveUI || options.interaction?.hasUI !== true) {
        return createGatewayFailure(
          "INTERACTION_REQUIRED",
          "Writing LeetCode notes requires interactive confirmation",
          { requestId, region, manifest: this.#manifest }
        );
      }
      const contentHash = createHash("sha256").update(params.content, "utf8").digest("hex");
      let confirmed: boolean;
      try {
        confirmed = await options.interaction.confirm(
          "Write learning state to LeetCode notes?",
          [
            `Region: ${params.region}`,
            `Instance: ${this.#manifest.instanceId}`,
            `Context revision: ${this.#manifest.contextRevision}`,
            ...(this.#manifest.activeAccountProfileId === undefined
              ? []
              : [`Profile: ${this.#manifest.activeAccountProfileId}`]),
            `Target: ${params.target}`,
            `Expected revision: ${params.expectedRevision ?? "<new note>"}`,
            `Write bytes: ${new TextEncoder().encode(params.content).byteLength}`,
            "Revision mode: best-effort-compare-and-set",
            `Content SHA-256: ${contentHash}`
          ].join("\n"),
          signal
        );
      } catch {
        return createGatewayFailure(
          signal.aborted ? "CANCELLED" : "INTERACTION_REQUIRED",
          signal.aborted
            ? "LeetCode notes write was cancelled"
            : "LeetCode notes confirmation could not be completed",
          { requestId, region, manifest: this.#manifest }
        );
      }
      if (signal.aborted) {
        return createGatewayFailure("CANCELLED", "LeetCode notes write was cancelled", {
          requestId,
          region,
          manifest: this.#manifest
        });
      }
      if (!confirmed) {
        return createGatewayFailure("PERMISSION_DENIED", "LeetCode notes write was not confirmed", {
          requestId,
          region,
          manifest: this.#manifest
        });
      }
      const contextFailure = this.#contextFailure(requestId, region);
      if (contextFailure !== undefined) {
        return contextFailure;
      }
    }

    try {
      const result =
        operation === "read"
          ? await this.#client.readNotes(input as NotesReadInput, signal)
          : await this.#client.writeNotes(input as NotesWriteInput, signal);
      return {
        ...result,
        meta: createMeta(requestId, region, this.#manifest, result.meta)
      };
    } catch (error) {
      return toToolFailure(
        error,
        createMeta(requestId, region, this.#manifest),
        "REMOTE_UNAVAILABLE"
      );
    }
  }

  async #confirmSubmit(
    params: Record<string, unknown>,
    signal: AbortSignal,
    requestId: string,
    interaction?: GatewayInteractionBridge
  ): Promise<ToolFailure | undefined> {
    if (!this.#manifest.interactiveUI || interaction?.hasUI !== true) {
      return createGatewayFailure(
        "INTERACTION_REQUIRED",
        "Submitting a solution requires interactive confirmation",
        {
          requestId,
          region: params.region as Region,
          manifest: this.#manifest
        }
      );
    }

    const request: SubmitConfirmationRequest = {
      region: params.region as Region,
      titleSlug: params.titleSlug as string,
      language: params.language as string,
      codeHash: createHash("sha256")
        .update(params.code as string, "utf8")
        .digest("hex")
    };

    let confirmed: boolean;
    try {
      confirmed = await interaction.confirm(
        params.retryUnknownOperationId !== undefined
          ? "Retry a submission with an unknown prior outcome?"
          : params.resubmitCompletedOperationId !== undefined
            ? "Submit this solution to LeetCode again?"
            : "Submit solution to LeetCode?",
        [
          `Region: ${request.region}`,
          `Instance: ${this.#manifest.instanceId}`,
          `Context revision: ${this.#manifest.contextRevision}`,
          ...(this.#manifest.activeAccountProfileId === undefined
            ? []
            : [`Profile: ${this.#manifest.activeAccountProfileId}`]),
          `Problem: ${request.titleSlug}`,
          `Language: ${request.language}`,
          `Code SHA-256: ${request.codeHash}`,
          ...(params.retryUnknownOperationId === undefined
            ? []
            : [
                `Prior operation: ${params.retryUnknownOperationId as string}`,
                "Warning: LeetCode may record a duplicate submission."
              ]),
          ...(params.resubmitCompletedOperationId === undefined
            ? []
            : [
                `Completed operation: ${params.resubmitCompletedOperationId as string}`,
                "Warning: this explicitly creates another LeetCode submission."
              ])
        ].join("\n"),
        signal
      );
    } catch {
      return createGatewayFailure(
        signal.aborted ? "CANCELLED" : "INTERACTION_REQUIRED",
        signal.aborted
          ? "LeetCode submission was cancelled"
          : "LeetCode submission confirmation could not be completed",
        {
          requestId,
          region: params.region as Region,
          manifest: this.#manifest
        }
      );
    }

    if (signal.aborted) {
      return createGatewayFailure("CANCELLED", "LeetCode submission was cancelled", {
        requestId,
        region: params.region as Region,
        manifest: this.#manifest
      });
    }

    if (!confirmed) {
      return createGatewayFailure(
        "PERMISSION_DENIED",
        "LeetCode submission was not confirmed",
        {
          requestId,
          region: params.region as Region,
          manifest: this.#manifest
        }
      );
    }

    return undefined;
  }

  #contextFailure(requestId: string, region: Region): ToolFailure | undefined {
    const expected = this.#manifest;
    const current = this.#normalizedClientManifest();
    if (
      current.instanceId !== expected.instanceId ||
      current.contextRevision !== expected.contextRevision ||
      current.activeAccountProfileId !== expected.activeAccountProfileId
    ) {
      return createGatewayFailure(
        "STALE_OPERATION",
        "The LeetCode account or Gateway context changed during confirmation",
        { requestId, region, manifest: current }
      );
    }
    this.#manifest = current;
    return undefined;
  }

  #normalizedClientManifest(): CapabilityManifest {
    const clientManifest = this.#client.getCapabilities(this.#interactiveUI);
    const observedAt = this.#nextCapabilityObservedAt();
    return cloneManifest({
      ...clientManifest,
      packageName: PACKAGE_NAME,
      contractVersion: CONTRACT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest: SCHEMA_DIGEST,
      behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
      capabilityManifestDigest: CAPABILITY_MANIFEST_DIGEST,
      snapshotRevision: this.#capabilitySnapshotRevision,
      observedAt,
      regionReadiness: {
        global: normalizeRegionReadiness(clientManifest, "global", this.#interactiveUI),
        cn: normalizeRegionReadiness(clientManifest, "cn", this.#interactiveUI)
      },
      interactiveUI: this.#interactiveUI
    });
  }

  #nextCapabilityObservedAt(): string {
    const candidate = this.#now().getTime();
    const safeCandidate = Number.isFinite(candidate) ? candidate : 0;
    const epoch = Math.max(safeCandidate, this.#lastCapabilityObservedEpoch + 1);
    this.#lastCapabilityObservedEpoch = epoch;
    this.#capabilitySnapshotRevision += 1;
    return new Date(epoch).toISOString();
  }

  #refreshManifest(): void {
    this.#manifest = this.#normalizedClientManifest();
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }

    this.#active = false;
    this.#lifecycle.abort();
    this.#closePromise = this.#client.close();
    return this.#closePromise;
  }
}

export function createToolGateway(options: CreateGatewayOptions): ToolGateway {
  return new LeetCodeToolGateway(options);
}
