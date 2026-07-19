import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import {
  AuthError,
  DEFAULT_CREDENTIAL_STORE_SERVICE,
  OsKeyringCredentialStore,
  type KeyringEntry
} from "../src/runtime/index.js";

class CliKeyring implements KeyringEntry {
  static readonly values = new Map<string, string>();
  readonly key: string;

  constructor(service: string, account: string) {
    expect(service).toBe(DEFAULT_CREDENTIAL_STORE_SERVICE);
    this.key = account;
  }

  getPassword(): string | null {
    return CliKeyring.values.get(this.key) ?? null;
  }

  setPassword(password: string): void {
    CliKeyring.values.set(this.key, password);
  }

  deletePassword(): boolean {
    return CliKeyring.values.delete(this.key);
  }
}

function createStore(): OsKeyringCredentialStore {
  CliKeyring.values.clear();
  let revision = 0;
  return new OsKeyringCredentialStore({
    entryFactory: (service, account) => new CliKeyring(service, account),
    revisionFactory: () => `revision-${++revision}`
  });
}

describe("pi-leetcode CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the complete frozen auth command surface without opening external resources", async () => {
    const lines: string[] = [];

    await expect(runCli(["--help"], { writeLine: (line) => lines.push(line) })).resolves.toBe(0);

    expect(lines.join("\n")).toContain("auth login");
    expect(lines.join("\n")).toContain("auth import");
    expect(lines.join("\n")).toContain("auth status");
    expect(lines.join("\n")).toContain("auth list");
    expect(lines.join("\n")).toContain("auth use");
    expect(lines.join("\n")).toContain("auth logout");
    expect(lines.join("\n")).toContain("auth doctor");
  });

  it("returns stable validation codes before accessing the credential store", async () => {
    const createCredentialStore = vi.fn(() => createStore());
    await expect(runCli(["login"], { createCredentialStore })).rejects.toMatchObject({
      code: "auth_invalid_arguments"
    });
    await expect(
      runCli(["auth", "login", "--region", "unknown"], { createCredentialStore })
    ).rejects.toMatchObject({ code: "auth_region_invalid" });
    await expect(
      runCli(["auth", "use", "--profile", "../unsafe"], { createCredentialStore })
    ).rejects.toMatchObject({ code: "auth_profile_invalid" });
    expect(createCredentialStore).not.toHaveBeenCalled();
  });

  it("probes before a forced replacement and preserves the old bundle on rejection", async () => {
    const store = createStore();
    store.replace(
      "work",
      "cn",
      { session: "old-session", csrfToken: "old-csrf" },
      { activate: true }
    );
    const login = vi.fn(async () => ({
      session: "candidate-session",
      csrfToken: "candidate-csrf"
    }));
    const rejectedProbe = vi.fn(async () => {
      throw new AuthError("auth_probe_rejected", "LeetCode rejected the supplied credentials");
    });

    await expect(
      runCli(
        ["auth", "login", "--region", "cn", "--profile", "work", "--force"],
        {
          createCredentialStore: () => store,
          login,
          probe: rejectedProbe
        }
      )
    ).rejects.toMatchObject({ code: "auth_probe_rejected" });
    expect(store.get("work", "cn")).toMatchObject({
      session: "old-session",
      csrfToken: "old-csrf"
    });
    expect(store.getActiveProfileId()).toBe("work");
  });

  it("refuses an existing bundle without force before launching the browser", async () => {
    const store = createStore();
    store.set("work", "global", { session: "old-session", csrfToken: "old-csrf" });
    const login = vi.fn(async () => ({ session: "candidate-session", csrfToken: "candidate-csrf" }));

    await expect(
      runCli(["auth", "login", "--region", "global", "--profile", "work"], {
        createCredentialStore: () => store,
        login
      })
    ).rejects.toMatchObject({ code: "credentials_already_exist" });
    expect(login).not.toHaveBeenCalled();
  });

  it("imports, verifies, stores, and activates without printing credential material", async () => {
    const store = createStore();
    const lines: string[] = [];
    const importCredentials = vi.fn(async () => ({
      session: "imported-session-canary",
      csrfToken: "imported-csrf-canary"
    }));
    const probe = vi.fn(async () => ({ verifiedAt: "2026-07-17T03:00:00.000Z" }));

    await expect(
      runCli(["auth", "import", "--region", "global", "--profile", "work"], {
        createCredentialStore: () => store,
        importCredentials,
        probe,
        writeLine: (line) => lines.push(line)
      })
    ).resolves.toBe(0);

    expect(probe).toHaveBeenCalledOnce();
    expect(store.get("work", "global")).toMatchObject({
      session: "imported-session-canary",
      csrfToken: "imported-csrf-canary"
    });
    expect(store.getActiveProfileId()).toBe("work");
    expect(store.listProfiles()[0]?.regions.global?.verifiedAt).toBe(
      "2026-07-17T03:00:00.000Z"
    );
    expect(lines.join("\n")).not.toContain("imported-session-canary");
    expect(lines.join("\n")).not.toContain("imported-csrf-canary");
  });

  it("supports safe status/list, dynamic use, and deterministic logout successor selection", async () => {
    const store = createStore();
    store.set("work", "global", { session: "work-session", csrfToken: "work-csrf" });
    store.set("other", "cn", { session: "other-session", csrfToken: "other-csrf" });
    store.setActiveProfileId("work");
    const lines: string[] = [];
    const dependencies = {
      createCredentialStore: () => store,
      env: {},
      writeLine: (line: string) => lines.push(line)
    };

    await expect(runCli(["auth", "status"], dependencies)).resolves.toBe(0);
    await expect(runCli(["auth", "list"], dependencies)).resolves.toBe(0);
    await expect(
      runCli(["auth", "use", "--profile", "other"], dependencies)
    ).resolves.toBe(0);
    expect(store.getActiveProfileId()).toBe("other");
    await expect(
      runCli(["auth", "logout", "--region", "cn", "--profile", "other"], dependencies)
    ).resolves.toBe(0);
    expect(store.getActiveProfileId()).toBe("work");

    const output = lines.join("\n");
    expect(output).toContain("source=store");
    expect(output).toContain("operationReady=true");
    expect(output).toContain("profile=other selected=true effective=true");
    expect(output).toContain("removed=true activeProfile=work");
    expect(output).not.toContain("work-session");
    expect(output).not.toContain("other-session");
  });

  it("doctor reports partial environment and expired authentication with stable codes", async () => {
    const store = createStore();
    store.replace(
      "work",
      "cn",
      {
        session: "stored-session",
        csrfToken: "stored-csrf",
        verifiedAt: "2026-07-16T00:00:00.000Z",
        expiresAt: "2026-07-17T00:00:00.000Z"
      },
      { activate: true }
    );
    const lines: string[] = [];
    const probe = vi.fn(async () => {
      throw new AuthError("auth_probe_rejected", "LeetCode rejected the supplied credentials");
    });

    await expect(
      runCli(["auth", "doctor", "--region", "global"], {
        createCredentialStore: () => store,
        env: {
          PI_LEETCODE_PROFILE_ID: "work",
          LEETCODE_SESSION: "environment-session-only"
        },
        probe,
        writeLine: (line) => lines.push(line)
      })
    ).resolves.toBe(2);
    expect(probe).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("reason=auth_environment_bundle_partial");

    lines.length = 0;
    await expect(
      runCli(["auth", "doctor", "--region", "cn"], {
        createCredentialStore: () => store,
        env: {},
        now: () => new Date("2026-07-17T04:00:00.000Z"),
        probe,
        writeLine: (line) => lines.push(line)
      })
    ).resolves.toBe(2);
    expect(lines.join("\n")).toContain("reason=auth_probe_rejected");
  });
});
