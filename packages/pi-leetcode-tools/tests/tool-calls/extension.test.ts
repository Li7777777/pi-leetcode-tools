import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createLeetCodeToolsExtension } from "../../extensions/index.js";
import { createLeetCodeToolsRuntime } from "../../src/embedded.js";
import {
  DISCOVERY_CHANNEL,
  PROTOCOL_VERSION,
  TOOL_NAMES
} from "../../src/tool-calls/contract.js";
import type { GatewayDiscoveryResponse } from "../../src/tool-calls/provider.js";
import { FakeLeetCodeClient } from "./fake-client.js";

describe("LeetCode tools extension lifecycle", () => {
  it("creates one session runtime and removes provider subscriptions on shutdown", async () => {
    const events = createEventBus();
    const tools: string[] = [];
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const pi = {
      events,
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      getAllTools() {
        return tools.map((name) => ({ name }));
      },
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      }
    } as unknown as ExtensionAPI;
    const client = new FakeLeetCodeClient();
    createLeetCodeToolsExtension({ createClient: () => client })(pi);

    expect(tools).toEqual([]);
    const ctx = {
      cwd: "E:/workspace",
      hasUI: false,
      ui: { notify: vi.fn() }
    } as unknown as ExtensionContext;
    await handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      ctx
    );
    expect(tools).toEqual(TOOL_NAMES);

    const before: GatewayDiscoveryResponse[] = [];
    events.emit(DISCOVERY_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "before-shutdown",
      respond: (response: GatewayDiscoveryResponse) => before.push(response)
    });
    expect(before).toHaveLength(1);

    await handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      ctx
    );
    const after: GatewayDiscoveryResponse[] = [];
    events.emit(DISCOVERY_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "after-shutdown",
      respond: (response: GatewayDiscoveryResponse) => after.push(response)
    });
    expect(after).toEqual([]);
    expect(client.closeCount).toBe(1);
  });

  it("reuses one registered tool surface across session reloads", async () => {
    const events = createEventBus();
    const tools: string[] = [];
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const clients = [new FakeLeetCodeClient(), new FakeLeetCodeClient()];
    let nextClient = 0;
    const createClient = vi.fn(() => clients[nextClient++]!);
    const pi = {
      events,
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      getAllTools() {
        return tools.map((name) => ({ name }));
      },
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      }
    } as unknown as ExtensionAPI;
    createLeetCodeToolsExtension({ createClient })(pi);
    const context = {
      cwd: "E:/workspace",
      hasUI: false,
      ui: { notify: vi.fn() }
    } as unknown as ExtensionContext;

    await handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      context
    );
    await handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "reload" },
      context
    );
    await handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "reload" },
      context
    );

    const responses: GatewayDiscoveryResponse[] = [];
    events.emit(DISCOVERY_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "after-reload",
      respond: (response: GatewayDiscoveryResponse) => responses.push(response)
    });
    expect(responses).toHaveLength(1);
    expect(tools).toEqual(TOOL_NAMES);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(clients[0]!.closeCount).toBe(1);

    await handlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      context
    );
    expect(clients[1]!.closeCount).toBe(1);
  });

  it("does not overwrite or activate when any lc_* tool name is already registered", async () => {
    const events = createEventBus();
    const registered: string[] = [];
    const notifications: string[] = [];
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const createClient = vi.fn(() => new FakeLeetCodeClient());
    const pi = {
      events,
      getAllTools: () => [{ name: "lc_daily" }],
      registerTool(tool: { name: string }) {
        registered.push(tool.name);
      },
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        const current = handlers.get(event) ?? [];
        current.push(handler);
        handlers.set(event, current);
      }
    } as unknown as ExtensionAPI;

    createLeetCodeToolsExtension({ createClient })(pi);
    const context = {
      cwd: "E:/workspace",
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) }
    } as unknown as ExtensionContext;
    await handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      context
    );

    expect(registered).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
    expect(notifications.join("\n")).toContain("namespace is not exclusively available");
    const responses: GatewayDiscoveryResponse[] = [];
    events.emit(DISCOVERY_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "collision",
      respond: (response: GatewayDiscoveryResponse) => responses.push(response)
    });
    expect(responses).toEqual([]);
  });

  it("closes a client whose async activation loses a shutdown race", async () => {
    const events = createEventBus();
    const tools: string[] = [];
    const pi = {
      events,
      getAllTools: () => tools.map((name) => ({ name })),
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      }
    } as unknown as ExtensionAPI;
    const client = new FakeLeetCodeClient();
    let resolveClient!: (value: FakeLeetCodeClient) => void;
    const clientPromise = new Promise<FakeLeetCodeClient>((resolve) => {
      resolveClient = resolve;
    });
    const runtime = createLeetCodeToolsRuntime(pi, { createClient: () => clientPromise });
    expect(runtime.registerTools().status).toBe("registered");
    expect(runtime.registerTools().status).toBe("already_registered");

    const context = {
      cwd: "E:/workspace",
      hasUI: false,
      ui: {}
    } as unknown as ExtensionContext;
    const activation = runtime.activate(context);
    const deactivation = runtime.deactivate();
    resolveClient(client);

    await expect(activation).resolves.toEqual({ status: "stale" });
    await deactivation;
    expect(client.closeCount).toBe(1);
  });

  it("does not activate a provider before the complete native tool surface is registered", async () => {
    const events = createEventBus();
    const createClient = vi.fn(() => new FakeLeetCodeClient());
    const pi = {
      events,
      getAllTools: () => [],
      registerTool: vi.fn()
    } as unknown as ExtensionAPI;
    const runtime = createLeetCodeToolsRuntime(pi, { createClient });
    const context = {
      cwd: "E:/workspace",
      hasUI: false,
      ui: {}
    } as unknown as ExtensionContext;

    await expect(runtime.activate(context)).resolves.toEqual({ status: "failed" });
    expect(createClient).not.toHaveBeenCalled();
  });
});
