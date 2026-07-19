import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import {
  DiagnosticsSnapshotResultSchema,
  DISCOVERY_CHANNEL,
  PROTOCOL_VERSION,
  RPC_CHANNEL,
  UserNoteMutationToolResultSchema,
  UserNotesSearchToolResultSchema,
  UserStatusResultSchema
} from "../../src/tool-calls/contract.js";
import { createToolGateway } from "../../src/tool-calls/gateway.js";
import {
  aggregateGatewayDiscoveryResponses,
  registerGatewayProvider,
  type GatewayDiscoveryResponse,
  type GatewayRpcRequest,
  type GatewayRpcResponse
} from "../../src/tool-calls/provider.js";
import { FakeLeetCodeClient } from "./fake-client.js";

function discover(events: ReturnType<typeof createEventBus>): GatewayDiscoveryResponse[] {
  const responses: GatewayDiscoveryResponse[] = [];
  events.emit(DISCOVERY_CHANNEL, {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "discover-1",
    respond(response: GatewayDiscoveryResponse) {
      responses.push(response);
    }
  });
  return responses;
}

function rpc(
  events: ReturnType<typeof createEventBus>,
  request: Partial<GatewayRpcRequest> & Pick<GatewayRpcRequest, "method" | "params">
): Promise<GatewayRpcResponse> {
  return new Promise((resolve) => {
    events.emit(RPC_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "rpc-1",
      providerId: "pi-leetcode-tools",
      instanceId: "instance-1",
      contextRevision: 1,
      deadlineAt: Date.now() + 5_000,
      ...request,
      respond: resolve
    } satisfies GatewayRpcRequest);
  });
}

describe("Gateway event-bus provider", () => {
  it("routes the four CN current-user notes RPCs and bridges confirmation only for writes", async () => {
    const events = createEventBus();
    const client = new FakeLeetCodeClient();
    const confirm = vi.fn(async (_title: string, _message: string) => true);
    registerGatewayProvider(events, createToolGateway({ client, interactiveUI: true }), {
      interaction: { hasUI: true, confirm }
    });

    const searched = await rpc(events, {
      requestId: "rpc-notes-search",
      method: "notes.search",
      params: { keyword: "hash" }
    });
    expect(Check(UserNotesSearchToolResultSchema, searched.result)).toBe(true);
    expect(searched.result).toMatchObject({ ok: true, meta: { region: "cn" } });

    const got = await rpc(events, {
      requestId: "rpc-notes-get",
      method: "notes.get",
      params: { questionId: "1" }
    });
    expect(got.result).toMatchObject({ ok: true, data: { questionId: "1" } });

    const created = await rpc(events, {
      requestId: "rpc-notes-create",
      method: "notes.create",
      params: { questionId: "1", content: "private-create-canary" }
    });
    expect(Check(UserNoteMutationToolResultSchema, created.result)).toBe(true);

    const updated = await rpc(events, {
      requestId: "rpc-notes-update",
      method: "notes.update",
      params: { noteId: "note-1", content: "private-update-canary" }
    });
    expect(Check(UserNoteMutationToolResultSchema, updated.result)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]?.[1]).not.toContain("private-create-canary");
    expect(confirm.mock.calls[1]?.[1]).not.toContain("private-update-canary");
    expect(client.calls.map((call) => call.method)).toEqual([
      "searchUserNotes",
      "getUserNotes",
      "createUserNote",
      "updateUserNote"
    ]);
  });

  it("serves the non-model diagnostics RPC only with empty params", async () => {
    const events = createEventBus();
    const client = new FakeLeetCodeClient();
    registerGatewayProvider(events, createToolGateway({ client, interactiveUI: true }));

    const response = await rpc(events, {
      requestId: "rpc-diagnostics",
      method: "diagnostics.getSnapshot",
      params: {}
    });
    expect(Check(DiagnosticsSnapshotResultSchema, response.result)).toBe(true);
    expect(response.result).toMatchObject({
      ok: true,
      data: {
        providerConflict: false,
        storageWritable: false,
        regions: {
          global: { queueDepth: 0, queueLimit: 8 },
          cn: { queueDepth: 0, queueLimit: 8 }
        }
      }
    });
    expect(client.calls).toHaveLength(0);

    const invalid = await rpc(events, {
      requestId: "rpc-diagnostics-invalid",
      method: "diagnostics.getSnapshot",
      params: { includeSecrets: true }
    });
    expect(invalid.result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
    expect(client.calls).toHaveLength(0);
  });

  it("serves authenticated user.status as a strict non-model RPC", async () => {
    const events = createEventBus();
    const client = new FakeLeetCodeClient();
    registerGatewayProvider(events, createToolGateway({ client, interactiveUI: false }));

    const response = await rpc(events, {
      requestId: "rpc-user-status",
      method: "user.status",
      params: { region: "cn" }
    });
    expect(Check(UserStatusResultSchema, response.result)).toBe(true);
    expect(response.result).toMatchObject({
      ok: true,
      data: { isSignedIn: true, username: "active_user", isAdmin: false },
      meta: { region: "cn", requestId: "rpc-user-status" }
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ method: "getUserStatus", input: "cn" });

    const invalid = await rpc(events, {
      requestId: "rpc-user-status-invalid",
      method: "user.status",
      params: { region: "global", includeCookie: true }
    });
    expect(invalid.result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
    expect(client.calls).toHaveLength(1);
  });

  it("deduplicates discovery by provider and instance and exposes no winner on conflict", () => {
    const events = createEventBus();
    const first = registerGatewayProvider(
      events,
      createToolGateway({ client: new FakeLeetCodeClient("instance-1"), interactiveUI: false })
    );
    const second = registerGatewayProvider(
      events,
      createToolGateway({ client: new FakeLeetCodeClient("instance-2"), interactiveUI: false })
    );
    const responses = discover(events);

    const conflict = aggregateGatewayDiscoveryResponses(responses);
    expect(conflict).toMatchObject({ status: "conflict", conflict: true });
    expect(conflict.descriptors).toHaveLength(2);
    expect(conflict.descriptor).toBeUndefined();

    const unique = aggregateGatewayDiscoveryResponses([responses[0]!, responses[0]!]);
    expect(unique).toMatchObject({ status: "unique", conflict: false });
    expect(unique.descriptors).toHaveLength(1);
    expect(unique.descriptor?.instanceId).toBe("instance-1");

    second.deactivate();
    first.deactivate();
  });

  it("supports versioned discovery and correlated RPC", async () => {
    const events = createEventBus();
    const client = new FakeLeetCodeClient();
    const gateway = createToolGateway({ client, interactiveUI: true });
    registerGatewayProvider(events, gateway);

    const discovery = discover(events);
    expect(discovery).toHaveLength(1);
    expect(discovery[0]).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "discover-1",
      descriptor: {
        providerId: gateway.getCapabilities().providerId,
        instanceId: gateway.getCapabilities().instanceId,
        contextRevision: gateway.getCapabilities().contextRevision
      }
    });

    const response = await rpc(events, {
      requestId: "rpc-daily",
      method: "tool.execute",
      params: { tool: "lc_daily", input: {} }
    });
    expect(response).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "rpc-daily",
      instanceId: "instance-1",
      contextRevision: 1,
      result: { ok: true }
    });
    expect(client.calls[0]?.method).toBe("getDaily");
  });

  it("rejects stale context, expired deadlines, and submit without Tools-owned UI", async () => {
    const events = createEventBus();
    const client = new FakeLeetCodeClient();
    registerGatewayProvider(events, createToolGateway({ client, interactiveUI: true }));

    const stale = await rpc(events, {
      requestId: "rpc-stale",
      contextRevision: 0,
      method: "tool.execute",
      params: { tool: "lc_daily", input: {} }
    });
    expect(stale.result).toMatchObject({
      ok: false,
      error: { code: "STALE_OPERATION" }
    });

    const expired = await rpc(events, {
      requestId: "rpc-expired",
      deadlineAt: Date.now() - 1,
      method: "tool.execute",
      params: { tool: "lc_daily", input: {} }
    });
    expect(expired.result).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_TIMEOUT" }
    });

    const submit = await rpc(events, {
      requestId: "rpc-submit",
      method: "tool.execute",
      params: {
        tool: "lc_submit",
        input: { titleSlug: "two-sum", language: "typescript", code: "return;" }
      },
      interaction: { hasUI: true, confirm: async () => true }
    } as Partial<GatewayRpcRequest> & Pick<GatewayRpcRequest, "method" | "params">);
    expect(submit.result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" }
    });
    expect(client.calls).toHaveLength(0);
  });

  it("uses only the provider-owned interaction bridge for submit", async () => {
    const events = createEventBus();
    const client = new FakeLeetCodeClient();
    const confirm = vi.fn(async () => true);
    registerGatewayProvider(events, createToolGateway({ client, interactiveUI: true }), {
      interaction: { hasUI: true, confirm }
    });

    const submit = await rpc(events, {
      method: "tool.execute",
      params: {
        tool: "lc_submit",
        input: { titleSlug: "two-sum", language: "typescript", code: "return;" }
      }
    });
    expect(submit.result.ok).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(client.calls).toHaveLength(1);
  });

  it("fails closed across native and RPC paths while multiple providers are active", async () => {
    const events = createEventBus();
    const client1 = new FakeLeetCodeClient("instance-1");
    const client2 = new FakeLeetCodeClient("instance-2");
    const gateway1 = createToolGateway({ client: client1, interactiveUI: true });
    const gateway2 = createToolGateway({ client: client2, interactiveUI: true });
    const first = registerGatewayProvider(events, gateway1);
    const second = registerGatewayProvider(events, gateway2);

    await expect(gateway1.execute("lc_daily", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CONFLICT" }
    });
    const conflicted = await rpc(events, {
      method: "tool.execute",
      params: { tool: "lc_daily", input: {} }
    });
    expect(conflicted.result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CONFLICT" }
    });
    expect(client1.calls).toHaveLength(0);
    expect(client2.calls).toHaveLength(0);

    second.deactivate();
    await expect(gateway1.execute("lc_daily", {})).resolves.toMatchObject({ ok: true });
    first.deactivate();
  });

  it("does not execute diagnostics for a selected provider while discovery is conflicted", async () => {
    const events = createEventBus();
    const gateway1 = createToolGateway({
      client: new FakeLeetCodeClient("instance-1"),
      interactiveUI: false
    });
    const gateway2 = createToolGateway({
      client: new FakeLeetCodeClient("instance-2"),
      interactiveUI: false
    });
    const snapshot1 = vi.spyOn(gateway1, "getDiagnosticsSnapshot");
    const snapshot2 = vi.spyOn(gateway2, "getDiagnosticsSnapshot");
    const first = registerGatewayProvider(events, gateway1);
    const second = registerGatewayProvider(events, gateway2);

    const response = await rpc(events, {
      requestId: "rpc-conflicted-diagnostics",
      method: "diagnostics.getSnapshot",
      params: {}
    });
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CONFLICT" }
    });
    expect(snapshot1).not.toHaveBeenCalled();
    expect(snapshot2).not.toHaveBeenCalled();

    second.deactivate();
    first.deactivate();
  });

  it("unsubscribes discovery and RPC handlers when deactivated", async () => {
    const events = createEventBus();
    const registration = registerGatewayProvider(
      events,
      createToolGateway({ client: new FakeLeetCodeClient(), interactiveUI: false })
    );
    registration.deactivate();

    expect(discover(events)).toEqual([]);
    const respond = vi.fn();
    events.emit(RPC_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "rpc-after-close",
      providerId: "pi-leetcode-tools",
      instanceId: "instance-1",
      contextRevision: 1,
      method: "tool.execute",
      params: { tool: "lc_daily", input: {} },
      deadlineAt: Date.now() + 1_000,
      respond
    } satisfies GatewayRpcRequest);
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
  });
});
