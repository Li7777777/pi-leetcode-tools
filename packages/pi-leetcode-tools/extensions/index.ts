import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  createLeetCodeToolsRuntime,
  type LeetCodeToolsRuntimeOptions
} from "../src/embedded.js";

export type LeetCodeToolsExtensionOptions = LeetCodeToolsRuntimeOptions;

export function createLeetCodeToolsExtension(
  options: LeetCodeToolsExtensionOptions = {}
): ExtensionFactory {
  return function installLeetCodeTools(pi: ExtensionAPI): void {
    const runtime = createLeetCodeToolsRuntime(pi, options);

    pi.on("session_start", async (_event, ctx) => {
      // Pi binds getAllTools()/refreshTools only after extension factories
      // finish loading. Claim the namespace at session start, when collision
      // detection and dynamic registration are both available.
      const registration = runtime.registerTools();
      if (registration.status === "failed" || registration.status === "collision") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "pi-leetcode-tools did not activate because the lc_* tool namespace is not exclusively available.",
            "error"
          );
        }
        return;
      }
      const activation = await runtime.activate(ctx);
      if (activation.status === "failed" && ctx.hasUI) {
        ctx.ui.notify("pi-leetcode-tools could not activate its Gateway.", "error");
      }
    });

    pi.on("session_shutdown", async () => {
      await runtime.deactivate();
    });
  };
}

export default createLeetCodeToolsExtension();
