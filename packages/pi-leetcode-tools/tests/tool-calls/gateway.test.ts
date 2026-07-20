import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";

import { createToolGateway } from "../../src/tool-calls/gateway.js";
import {
  BEHAVIOR_MANIFEST_DIGEST,
  CONTRACT_VERSION,
  DiagnosticsSnapshotSchema,
  PACKAGE_VERSION,
  SCHEMA_DIGEST,
  UserNoteMutationToolResultSchema,
  UserNotesSearchToolResultSchema,
  type ToolName
} from "../../src/tool-calls/contract.js";
import { LeetCodeToolError } from "../../src/leetcode/errors.js";
import { FakeLeetCodeClient } from "./fake-client.js";

const calls: Array<{ name: ToolName; input: Record<string, unknown>; method: string }> = [
  { name: "lc_daily", input: {}, method: "getDaily" },
  { name: "lc_search", input: { query: "two sum" }, method: "searchProblems" },
  { name: "lc_problem", input: { titleSlug: "two-sum" }, method: "getProblem" },
  { name: "lc_profile", input: { username: "public_user" }, method: "getUserProfile" },
  {
    name: "lc_contest",
    input: { username: "public_user" },
    method: "getUserContest"
  },
  { name: "lc_progress", input: {}, method: "getProgress" },
  { name: "lc_history", input: { titleSlug: "two-sum" }, method: "getHistory" },
  {
    name: "lc_user_submissions",
    input: { username: "public_user", mode: "accepted" },
    method: "getUserSubmissions"
  },
  {
    name: "lc_submission",
    input: { submissionId: "123", includeCode: false },
    method: "getSubmissionDetail"
  },
  {
    name: "lc_run",
    input: { titleSlug: "two-sum", language: "typescript", code: "return;" },
    method: "runCode"
  },
  {
    name: "lc_submit",
    input: { titleSlug: "two-sum", language: "typescript", code: "return;" },
    method: "submitCode"
  },
  {
    name: "lc_operation_status",
    input: { operationId: "run-1" },
    method: "getOperationStatus"
  }
];

describe("LeetCodeToolGateway", () => {
  it("emits fresh capability snapshots without changing the context boundary", () => {
    const gateway = createToolGateway({
      client: new FakeLeetCodeClient(),
      interactiveUI: true,
      now: () => new Date("2026-07-15T00:00:00.000Z")
    });

    const first = gateway.getCapabilities();
    const second = gateway.getCapabilities();

    expect(second.snapshotRevision).toBeGreaterThan(first.snapshotRevision);
    expect(Date.parse(second.observedAt)).toBeGreaterThan(Date.parse(first.observedAt));
    expect(second.contextRevision).toBe(first.contextRevision);
    expect(second.behaviorManifestDigest).toBe(BEHAVIOR_MANIFEST_DIGEST);
    expect(second.regionReadiness).toMatchObject({
      global: { publicReads: true, sessionReads: true, execution: true },
      cn: { publicReads: true, sessionReads: true, execution: true, notes: true }
    });
  });

  it("returns bounded diagnostics with monotonic revisions and storage observation", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({
      client,
      interactiveUI: true,
      now: () => new Date("2026-07-15T00:00:00.000Z")
    });
    gateway.updateDiagnosticsQueue("global", 0, 8);
    gateway.updateDiagnosticsQueue("cn", 0, 8);

    const initial = gateway.getDiagnosticsSnapshot();
    expect(Check(DiagnosticsSnapshotSchema, initial)).toBe(true);
    expect(initial).toMatchObject({
      providerConflict: false,
      storageWritable: false,
      contextRevision: 1,
      regions: {
        global: { queueDepth: 0, queueLimit: 8, circuitState: "unknown" },
        cn: { queueDepth: 0, queueLimit: 8, circuitState: "unknown" }
      }
    });

    gateway.updateDiagnosticsQueue("global", 3, 8);
    const queued = gateway.getDiagnosticsSnapshot();
    expect(queued.regions.global.queueDepth).toBe(3);
    expect(queued.snapshotRevision).toBeGreaterThan(initial.snapshotRevision);
    expect(queued.contextRevision).toBe(initial.contextRevision);
    gateway.updateDiagnosticsQueue("global", 0, 8);

    await gateway.execute("lc_run", {
      titleSlug: "two-sum",
      language: "typescript",
      code: "return;"
    });
    const afterRun = gateway.getDiagnosticsSnapshot();
    expect(afterRun.storageWritable).toBe(true);
    expect(afterRun.regions.global.circuitState).toBe("closed");
    expect(afterRun.snapshotRevision).toBeGreaterThan(queued.snapshotRevision);
    expect(afterRun.contextRevision).toBe(initial.contextRevision);
  });

  it("keeps transient circuit and safe-error diagnostics free of messages and details", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({
      client,
      interactiveUI: false,
      now: () => new Date("2026-07-15T00:00:00.000Z")
    });
    gateway.updateDiagnosticsQueue("global", 0, 8);
    client.error = new LeetCodeToolError("REMOTE_UNAVAILABLE", "Remote unavailable", {
      retryable: true,
      retryAfterMs: 1_000,
      details: { circuitOpen: true, unsafe: "secret-canary" }
    });

    await gateway.execute("lc_daily", {});
    const failed = gateway.getDiagnosticsSnapshot();
    expect(failed.regions.global).toMatchObject({
      circuitState: "open",
      lastSafeErrorCode: "REMOTE_UNAVAILABLE",
      nextProbeAt: "2026-07-15T00:00:01.000Z"
    });
    expect(JSON.stringify(failed)).not.toContain("secret-canary");
    expect(JSON.stringify(failed)).not.toContain("Remote unavailable");

    const contextRevision = failed.contextRevision;
    client.error = undefined;
    await gateway.execute("lc_daily", {});
    const recovered = gateway.getDiagnosticsSnapshot();
    expect(recovered.regions.global.circuitState).toBe("closed");
    expect(recovered.regions.global.nextProbeAt).toBeUndefined();
    expect(recovered.contextRevision).toBe(contextRevision);
  });

  it("routes every lc_* tool through the injected client", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: true });
    const confirm = vi.fn(async (_title: string, _message: string) => true);

    for (const call of calls) {
      const result = await gateway.execute(call.name, call.input, {
        requestId: `request-${call.name}`,
        ...(call.name === "lc_submit"
          ? { interaction: { hasUI: true as const, confirm } }
          : {})
      });
      expect(result.ok).toBe(true);
    }

    expect(client.calls.map((call) => call.method)).toEqual(calls.map((call) => call.method));
    expect(client.calls[0]?.input).toBe("global");
    expect(client.calls[1]?.input).toMatchObject({
      region: "global",
      category: "all-code-essentials",
      limit: 10,
      offset: 0
    });
  });

  it("requires a live interaction bridge and binds confirmation to the exact code hash", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: true });
    const input = {
      region: "cn" as const,
      titleSlug: "two-sum",
      language: "typescript",
      code: "const value = 'secret-code';\n"
    };

    const missing = await gateway.execute("lc_submit", input, { requestId: "missing-ui" });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: "INTERACTION_REQUIRED" }
    });
    expect(client.calls).toHaveLength(0);

    const confirm = vi.fn(async (_title: string, _message: string) => true);
    const submitted = await gateway.execute("lc_submit", input, {
      requestId: "confirmed",
      interaction: { hasUI: true, confirm }
    });
    expect(submitted.ok).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    const confirmationText = confirm.mock.calls[0]?.[1] ?? "";
    expect(confirmationText).toContain(
      createHash("sha256").update(input.code, "utf8").digest("hex")
    );
    expect(confirmationText).not.toContain("secret-code");
    expect(client.calls).toHaveLength(1);
  });

  it("rejects mutually exclusive submit recovery references inside the Gateway", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: true });

    await expect(
      gateway.execute("lc_submit", {
        titleSlug: "two-sum",
        language: "typescript",
        code: "return;",
        retryUnknownOperationId: "operation-global-1",
        resubmitCompletedOperationId: "operation-global-2"
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
    expect(client.calls).toHaveLength(0);
  });

  it("keeps arbitrary current-user notes separate and requires redacted per-write confirmation", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: true });

    const searched = await gateway.searchUserNotes({}, { requestId: "notes-search" });
    expect(Check(UserNotesSearchToolResultSchema, searched)).toBe(true);
    expect(searched).toMatchObject({
      ok: true,
      data: {
        filters: { orderBy: "DESCENDING" },
        pagination: { limit: 10, skip: 0 },
        notes: [{ content: "private-note" }]
      },
      meta: { region: "cn", requestId: "notes-search" }
    });
    expect(client.calls.at(-1)).toMatchObject({
      method: "searchUserNotes",
      input: {
        input: { region: "cn", limit: 10, skip: 0, orderBy: "DESCENDING" },
        expectedAccountProfileId: "profile-a"
      }
    });

    const beforeUnsupported = client.calls.length;
    await expect(gateway.getUserNotes({ region: "global", questionId: "1" })).resolves.toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_REGION" },
      meta: { region: "global" }
    });
    expect(client.calls).toHaveLength(beforeUnsupported);

    const input = {
      questionId: "1",
      content: "private-body-canary",
      title: "secret-title-canary"
    };
    await expect(gateway.createUserNote(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERACTION_REQUIRED" }
    });
    expect(client.calls).toHaveLength(beforeUnsupported);

    const confirm = vi.fn(async (_title: string, _message: string) => true);
    const created = await gateway.createUserNote(input, {
      requestId: "notes-create",
      interaction: { hasUI: true, confirm }
    });
    expect(Check(UserNoteMutationToolResultSchema, created)).toBe(true);
    expect(created).toMatchObject({
      ok: true,
      data: { success: true, note: { content: input.content, targetId: "1" } },
      meta: { region: "cn", requestId: "notes-create" }
    });
    const confirmation = confirm.mock.calls[0]?.[1] ?? "";
    expect(confirmation).toContain(
      createHash("sha256").update(input.content, "utf8").digest("hex")
    );
    expect(confirmation).toContain(
      createHash("sha256").update(input.title, "utf8").digest("hex")
    );
    expect(confirmation).not.toContain(input.content);
    expect(confirmation).not.toContain(input.title);
    expect(client.calls.at(-1)).toMatchObject({
      method: "createUserNote",
      input: {
        input: { region: "cn", ...input },
        expectedAccountProfileId: "profile-a"
      }
    });
    expect(JSON.stringify(gateway.getDiagnosticsSnapshot())).not.toContain(input.content);
    expect(JSON.stringify(gateway.getDiagnosticsSnapshot())).not.toContain(input.title);
  });

  it("serves authenticated user status outside the model tool namespace with strict lifecycle checks", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: false });

    const status = await gateway.getUserStatus({}, { requestId: "status-global" });
    expect(status).toMatchObject({
      ok: true,
      data: { isSignedIn: true, username: "active_user", isAdmin: false },
      meta: {
        region: "global",
        requestId: "status-global",
        instanceId: "instance-1",
        contextRevision: 1,
        accountProfileId: "profile-a"
      }
    });
    expect(client.calls.at(-1)).toMatchObject({ method: "getUserStatus", input: "global" });

    const callsBeforeInvalid = client.calls.length;
    await expect(gateway.getUserStatus({ region: "cn", extra: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
      meta: { region: "cn" }
    });
    expect(client.calls).toHaveLength(callsBeforeInvalid);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      gateway.getUserStatus({ region: "cn" }, { signal: aborted.signal })
    ).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(client.calls).toHaveLength(callsBeforeInvalid);

    gateway.setProviderConflict(true);
    await expect(gateway.getUserStatus({})).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CONFLICT" }
    });
    expect(client.calls).toHaveLength(callsBeforeInvalid);
  });

  it("preserves client normalization metadata while rebinding the gateway request tuple", async () => {
    const client = new FakeLeetCodeClient();
    client.result = {
      ok: true,
      data: { username: "public_user", history: [] },
      meta: {
        region: "global",
        packageVersion: PACKAGE_VERSION,
        contractVersion: CONTRACT_VERSION,
        schemaDigest: SCHEMA_DIGEST,
        behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
        instanceId: "client-instance",
        contextRevision: 0,
        requestId: "client-request",
        durationMs: 42,
        truncated: true,
        omittedFields: ["/history"]
      }
    };
    const gateway = createToolGateway({ client, interactiveUI: false });

    const result = await gateway.execute(
      "lc_contest",
      { username: "public_user" },
      { requestId: "gateway-request" }
    );

    expect(result.meta).toMatchObject({
      requestId: "gateway-request",
      instanceId: "instance-1",
      contextRevision: 1,
      durationMs: 42,
      truncated: true,
      omittedFields: ["/history"]
    });
  });

  it("rejects invalid input before delegation and redacts unexpected thrown errors", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: false });

    const invalid = await gateway.execute("lc_problem", {
      titleSlug: "../../unsafe",
      extra: "secret"
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(client.calls).toHaveLength(0);

    const invalidHistory = await gateway.execute("lc_history", {
      scope: "account",
      titleSlug: "two-sum"
    });
    expect(invalidHistory).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
    expect(client.calls).toHaveLength(0);

    client.error = new Error("LEETCODE_SESSION=secret-canary");
    const failed = await gateway.execute("lc_daily", {}, { requestId: "request-safe" });
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "REMOTE_UNAVAILABLE",
        message: "LeetCode request failed",
        retryable: true
      }
    });
    expect(JSON.stringify(failed)).not.toContain("secret-canary");
  });

  it("aborts the shared lifecycle and closes the client once", async () => {
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: false });
    await gateway.execute("lc_daily", {});
    const delegatedSignal = client.calls[0]?.signal;

    await Promise.all([gateway.close(), gateway.close()]);
    expect(delegatedSignal?.aborted).toBe(true);
    expect(client.closeCount).toBe(1);
    await expect(gateway.execute("lc_daily", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "CANCELLED" }
    });
  });
});
