import { describe, expect, it, vi } from "vitest";

import {
  importCredentialsFromTerminal,
  readHiddenTerminalValue
} from "../src/cli/auth-input.js";

describe("local credential import", () => {
  it("opens only the default login page and obtains both values through a secret reader", async () => {
    const openBrowser = vi.fn(async () => undefined);
    const prompts: string[] = [];
    const values = ["terminal-session", "terminal-csrf"];
    const readSecret = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return values.shift() ?? "";
    });
    const statuses: string[] = [];

    await expect(
      importCredentialsFromTerminal("cn", {
        openBrowser,
        readSecret,
        onStatus: (message) => statuses.push(message)
      })
    ).resolves.toEqual({ session: "terminal-session", csrfToken: "terminal-csrf" });
    expect(openBrowser).toHaveBeenCalledWith("cn");
    expect(prompts).toEqual([
      "LEETCODE_SESSION (hidden): ",
      "csrftoken (hidden): "
    ]);
    expect(statuses.join("\n")).not.toContain("terminal-session");
    expect(statuses.join("\n")).not.toContain("terminal-csrf");
  });

  it("refuses piped or invisible input instead of accepting secrets from shell history", async () => {
    const input = {
      isTTY: false,
      setRawMode: vi.fn()
    } as unknown as NodeJS.ReadStream;
    const output = { isTTY: false } as unknown as NodeJS.WriteStream;

    await expect(
      readHiddenTerminalValue("hidden: ", input, output)
    ).rejects.toMatchObject({ code: "auth_tty_required" });
    expect(input.setRawMode).not.toHaveBeenCalled();
  });
});
