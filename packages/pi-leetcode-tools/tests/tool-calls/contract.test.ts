import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  BEHAVIOR_MANIFEST,
  BEHAVIOR_MANIFEST_DIGEST,
  CAPABILITY_MANIFEST_DIGEST,
  CapabilitySnapshotSchema,
  CONTRACT_VERSION,
  DiagnosticsSnapshotSchema,
  GATEWAY_RPC_METHODS,
  GatewayDiscoveryResponseSchema,
  GatewayRpcMethodSchema,
  GatewayRpcRequestSchema,
  HistoryInputSchema,
  PageInfoSchema,
  ProblemDetailSchema,
  OperationStatusSchema,
  PROTOCOL_VERSION,
  SCHEMA_DIGEST,
  STATIC_CAPABILITY_MANIFEST,
  SearchInputSchema,
  RunInputSchema,
  SubmissionDetailInputSchema,
  SubmitInputSchema,
  TOOL_CONTRACT_DOCUMENT,
  TOOL_ERROR_CODES,
  TOOL_NAMES,
  UPSTREAM_PROGRAMMING_LANGS,
  UserNotesCreateInputSchema,
  UserNotesGetInputSchema,
  UserNotesSearchInputSchema,
  UserNotesUpdateInputSchema,
  canonicalLanguageToRemote,
  normalizeToolInput,
  remoteLanguageToCanonical
} from "../../src/tool-calls/contract.js";

describe("Tool Call v1 contract", () => {
  it("publishes all v1 tools and deterministic contract digests", () => {
    expect(CONTRACT_VERSION).toBe("1.1.0");
    expect(PROTOCOL_VERSION).toBe("1.0.0");
    expect(TOOL_NAMES).toEqual([
      "lc_daily",
      "lc_search",
      "lc_problem",
      "lc_solution_search",
      "lc_solution",
      "lc_profile",
      "lc_contest",
      "lc_progress",
      "lc_history",
      "lc_user_submissions",
      "lc_submission",
      "lc_run",
      "lc_submit",
      "lc_operation_status"
    ]);
    expect(SCHEMA_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(BEHAVIOR_MANIFEST_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(CAPABILITY_MANIFEST_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(STATIC_CAPABILITY_MANIFEST).toMatchObject({
      packageName: "pi-leetcode-tools",
      supportedRegions: ["global", "cn"]
    });
    expect(BEHAVIOR_MANIFEST.gatewayRpcDefaults).toMatchObject({
      "user.status": { region: "global" },
      "notes.search": { region: "cn", limit: 10, skip: 0, orderBy: "DESCENDING" },
      "notes.get": { region: "cn", limit: 10, skip: 0 },
      "notes.create": { region: "cn", title: "" },
      "notes.update": { region: "cn", content: "", title: "" }
    });
    expect(BEHAVIOR_MANIFEST.execution).toEqual({
      defaults: { timeoutMs: 120_000, pollIntervalMs: 1_500 },
      bounds: {
        timeoutMs: { minimum: 1, maximum: 120_000 },
        pollIntervalMs: { minimum: 1, maximum: 5_000, effectiveMinimum: 200 }
      },
      languageAliases: { golang: "go" },
      transientUpstreamEnvelope: {
        fields: ["questionId", "start", "checkUrl", "check"],
        maxJsonBytes: 900_000,
        maxDepth: 16,
        persistence: "never"
      }
    });
    expect(BEHAVIOR_MANIFEST.userNotes).toMatchObject({
      namespace: "current-authenticated-user",
      region: "cn",
      managedNotesPortSeparated: true,
      persistence: "never",
      writeConfirmation: "required-per-call"
    });
    expect(canonicalLanguageToRemote("global", "cangjie")).toBe("cangjie");
  });

  it("maps every pinned upstream execution language in both regions", () => {
    for (const region of ["global", "cn"] as const) {
      for (const upstreamLanguage of UPSTREAM_PROGRAMMING_LANGS) {
        const canonical = remoteLanguageToCanonical(region, upstreamLanguage);
        expect(canonical, `${region}:${upstreamLanguage}`).toBeDefined();
        expect(canonicalLanguageToRemote(region, canonical!)).toBe(upstreamLanguage);
      }
    }
  });

  it("rejects additional properties and bounded input violations", () => {
    expect(Check(SearchInputSchema, { query: "two sum", unexpected: true })).toBe(false);
    expect(Check(SearchInputSchema, { limit: 51 })).toBe(false);
    expect(Check(SubmitInputSchema, {
      titleSlug: "Two Sum",
      language: "typescript",
      code: "return;"
    })).toBe(false);
    expect(Check(HistoryInputSchema, { scope: "account", titleSlug: "two-sum" })).toBe(true);
    expect(Check(SubmissionDetailInputSchema, { submissionId: "not-numeric" })).toBe(false);
    expect(Check(UserNotesSearchInputSchema, { orderBy: "NEWEST" })).toBe(false);
    expect(Check(UserNotesGetInputSchema, { questionId: "two-sum" })).toBe(false);
    expect(Check(UserNotesCreateInputSchema, { questionId: "1", content: "body" })).toBe(true);
    expect(Check(UserNotesUpdateInputSchema, { noteId: "note-1" })).toBe(true);
    expect(Check(SubmitInputSchema, {
      titleSlug: "two-sum",
      language: "typescript",
      code: "return;",
      retryUnknownOperationId: "operation-1",
      resubmitCompletedOperationId: "operation-2"
    })).toBe(false);
    expect(Check(RunInputSchema, {
      titleSlug: "two-sum",
      language: "golang",
      code: "package main",
      timeoutMs: 1,
      pollIntervalMs: 1
    })).toBe(true);
    expect(Check(RunInputSchema, {
      titleSlug: "two-sum",
      language: "golang",
      code: "package main",
      timeoutMs: 0
    })).toBe(false);
  });

  it("publishes public output, descriptor, discovery, and RPC schemas without ledger states", () => {
    const operation = {
      operationId: "operation-global-1",
      kind: "submit",
      state: "queued",
      region: "global",
      titleSlug: "two-sum",
      language: "typescript",
      codeHash: "a".repeat(64),
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:01.000Z"
    };
    expect(Check(OperationStatusSchema, operation)).toBe(true);
    expect(Check(OperationStatusSchema, {
      ...operation,
      remoteId: "submit.1",
      questionId: "1",
      start: { submission_id: "submit.1", accepted: true },
      checkUrl: "https://leetcode.com/submissions/detail/submit.1/check/",
      check: { state: "SUCCESS", status_msg: "Accepted", nested: { value: 1 } }
    })).toBe(true);
    expect(Check(OperationStatusSchema, { ...operation, state: "dispatch_intent" })).toBe(false);
    expect(TOOL_ERROR_CODES).toContain("UNKNOWN_WRITE_OUTCOME");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("schemas.capabilityManifest");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("schemas.staticCapabilityManifest");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("schemas.capabilitySnapshot");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("schemas.diagnosticsSnapshot");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("tools.lc_submit.output");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("tools.lc_user_submissions.output");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("tools.lc_submission.output");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("notes.write.output");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("notes.search.input");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("notes.get.output");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("notes.create.input");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("notes.update.output");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("user.status.input");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("user.status.output");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("discovery.response");
    expect(TOOL_CONTRACT_DOCUMENT).toHaveProperty("rpc.request");
    expect(TOOL_CONTRACT_DOCUMENT.rpc.methods).toBe(GATEWAY_RPC_METHODS);
    expect(GatewayDiscoveryResponseSchema).toHaveProperty("properties.descriptor");
    expect(GatewayRpcRequestSchema).toHaveProperty("properties.respond");
    expect(TOOL_CONTRACT_DOCUMENT.rpc.methods).toContain("user.status");
    expect(TOOL_CONTRACT_DOCUMENT.rpc.methods).toEqual(
      expect.arrayContaining(["notes.search", "notes.get", "notes.create", "notes.update"])
    );
    expect(Check(GatewayRpcMethodSchema, "user.status")).toBe(true);
    expect(Check(GatewayRpcMethodSchema, "diagnostics.getSnapshot")).toBe(true);
  });

  it("distinguishes exact, lower-bound, and unknown totals", () => {
    const base = { offset: 0, limit: 20, hasMore: false };
    expect(Check(PageInfoSchema, { ...base, totalKind: "exact", total: 3 })).toBe(true);
    expect(
      Check(PageInfoSchema, { ...base, totalKind: "lower_bound", total: 3 })
    ).toBe(true);
    expect(Check(PageInfoSchema, { ...base, totalKind: "unknown", total: null })).toBe(true);
    expect(Check(PageInfoSchema, { ...base, totalKind: "unknown", total: 3 })).toBe(false);
    expect(Check(PageInfoSchema, { ...base, total: 3 })).toBe(false);
  });

  it("publishes explicit problem-language selection and diagnostics snapshots", () => {
    const problem = {
      questionId: "1",
      frontendId: "1",
      title: "Two Sum",
      titleSlug: "two-sum",
      difficulty: "easy",
      paidOnly: false,
      topicTags: [],
      content: "Problem",
      defaultTestcase: "  [2,7]\n9\n",
      exampleTestcases: ["[2,7]\n9"],
      availableLanguages: ["go", "python3"],
      selectedCodeSnippet: null,
      enableRunCode: true,
      hints: [],
      similarQuestions: [],
      codeSnippets: []
    };
    expect(Check(ProblemDetailSchema, problem)).toBe(true);
    expect(Check(ProblemDetailSchema, { ...problem, futureRawField: true })).toBe(false);

    const descriptor = {
      packageName: "pi-leetcode-tools",
      providerId: "provider-1",
      instanceId: "instance-1",
      contextRevision: 1,
      packageVersion: "0.1.4",
      contractVersion: "1.1.0",
      protocolVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
      behaviorManifestDigest: `sha256:${"b".repeat(64)}`,
      capabilityManifestDigest: `sha256:${"c".repeat(64)}`,
      snapshotRevision: 2,
      observedAt: "2026-07-15T00:00:00.000Z",
      supportedRegions: ["global", "cn"],
      tools: [],
      notesPort: {
        global: { supported: false, configured: false, currentlyAvailable: false, revisionMode: "unsupported", maxSize: 0 },
        cn: { supported: true, configured: false, currentlyAvailable: false, revisionMode: "best-effort-compare-and-set", maxSize: 16384 }
      },
      regionReadiness: {
        global: { configured: false, publicReads: true, sessionReads: false, execution: false, externalWrite: false, notes: false },
        cn: { configured: false, publicReads: true, sessionReads: false, execution: false, externalWrite: false, notes: false }
      },
      interactiveUI: false
    };
    expect(Check(CapabilitySnapshotSchema, descriptor)).toBe(true);
    expect(
      Check(DiagnosticsSnapshotSchema, {
        packageName: "pi-leetcode-tools",
        packageVersion: "0.1.4",
        contractVersion: "1.1.0",
        protocolVersion: "1.0.0",
        schemaDigest: descriptor.schemaDigest,
        behaviorManifestDigest: descriptor.behaviorManifestDigest,
        capabilityManifestDigest: descriptor.capabilityManifestDigest,
        providerId: "provider-1",
        instanceId: "instance-1",
        contextRevision: 1,
        snapshotRevision: 2,
        observedAt: "2026-07-15T00:00:00.000Z",
        providerConflict: false,
        storageWritable: true,
        regions: {
          global: { configured: false, sessionConfigured: false, operationConfigured: false, queueDepth: 0, queueLimit: 64, circuitState: "closed" },
          cn: { configured: false, sessionConfigured: false, operationConfigured: false, queueDepth: 0, queueLimit: 64, circuitState: "closed" }
        }
      })
    ).toBe(true);
  });

  it("applies documented defaults without changing explicit values", () => {
    expect(normalizeToolInput("lc_search", { query: "two sum" })).toEqual({
      query: "two sum",
      region: "global",
      category: "all-code-essentials",
      limit: 10,
      offset: 0
    });
    expect(normalizeToolInput("lc_run", {
      region: "cn",
      titleSlug: "two-sum",
      language: "typescript",
      code: "return;",
      timeoutMs: 5_000
    })).toMatchObject({
      region: "cn",
      timeoutMs: 5_000,
      pollIntervalMs: 1_500
    });
    expect(normalizeToolInput("lc_submit", {
      titleSlug: "two-sum",
      language: "cpp",
      code: "return;"
    })).toMatchObject({
      region: "global",
      timeoutMs: 120_000,
      pollIntervalMs: 1_500
    });
    expect(normalizeToolInput("lc_history", {})).toEqual({
      region: "global",
      scope: "account",
      limit: 20,
      offset: 0
    });
    expect(normalizeToolInput("lc_progress", {})).toEqual({
      region: "global",
      limit: 100,
      offset: 0
    });
    expect(normalizeToolInput("lc_contest", { username: "public_user" })).toEqual({
      username: "public_user",
      region: "global",
      attendedOnly: true,
      limit: 50,
      offset: 0
    });
    expect(normalizeToolInput("lc_problem", { titleSlug: "two-sum" })).toEqual({
      titleSlug: "two-sum",
      region: "global",
      includeResourcePayload: false
    });
    expect(normalizeToolInput("lc_submission", { submissionId: "123" })).toEqual({
      submissionId: "123",
      region: "global",
      includeCode: false
    });
  });
});
