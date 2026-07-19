import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";

import type { LeetCodeClient } from "./leetcode/client.js";
import { createDefaultLeetCodeClient } from "./leetcode/default-client.js";
import type { CapabilityManifest } from "./types.js";
import {
  createUnavailableResult,
  createToolGateway,
  type ToolGateway
} from "./tool-calls/gateway.js";
import {
  registerGatewayProvider,
  type GatewayProviderRegistration
} from "./tool-calls/provider.js";
import { createLeetCodeTools, type ToolExecutor } from "./tool-calls/registry.js";
import { TOOL_NAMES } from "./tool-calls/contract.js";

export interface LeetCodeClientFactoryContext {
  cwd: string;
  hasUI: boolean;
}

export type LeetCodeClientFactory = (
  context: LeetCodeClientFactoryContext
) => LeetCodeClient | Promise<LeetCodeClient>;

export interface LeetCodeToolsRuntimeOptions {
  createClient?: LeetCodeClientFactory;
}

export type LeetCodeToolsRegistrationResult =
  | { status: "registered" | "already_registered"; names: readonly string[] }
  | { status: "collision"; names: readonly string[] }
  | { status: "failed"; names: readonly string[] };

export type LeetCodeToolsActivationResult =
  | { status: "active"; descriptor: CapabilityManifest }
  | { status: "failed" | "stale" };

export type LeetCodeToolsSessionContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui"
>;

export interface LeetCodeToolsRuntimeController {
  registerTools(): LeetCodeToolsRegistrationResult;
  activate(context: LeetCodeToolsSessionContext): Promise<LeetCodeToolsActivationResult>;
  deactivate(): Promise<void>;
}

interface ActiveRuntime {
  gateway: ToolGateway;
  provider: GatewayProviderRegistration;
}

/**
 * Creates a Tools runtime whose native tool registration and Gateway provider
 * activation are deliberately separate. Pi packages embedding Tools can first
 * negotiate ownership of the lc_* namespace, then activate only the provider
 * they own for the current session.
 */
export function createLeetCodeToolsRuntime(
  pi: ExtensionAPI,
  options: LeetCodeToolsRuntimeOptions = {}
): LeetCodeToolsRuntimeController {
  const createClient = options.createClient ?? (() => createDefaultLeetCodeClient());
  let runtime: ActiveRuntime | undefined;
  let generation = 0;
  let registrationState: "unregistered" | "registered" | "failed" = "unregistered";
  const registeredNames: string[] = [];

  const executor: ToolExecutor = {
    execute(name, input, executeOptions) {
      return runtime?.gateway.execute(name, input, executeOptions) ??
        Promise.resolve(createUnavailableResult(name, input, executeOptions?.requestId));
    }
  };
  const toolDefinitions = createLeetCodeTools(executor);

  async function closeActiveRuntime(): Promise<void> {
    const active = runtime;
    runtime = undefined;
    if (active === undefined) {
      return;
    }

    // Stop accepting discovery/RPC traffic before closing the underlying
    // client. This prevents a request from entering a gateway being torn down.
    active.provider.deactivate();
    await active.gateway.close();
  }

  return {
    registerTools(): LeetCodeToolsRegistrationResult {
      if (registrationState === "registered") {
        return { status: "already_registered", names: [...registeredNames] };
      }
      if (registrationState === "failed") {
        return { status: "failed", names: [...registeredNames] };
      }

      let collisions: string[];
      try {
        const toolNameSet = new Set<string>(TOOL_NAMES);
        collisions = pi.getAllTools()
          .map((tool) => tool.name)
          .filter((name) => toolNameSet.has(name));
      } catch {
        registrationState = "failed";
        return { status: "failed", names: [] };
      }
      if (collisions.length > 0) {
        return { status: "collision", names: [...new Set(collisions)].sort() };
      }

      try {
        for (const tool of toolDefinitions) {
          pi.registerTool(tool);
          registeredNames.push(tool.name);
        }
        registrationState = "registered";
        return { status: "registered", names: [...registeredNames] };
      } catch {
        // Pi has no unregisterTool transaction. Treat any partial registration
        // as permanently failed for this extension instance and never retry or
        // overwrite another tool definition.
        registrationState = "failed";
        return { status: "failed", names: [...registeredNames] };
      }
    },

    async activate(
      context: LeetCodeToolsSessionContext
    ): Promise<LeetCodeToolsActivationResult> {
      if (registrationState !== "registered") {
        return { status: "failed" };
      }

      const currentGeneration = ++generation;
      await closeActiveRuntime();

      let client: LeetCodeClient;
      try {
        client = await createClient({ cwd: context.cwd, hasUI: context.hasUI });
      } catch {
        return { status: "failed" };
      }

      if (currentGeneration !== generation) {
        await client.close();
        return { status: "stale" };
      }

      try {
        const gateway = createToolGateway({
          client,
          interactiveUI: context.hasUI
        });
        const interaction = context.hasUI
          ? {
              hasUI: true as const,
              confirm(title: string, message: string, signal?: AbortSignal) {
                return context.ui.confirm(
                  title,
                  message,
                  signal === undefined ? undefined : { signal }
                );
              }
            }
          : { hasUI: false as const };
        const provider = registerGatewayProvider(pi.events, gateway, { interaction });
        if (currentGeneration !== generation) {
          provider.deactivate();
          await gateway.close();
          return { status: "stale" };
        }
        runtime = { gateway, provider };
        return { status: "active", descriptor: provider.descriptor };
      } catch {
        await client.close();
        return { status: "failed" };
      }
    },

    async deactivate(): Promise<void> {
      generation += 1;
      await closeActiveRuntime();
    }
  };
}
