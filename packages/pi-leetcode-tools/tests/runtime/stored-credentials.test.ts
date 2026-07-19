import { describe, expect, it } from "vitest";

import {
  CompositeCredentialProvider,
  createDefaultCredentialProvider,
  DEFAULT_CREDENTIAL_STORE_SERVICE,
  EnvCredentialProvider,
  OsKeyringCredentialStore,
  StoredCredentialProvider,
  type KeyringEntry
} from "../../src/runtime/index.js";

class FakeKeyring implements KeyringEntry {
  static readonly values = new Map<string, string>();
  static failNextSetFor: string | undefined;
  static failNextGetFor: string | undefined;
  readonly key: string;
  constructor(service: string, account: string) {
    expect(service).toBe(DEFAULT_CREDENTIAL_STORE_SERVICE);
    this.key = account;
  }
  getPassword(): string | null {
    if (FakeKeyring.failNextGetFor === this.key) {
      FakeKeyring.failNextGetFor = undefined;
      throw new Error("fake keyring read failure");
    }
    return FakeKeyring.values.get(this.key) ?? null;
  }
  setPassword(password: string): void {
    if (FakeKeyring.failNextSetFor === this.key) {
      FakeKeyring.failNextSetFor = undefined;
      throw new Error("fake keyring write failure");
    }
    FakeKeyring.values.set(this.key, password);
  }
  deletePassword(): boolean {
    return FakeKeyring.values.delete(this.key);
  }
}

function store(): OsKeyringCredentialStore {
  FakeKeyring.values.clear();
  FakeKeyring.failNextSetFor = undefined;
  FakeKeyring.failNextGetFor = undefined;
  let revision = 0;
  return new OsKeyringCredentialStore({
    entryFactory: (service, account) => new FakeKeyring(service, account),
    revisionFactory: () => `revision-${++revision}`
  });
}

describe("OsKeyringCredentialStore", () => {
  it("stores versioned, profile-and-region scoped credentials", () => {
    const credentials = store();
    expect(credentials.has("work", "global")).toBe(false);
    credentials.set("work", "global", { session: "session", csrfToken: "csrf" });
    expect(credentials.get("work", "global")).toEqual({
      profileId: "work",
      region: "global",
      session: "session",
      csrfToken: "csrf"
    });
    expect(credentials.get("work", "cn")).toBeUndefined();
    expect(credentials.getActiveProfileId()).toBeUndefined();
    credentials.setActiveProfileId("work");
    expect(credentials.getActiveProfileId()).toBe("work");
    expect(credentials.listProfiles()).toEqual([
      {
        profileId: "work",
        regions: {
          global: { operationReady: true }
        }
      }
    ]);
    expect(credentials.delete("work", "global")).toBe(true);
    expect(credentials.delete("work", "global")).toBe(false);
    expect(credentials.getActiveProfileId()).toBeUndefined();
  });

  it("treats malformed keyring records as absent without exposing their contents", () => {
    const credentials = store();
    FakeKeyring.values.set("work:global", JSON.stringify({ version: 99, session: "secret-canary" }));
    expect(credentials.get("work", "global")).toBeUndefined();
  });

  it("rolls back a forced replacement when the active pointer update fails", () => {
    const credentials = store();
    credentials.replace(
      "work",
      "global",
      { session: "old-session", csrfToken: "old-csrf", verifiedAt: "2026-07-17T00:00:00.000Z" },
      { activate: true }
    );
    const epoch = credentials.getEpoch();
    FakeKeyring.failNextSetFor = "__active_profile__";

    expect(() =>
      credentials.replace(
        "work",
        "global",
        { session: "new-session", csrfToken: "new-csrf", verifiedAt: "2026-07-17T01:00:00.000Z" },
        { activate: true }
      )
    ).toThrow("credential store");

    expect(credentials.get("work", "global")).toMatchObject({
      session: "old-session",
      csrfToken: "old-csrf"
    });
    expect(credentials.getActiveProfileId()).toBe("work");
    expect(credentials.getEpoch()).toBe(epoch);
    expect(credentials.listProfiles()[0]?.regions.global?.verifiedAt).toBe(
      "2026-07-17T00:00:00.000Z"
    );
  });

  it("chooses a deterministic successor when the last active bundle is removed", () => {
    const credentials = store();
    credentials.set("zeta", "global", { session: "zeta-session", csrfToken: "zeta-csrf" });
    credentials.set("alpha", "cn", { session: "alpha-session", csrfToken: "alpha-csrf" });
    credentials.setActiveProfileId("zeta");

    expect(credentials.delete("zeta", "global")).toBe(true);
    expect(credentials.getActiveProfileId()).toBe("alpha");

    credentials.set("default", "global", { session: "default-session", csrfToken: "default-csrf" });
    credentials.set("zeta", "global", { session: "zeta-session", csrfToken: "zeta-csrf" });
    credentials.setActiveProfileId("zeta");
    expect(credentials.delete("zeta", "global")).toBe(true);
    expect(credentials.getActiveProfileId()).toBe("default");
  });

  it("maps native keyring failures to a stable non-secret error code", () => {
    const credentials = store();
    FakeKeyring.failNextGetFor = "work:global";
    try {
      credentials.get("work", "global");
      throw new Error("expected keyring failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "credential_store_unavailable" });
    }
  });
});

describe("StoredCredentialProvider and CompositeCredentialProvider", () => {
  it("reports stored configuration and supports profile changes", async () => {
    const credentials = store();
    credentials.set("work", "global", { session: "session", csrfToken: "csrf" });
    let profile = "work";
    const provider = new StoredCredentialProvider({
      store: credentials,
      resolveProfileId: () => profile
    });
    expect(provider.isConfigured("global", "session")).toBe(true);
    expect(provider.isConfigured("global", "operation")).toBe(true);
    await expect(provider.getConfiguration()).resolves.toMatchObject({
      profileId: "work",
      regions: { global: { sessionConfigured: true, operationConfigured: true } }
    });
    profile = "missing";
    expect(provider.isConfigured("global")).toBe(false);
    expect(provider.getActiveProfileId()).toBeUndefined();
  });

  it("uses environment credentials first and stored credentials as fallback", async () => {
    const credentials = store();
    credentials.set("default", "global", { session: "stored-session", csrfToken: "stored-csrf" });
    credentials.set("default", "cn", { session: "stored-cn", csrfToken: "stored-cn-csrf" });
    const env = new EnvCredentialProvider({
      env: { LEETCODE_SESSION: "env-session", LEETCODE_CSRF_TOKEN: "env-csrf" }
    });
    const composite = new CompositeCredentialProvider({
      providers: [env, new StoredCredentialProvider({ store: credentials })]
    });
    await expect(composite.getCredentials("global")).resolves.toMatchObject({
      session: "env-session",
      csrfToken: "env-csrf"
    });
    await expect(composite.getCredentials("cn")).resolves.toMatchObject({
      session: "stored-cn",
      csrfToken: "stored-cn-csrf"
    });
    expect(composite.getActiveProfileId()).toBe("default");
  });

  it("lets a partial environment bundle shadow the store and fail closed", async () => {
    const credentials = store();
    credentials.set("default", "global", {
      session: "stored-session",
      csrfToken: "stored-csrf"
    });
    const composite = new CompositeCredentialProvider({
      providers: [
        new EnvCredentialProvider({
          env: { LEETCODE_SESSION: "environment-session" }
        }),
        new StoredCredentialProvider({ store: credentials })
      ]
    });

    await expect(composite.getCredentials("global")).resolves.toBeUndefined();
    expect(composite.getSourceState("global")).toBe("partial");
    expect(composite.isConfigured("global", "session")).toBe(false);
    expect(composite.isConfigured("global", "operation")).toBe(false);
    await expect(composite.getConfiguration()).resolves.toMatchObject({
      regions: {
        global: {
          sessionConfigured: true,
          csrfConfigured: false,
          operationConfigured: false
        }
      }
    });
  });

  it("uses the keyring active profile unless the environment explicitly overrides it", async () => {
    const credentials = store();
    credentials.set("work", "global", { session: "work-session", csrfToken: "work-csrf" });
    credentials.set("other", "global", { session: "other-session", csrfToken: "other-csrf" });
    credentials.setActiveProfileId("work");

    const storedActive = createDefaultCredentialProvider({
      env: { env: {} },
      store: credentials
    });
    await expect(storedActive.getCredentials("global")).resolves.toMatchObject({
      profileId: "work",
      session: "work-session"
    });

    const environmentOverride = createDefaultCredentialProvider({
      env: { env: { PI_LEETCODE_PROFILE_ID: "other" } },
      store: credentials
    });
    await expect(environmentOverride.getCredentials("global")).resolves.toMatchObject({
      profileId: "other",
      session: "other-session"
    });

    const explicitOverride = createDefaultCredentialProvider({
      env: {
        env: { PI_LEETCODE_PROFILE_ID: "other" },
        profileId: "work"
      },
      store: credentials
    });
    await expect(explicitOverride.getCredentials("global")).resolves.toMatchObject({
      profileId: "work",
      session: "work-session"
    });
  });

  it("observes active profile changes made after provider construction", async () => {
    const credentials = store();
    credentials.set("work", "global", { session: "work-session", csrfToken: "work-csrf" });
    credentials.set("other", "global", { session: "other-session", csrfToken: "other-csrf" });
    credentials.setActiveProfileId("work");
    const provider = createDefaultCredentialProvider({ env: { env: {} }, store: credentials });
    const initialRevision = provider.getRevision?.();
    await expect(provider.getCredentials("global")).resolves.toMatchObject({
      profileId: "work",
      session: "work-session"
    });

    credentials.setActiveProfileId("other");
    await expect(provider.getCredentials("global")).resolves.toMatchObject({
      profileId: "other",
      session: "other-session"
    });
    expect(provider.getActiveProfileId?.()).toBe("other");
    expect(provider.getRevision?.()).toBeGreaterThan(initialRevision ?? 0);
  });

  it("advances the provider revision when stored secret bytes rotate", async () => {
    const credentials = store();
    credentials.set("default", "global", { session: "session-a", csrfToken: "csrf-a" });
    const provider = createDefaultCredentialProvider({ env: { env: {} }, store: credentials });
    const initial = provider.getRevision?.() ?? 0;
    credentials.set("default", "global", { session: "session-b", csrfToken: "csrf-b" });
    expect(provider.getRevision?.()).toBeGreaterThan(initial);
    await expect(provider.getCredentials("global")).resolves.toMatchObject({
      session: "session-b",
      csrfToken: "csrf-b"
    });
  });
});
