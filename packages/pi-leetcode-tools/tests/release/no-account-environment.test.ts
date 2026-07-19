import { describe, expect, it } from "vitest";

const releaseUtilsUrl = new URL("../../scripts/release-utils.mjs", import.meta.url).href;

interface NoAccountEnvironmentResult {
  environment: Record<string, string | undefined>;
  profileId: string;
}

async function loadHelper() {
  return (await import(releaseUtilsUrl)) as {
    createNoAccountEnvironment(options?: {
      environment?: Record<string, string | undefined>;
      profileId?: string;
    }): NoAccountEnvironmentResult;
  };
}

describe("no-account release environment", () => {
  it("removes credential variables case-insensitively and selects the requested empty profile", async () => {
    const { createNoAccountEnvironment } = await loadHelper();
    const source = {
      LEETCODE_SESSION: "real-global-session",
      leetcode_csrf_token: "real-global-csrf",
      LeetCode_CN_Session: "real-cn-session",
      LEETCODE_CN_CSRF_TOKEN: "real-cn-csrf",
      pi_leetcode_profile_id: "real-active-profile",
      KEEP_ME: "safe"
    };

    const result = createNoAccountEnvironment({
      environment: source,
      profileId: "pi-no-account-test-123"
    });

    expect(result.profileId).toBe("pi-no-account-test-123");
    expect(result.environment).toEqual({
      KEEP_ME: "safe",
      PI_LEETCODE_PROFILE_ID: "pi-no-account-test-123"
    });
    expect(source.LEETCODE_SESSION).toBe("real-global-session");
    expect(source.pi_leetcode_profile_id).toBe("real-active-profile");
  });

  it("generates a unique safe run-scoped profile by default", async () => {
    const { createNoAccountEnvironment } = await loadHelper();
    const first = createNoAccountEnvironment({ environment: {} });
    const second = createNoAccountEnvironment({ environment: {} });

    expect(first.profileId).toMatch(/^pi-no-account-[0-9a-f-]{36}$/u);
    expect(second.profileId).toMatch(/^pi-no-account-[0-9a-f-]{36}$/u);
    expect(second.profileId).not.toBe(first.profileId);
    expect(first.environment.PI_LEETCODE_PROFILE_ID).toBe(first.profileId);
  });
});
