import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CREDENTIAL_STORE_SERVICE,
  inspectAuthentication,
  listAuthentication,
  OsKeyringCredentialStore,
  probeAuthentication,
  resolveAuthenticationCredentials,
  type KeyringEntry
} from "../../src/runtime/index.js";

class MemoryKeyring implements KeyringEntry {
  static readonly values = new Map<string, string>();
  static unavailable = false;
  readonly key: string;

  constructor(service: string, account: string) {
    expect(service).toBe(DEFAULT_CREDENTIAL_STORE_SERVICE);
    this.key = account;
  }

  getPassword(): string | null {
    if (MemoryKeyring.unavailable) throw new Error("secret service unavailable");
    return MemoryKeyring.values.get(this.key) ?? null;
  }

  setPassword(password: string): void {
    MemoryKeyring.values.set(this.key, password);
  }

  deletePassword(): boolean {
    return MemoryKeyring.values.delete(this.key);
  }
}

function createStore(): OsKeyringCredentialStore {
  MemoryKeyring.values.clear();
  MemoryKeyring.unavailable = false;
  let revision = 0;
  return new OsKeyringCredentialStore({
    entryFactory: (service, account) => new MemoryKeyring(service, account),
    revisionFactory: () => `revision-${++revision}`
  });
}

describe("authentication lifecycle inspection", () => {
  it("reports only safe status fields and honors stored verification metadata", () => {
    const store = createStore();
    store.replace(
      "work",
      "global",
      {
        session: "runtime-session-value",
        csrfToken: "runtime-csrf-value",
        verifiedAt: "2026-07-17T00:00:00.000Z",
        expiresAt: "2026-07-18T00:00:00.000Z"
      },
      { activate: true }
    );

    const statuses = inspectAuthentication({
      store,
      env: {},
      now: () => new Date("2026-07-17T01:00:00.000Z")
    });
    expect(statuses).toEqual([
      {
        profileId: "work",
        region: "global",
        source: "store",
        configured: true,
        operationReady: true,
        active: true,
        verification: "verified",
        verifiedAt: "2026-07-17T00:00:00.000Z",
        expiresAt: "2026-07-18T00:00:00.000Z"
      },
      {
        profileId: "work",
        region: "cn",
        source: "none",
        configured: false,
        operationReady: false,
        active: true,
        verification: "unverified",
        reasonCode: "auth_credentials_not_configured"
      }
    ]);
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain("runtime-session-value");
    expect(serialized).not.toContain("runtime-csrf-value");
  });

  it("lets either half of an environment bundle shadow a stored login", () => {
    const store = createStore();
    store.replace(
      "work",
      "global",
      { session: "stored-session", csrfToken: "stored-csrf" },
      { activate: true }
    );
    const env = {
      PI_LEETCODE_PROFILE_ID: "work",
      LEETCODE_CSRF_TOKEN: "environment-csrf-only"
    };

    expect(inspectAuthentication({ store, env, region: "global" })).toEqual([
      {
        profileId: "work",
        region: "global",
        source: "environment",
        configured: false,
        operationReady: false,
        active: true,
        verification: "invalid",
        reasonCode: "auth_environment_bundle_partial"
      }
    ]);
    try {
      resolveAuthenticationCredentials(store, env, "work", "global");
      throw new Error("expected partial environment failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "auth_environment_bundle_partial" });
    }
  });

  it("lists the effective environment profile and every indexed stored profile", () => {
    const store = createStore();
    store.set("stored", "cn", { session: "stored-session", csrfToken: "stored-csrf" });
    const statuses = listAuthentication({
      store,
      env: {
        PI_LEETCODE_PROFILE_ID: "environment",
        LEETCODE_SESSION: "environment-session",
        LEETCODE_CSRF_TOKEN: "environment-csrf"
      },
      region: "global"
    });

    expect(statuses.map((status) => [status.profileId, status.source, status.active])).toEqual([
      ["environment", "environment", true],
      ["stored", "none", false]
    ]);
  });

  it("keeps environment readiness visible while reporting an unavailable keyring", () => {
    const store = createStore();
    MemoryKeyring.unavailable = true;
    const statuses = inspectAuthentication({
      store,
      env: {
        PI_LEETCODE_PROFILE_ID: "environment",
        LEETCODE_SESSION: "environment-session",
        LEETCODE_CSRF_TOKEN: "environment-csrf"
      },
      region: "global"
    });

    expect(statuses).toEqual([
      {
        profileId: "environment",
        region: "global",
        source: "environment",
        configured: true,
        operationReady: true,
        active: true,
        verification: "invalid",
        reasonCode: "credential_store_unavailable"
      }
    ]);
    MemoryKeyring.unavailable = false;
  });
});

describe("authentication probe", () => {
  it("uses the fixed regional endpoint and accepts only an authenticated status", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://leetcode.cn/graphql/noj-go/");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("origin")).toBe("https://leetcode.cn");
      expect(headers.get("cookie")).toContain("LEETCODE_SESSION=");
      return new Response(
        JSON.stringify({ data: { userStatus: { username: "local-user", isSignedIn: true } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    await expect(
      probeAuthentication(
        "cn",
        { session: "candidate-session", csrfToken: "candidate-csrf" },
        {
          fetch: fetchMock as unknown as typeof fetch,
          now: () => new Date("2026-07-17T02:00:00.000Z")
        }
      )
    ).resolves.toEqual({ verifiedAt: "2026-07-17T02:00:00.000Z" });
  });

  it("maps signed-out, redirect, and timeout outcomes to stable reason codes", async () => {
    const signedOut = async () =>
      new Response(JSON.stringify({ data: { userStatus: { isSignedIn: false } } }), {
        status: 200
      });
    await expect(
      probeAuthentication(
        "global",
        { session: "candidate-session", csrfToken: "candidate-csrf" },
        { fetch: signedOut as unknown as typeof fetch }
      )
    ).rejects.toMatchObject({ code: "auth_probe_rejected" });

    const redirected = async () => new Response(null, { status: 302 });
    await expect(
      probeAuthentication(
        "global",
        { session: "candidate-session", csrfToken: "candidate-csrf" },
        { fetch: redirected as unknown as typeof fetch }
      )
    ).rejects.toMatchObject({ code: "auth_region_mismatch" });

    const blocked = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true
        });
      });
    await expect(
      probeAuthentication(
        "global",
        { session: "candidate-session", csrfToken: "candidate-csrf" },
        { fetch: blocked as unknown as typeof fetch, timeoutMs: 5 }
      )
    ).rejects.toMatchObject({ code: "auth_probe_timeout" });
  });
});
