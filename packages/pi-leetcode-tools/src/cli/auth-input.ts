import { spawn } from "node:child_process";

import { AuthError } from "../runtime/auth-errors.js";
import { AUTH_LOGIN_URL } from "../runtime/auth-lifecycle.js";
import { validateStoredCredentialInput, type StoredCredentialInput } from "../runtime/stored-credentials.js";
import type { Region } from "../types.js";

export type SecretReader = (prompt: string) => Promise<string>;

export async function openDefaultLoginBrowser(region: Region): Promise<void> {
  const url = AUTH_LOGIN_URL[region];
  const launch =
    process.platform === "win32"
      ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { command: "open", args: [url] }
        : { command: "xdg-open", args: [url] };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(
        new AuthError(
          "auth_browser_open_failed",
          "The system default browser could not be opened",
          { cause: error }
        )
      );
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

export async function readHiddenTerminalValue(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new AuthError(
      "auth_tty_required",
      "Credential import requires a visible interactive terminal"
    );
  }

  output.write(prompt);
  const bytes: number[] = [];
  const wasRaw = input.isRaw;
  try {
    input.setRawMode(true);
    input.resume();
  } catch (error) {
    try {
      input.setRawMode(Boolean(wasRaw));
    } catch {}
    throw new AuthError("auth_tty_required", "The terminal could not enter hidden-input mode", {
      cause: error
    });
  }

  return await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode(Boolean(wasRaw));
      output.write("\n");
    };
    const finish = () => {
      cleanup();
      resolve(Buffer.from(bytes).toString("utf8"));
    };
    const cancel = () => {
      cleanup();
      reject(new AuthError("auth_import_cancelled", "Credential import was cancelled"));
    };
    const onEnd = () => cancel();
    const onError = (error: Error) => {
      cleanup();
      reject(new AuthError("auth_import_cancelled", "Credential import was interrupted", {
        cause: error
      }));
    };
    const onData = (chunk: string | Buffer) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const byte of data) {
        if (byte === 3) {
          cancel();
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          bytes.pop();
          continue;
        }
        if (byte >= 32) {
          if (bytes.length >= 16_384) {
            cleanup();
            reject(
              new AuthError(
                "auth_credentials_incomplete",
                "The imported credential exceeds the supported size"
              )
            );
            return;
          }
          bytes.push(byte);
        }
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

export async function importCredentialsFromTerminal(
  region: Region,
  options: {
    openBrowser?: (region: Region) => Promise<void>;
    readSecret?: SecretReader;
    onStatus?: (message: string) => void;
  } = {}
): Promise<StoredCredentialInput> {
  await (options.openBrowser ?? openDefaultLoginBrowser)(region);
  options.onStatus?.(
    "Sign in in the default browser, then copy only the target region's two cookie values into this local terminal."
  );
  const readSecret = options.readSecret ?? readHiddenTerminalValue;
  const session = await readSecret("LEETCODE_SESSION (hidden): ");
  const csrfToken = await readSecret("csrftoken (hidden): ");
  const credentials = validateStoredCredentialInput({ session, csrfToken });
  if (credentials.csrfToken.length === 0) {
    throw new AuthError(
      "auth_credentials_incomplete",
      "A complete session and CSRF credential bundle is required"
    );
  }
  return credentials;
}
