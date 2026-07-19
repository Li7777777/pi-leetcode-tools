import { describe, expect, it } from "vitest";

import type { Clock } from "../../src/runtime/abstractions.js";
import {
  RandomIdGenerator,
  SystemClock
} from "../../src/runtime/abstractions.js";
import {
  CredentialsUnavailableError,
  EnvCredentialProvider,
  type CredentialProvider
} from "../../src/runtime/credentials.js";
import { sha256Digest, sha256Hex } from "../../src/runtime/hash.js";
import type { SafeLogRecord } from "../../src/runtime/logger.js";
import { SafeLogger } from "../../src/runtime/logger.js";
import { CIRCULAR_VALUE, REDACTED_VALUE, Redactor } from "../../src/runtime/redaction.js";

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-07-15T03:04:05.000Z");
  }

  async sleep(): Promise<void> {
    return undefined;
  }
}

describe("EnvCredentialProvider", () => {
  it("isolates credentials by active profile and region", async () => {
    const provider = new EnvCredentialProvider({
      env: {
        PI_LEETCODE_PROFILE_ID: "work-profile",
        LEETCODE_SESSION: "global-session",
        LEETCODE_CSRF_TOKEN: "global-csrf",
        LEETCODE_CN_SESSION: "cn-session",
        LEETCODE_CN_CSRF_TOKEN: "cn-csrf"
      }
    });

    await expect(provider.getCredentials("global")).resolves.toEqual({
      profileId: "work-profile",
      region: "global",
      session: "global-session",
      csrfToken: "global-csrf"
    });
    await expect(provider.getCredentials("cn")).resolves.toEqual({
      profileId: "work-profile",
      region: "cn",
      session: "cn-session",
      csrfToken: "cn-csrf"
    });
  });

  it("fails closed on a partial environment bundle and does not fall back across regions", async () => {
    const provider = new EnvCredentialProvider({
      profileId: "personal",
      env: { LEETCODE_SESSION: "global-only" }
    });

    await expect(provider.getCredentials("global")).resolves.toBeUndefined();
    expect(provider.getSourceState("global")).toBe("partial");
    expect(provider.isConfigured("global", "session")).toBe(false);
    await expect(provider.requireCredentials("global")).rejects.toBeInstanceOf(
      CredentialsUnavailableError
    );
    await expect(provider.getCredentials("cn")).resolves.toBeUndefined();
    await expect(provider.requireCredentials("cn")).rejects.toBeInstanceOf(
      CredentialsUnavailableError
    );
  });

  it("supports explicit environment variable names without changing global process state", async () => {
    const provider = new EnvCredentialProvider({
      env: { PRIVATE_SESSION: "session", PRIVATE_CSRF: "csrf" },
      variables: {
        global: { session: "PRIVATE_SESSION", csrfToken: "PRIVATE_CSRF" }
      }
    });

    await expect(provider.getCredentials("global")).resolves.toMatchObject({
      session: "session",
      csrfToken: "csrf"
    });
  });

  it("reports configuration presence without exposing credential values", async () => {
    const provider = new EnvCredentialProvider({
      env: {
        PI_LEETCODE_PROFILE_ID: "work-profile",
        LEETCODE_SESSION: "global-secret-session",
        LEETCODE_CN_SESSION: "cn-secret-session",
        LEETCODE_CN_CSRF_TOKEN: "cn-secret-csrf"
      }
    });

    const configuration = await provider.getConfiguration();
    expect(configuration).toEqual({
      profileId: "work-profile",
      regions: {
        global: {
          sessionConfigured: true,
          csrfConfigured: false,
          operationConfigured: false
        },
        cn: {
          sessionConfigured: true,
          csrfConfigured: true,
          operationConfigured: true
        }
      }
    });
    const serialized = JSON.stringify(configuration);
    expect(serialized).not.toContain("global-secret-session");
    expect(serialized).not.toContain("cn-secret-session");
    expect(serialized).not.toContain("cn-secret-csrf");
  });

  it("re-observes profile and regional configuration changes on every call", async () => {
    const env: Record<string, string | undefined> = {
      PI_LEETCODE_PROFILE_ID: "profile-a",
      LEETCODE_SESSION: "session-a"
    };
    const provider = new EnvCredentialProvider({ env });

    await expect(provider.getConfiguration()).resolves.toMatchObject({
      profileId: "profile-a",
      regions: {
        global: {
          sessionConfigured: true,
          csrfConfigured: false,
          operationConfigured: false
        },
        cn: {
          sessionConfigured: false,
          csrfConfigured: false,
          operationConfigured: false
        }
      }
    });

    env.PI_LEETCODE_PROFILE_ID = "profile-b";
    env.LEETCODE_CSRF_TOKEN = "csrf-b";
    env.LEETCODE_CN_SESSION = "cn-session-b";
    env.LEETCODE_CN_CSRF_TOKEN = "cn-csrf-b";

    await expect(provider.getConfiguration()).resolves.toEqual({
      profileId: "profile-b",
      regions: {
        global: {
          sessionConfigured: true,
          csrfConfigured: true,
          operationConfigured: true
        },
        cn: {
          sessionConfigured: true,
          csrfConfigured: true,
          operationConfigured: true
        }
      }
    });
    await expect(provider.getCredentials("global")).resolves.toMatchObject({
      profileId: "profile-b",
      session: "session-a",
      csrfToken: "csrf-b"
    });

    delete env.LEETCODE_SESSION;
    expect(provider.isConfigured("global")).toBe(false);
    await expect(provider.getConfiguration()).resolves.toMatchObject({
      regions: {
        global: {
          sessionConfigured: false,
          csrfConfigured: true,
          operationConfigured: false
        }
      }
    });
  });

  it("advances its safe revision when credential bytes rotate without changing readiness", async () => {
    const env: Record<string, string | undefined> = {
      LEETCODE_SESSION: "session-a",
      LEETCODE_CSRF_TOKEN: "csrf-a"
    };
    const provider = new EnvCredentialProvider({ env });
    const initial = provider.getRevision();
    expect(provider.getRevision()).toBe(initial);

    env.LEETCODE_SESSION = "session-b";
    expect(provider.getRevision()).toBeGreaterThan(initial);
    await expect(provider.getCredentials("global")).resolves.toMatchObject({
      session: "session-b",
      csrfToken: "csrf-a"
    });
  });

  it("uses the same bounded ASCII profile grammar as the public wire metadata", () => {
    expect(() => new EnvCredentialProvider({ profileId: "work:global-1" })).not.toThrow();
    expect(() => new EnvCredentialProvider({ profileId: "work profile" })).toThrow(
      "Credential profile IDs"
    );
    expect(() => new EnvCredentialProvider({ profileId: "../work" })).toThrow(
      "Credential profile IDs"
    );
  });

  it("keeps getConfiguration optional for existing credential providers", () => {
    const legacyProvider: CredentialProvider = {
      async getCredentials() {
        return undefined;
      }
    };

    expect(legacyProvider.getConfiguration).toBeUndefined();
  });
});

describe("redaction and safe logging", () => {
  it("redacts secret values, sensitive fields, auth headers, cookies, and cycles", () => {
    const redactor = new Redactor(["secret-canary"]);
    const source: Record<string, unknown> = {
      requestId: "request-secret-canary",
      authorization: "Bearer abc.def",
      nested: {
        code: "return secret-canary",
        "x-csrf-token": "header-csrf",
        message: "Cookie LEETCODE_SESSION=session-value; csrftoken=csrf-value"
      }
    };
    source.self = source;

    expect(redactor.redact(source)).toEqual({
      requestId: `request-${REDACTED_VALUE}`,
      authorization: REDACTED_VALUE,
      nested: {
        code: REDACTED_VALUE,
        "x-csrf-token": REDACTED_VALUE,
        message: `Cookie LEETCODE_SESSION=${REDACTED_VALUE}; csrftoken=${REDACTED_VALUE}`
      },
      self: CIRCULAR_VALUE
    });
  });

  it("emits only the fixed metadata allowlist and rejects unsafe event names", () => {
    const records: SafeLogRecord[] = [];
    const logger = new SafeLogger({
      sink: (record) => records.push({ ...record }),
      redactor: new Redactor(["secret-canary"]),
      clock: new FixedClock(),
      minimumLevel: "debug"
    });

    logger.info("remote response secret-canary", {
      tool: "lc_problem",
      region: "global",
      status: "ok-secret-canary",
      durationMs: -12,
      requestId: "request-secret-canary",
      ...({ code: "user-code", body: "remote-body" } as object)
    });

    expect(records).toEqual([
      {
        timestamp: "2026-07-15T03:04:05.000Z",
        level: "info",
        event: "unsafe_event_name",
        tool: "lc_problem",
        region: "global",
        status: `ok-${REDACTED_VALUE}`,
        durationMs: 0,
        requestId: `request-${REDACTED_VALUE}`
      }
    ]);
    expect(JSON.stringify(records)).not.toContain("user-code");
    expect(JSON.stringify(records)).not.toContain("remote-body");
    expect(JSON.stringify(records)).not.toContain("secret-canary");
  });

  it("defaults to no output and filters debug records", () => {
    const records: SafeLogRecord[] = [];
    const logger = new SafeLogger({ sink: (record) => records.push({ ...record }) });
    logger.debug("request.started");
    expect(records).toEqual([]);
    expect(() => new SafeLogger().info("request.started")).not.toThrow();
  });
});

describe("hash, clock, and ids", () => {
  it("hashes the exact UTF-8 bytes and returns an optional algorithm prefix", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    expect(sha256Digest("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    expect(sha256Hex("hello\n")).not.toBe(sha256Hex("hello"));
    expect(sha256Hex(new TextEncoder().encode("你好"))).toBe(sha256Hex("你好"));
  });

  it("creates prefixed UUID ids", () => {
    expect(new RandomIdGenerator().generate("request")).toMatch(
      /^request_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  });

  it("supports cancelling a system clock sleep", async () => {
    const controller = new AbortController();
    const sleeping = new SystemClock().sleep(10_000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toMatchObject({ name: "AbortError" });
  });
});
