import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  BEHAVIOR_MANIFEST_DIGEST,
  CONTRACT_VERSION,
  TOOL_NAMES
} from "../../src/tool-calls/contract.js";
import { createLeetCodeTools, type ToolExecutor } from "../../src/tool-calls/registry.js";
import type { ToolMeta, ToolResult } from "../../src/types.js";
import { createManifest } from "./fake-client.js";

function context(hasUI: boolean): ExtensionContext {
  return {
    hasUI,
    ui: {
      confirm: vi.fn(async () => true)
    }
  } as unknown as ExtensionContext;
}

function meta(interactiveUI = false): ToolMeta {
  const manifest = createManifest(interactiveUI);
  return {
    region: "global",
    packageVersion: manifest.packageVersion,
    contractVersion: CONTRACT_VERSION,
    schemaDigest: manifest.schemaDigest,
    behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
    instanceId: manifest.instanceId,
    contextRevision: manifest.contextRevision,
    ...(manifest.activeAccountProfileId === undefined
      ? {}
      : { accountProfileId: manifest.activeAccountProfileId }),
    requestId: "request-1"
  };
}

describe("Pi model tool adapter", () => {
  it("registers exactly the contract lc_* tools and keeps diagnostics non-model-facing", () => {
    const executor: ToolExecutor = {
      execute: async () => ({ ok: true, data: {}, meta: meta() })
    };

    expect(createLeetCodeTools(executor).map(({ name }) => name)).toEqual(TOOL_NAMES);
    expect(createLeetCodeTools(executor).some(({ name }) => name.includes("diagnostic"))).toBe(
      false
    );
    expect(createLeetCodeTools(executor).some(({ name }) => name === "user.status")).toBe(false);
  });

  it("returns successful Gateway envelopes as content and details", async () => {
    const result: ToolResult<unknown> = {
      ok: true,
      data: { date: "2026-07-15" },
      meta: meta()
    };
    const executor: ToolExecutor = { execute: async () => result };
    const tool = createLeetCodeTools(executor).find(({ name }) => name === "lc_daily");

    const output = await tool?.execute("tool-call-1", {}, undefined, undefined, context(false));
    expect(output?.details).toEqual(result);
    expect(output?.content).toEqual([{ type: "text", text: JSON.stringify(result) }]);
  });

  it("throws only the safe failure code and message to the model", async () => {
    const result: ToolResult<unknown> = {
      ok: false,
      error: {
        code: "AUTH_REQUIRED",
        message: "Authentication is required",
        retryable: false,
        details: { unsafe: "secret-canary" }
      },
      meta: meta()
    };
    const executor: ToolExecutor = { execute: async () => result };
    const tool = createLeetCodeTools(executor).find(({ name }) => name === "lc_progress");

    await expect(
      tool?.execute("tool-call-1", {}, undefined, undefined, context(false))
    ).rejects.toThrow("AUTH_REQUIRED: Authentication is required");
    await expect(
      tool?.execute("tool-call-2", {}, undefined, undefined, context(false))
    ).rejects.not.toThrow("secret-canary");
  });

  it("passes the current Pi UI confirmation as a per-call bridge", async () => {
    const calls: Array<Parameters<ToolExecutor["execute"]>> = [];
    const execute: ToolExecutor["execute"] = async (...args) => {
      calls.push(args);
      return { ok: true, data: {}, meta: meta(true) };
    };
    const tool = createLeetCodeTools({ execute }).find(({ name }) => name === "lc_submit");
    const ctx = context(true);

    await tool?.execute(
      "tool-call-1",
      { titleSlug: "two-sum", language: "typescript", code: "return;" },
      undefined,
      undefined,
      ctx
    );

    const bridge = calls[0]?.[2]?.interaction;
    expect(bridge).toMatchObject({ hasUI: true });
    if (bridge?.hasUI === true) {
      await bridge.confirm("Confirm", "Message");
    }
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Confirm", "Message", undefined);
  });
});
