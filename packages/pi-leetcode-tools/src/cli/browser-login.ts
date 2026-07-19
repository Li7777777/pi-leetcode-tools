import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type BrowserContext } from "playwright-core";

import { AuthError } from "../runtime/auth-errors.js";
import { AUTH_LOGIN_URL } from "../runtime/auth-lifecycle.js";
import type { Region } from "../types.js";

export interface BrowserLoginResult {
  session: string;
  csrfToken: string;
  expiresAt?: string;
}

export interface BrowserLoginOptions {
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

const COOKIE_DOMAIN: Readonly<Record<Region, string>> = Object.freeze({
  global: "leetcode.com",
  cn: "leetcode.cn"
});

async function launchContext(userDataDirectory: string): Promise<BrowserContext> {
  for (const channel of ["msedge", "chrome"] as const) {
    try {
      return await chromium.launchPersistentContext(userDataDirectory, {
        channel,
        headless: false,
        viewport: null
      });
    } catch {}
  }

  throw new AuthError(
    "auth_browser_unavailable",
    "No supported local browser could be started; install Microsoft Edge or Google Chrome"
  );
}

function findCookie(
  cookies: Awaited<ReturnType<BrowserContext["cookies"]>>,
  name: string,
  domain: string
): Awaited<ReturnType<BrowserContext["cookies"]>>[number] | undefined {
  return cookies.find(
    (cookie) =>
      cookie.name === name &&
      (cookie.domain === domain || cookie.domain.endsWith(`.${domain}`)) &&
      cookie.value.length > 0
  );
}

function cookieExpiry(
  ...cookies: readonly (Awaited<ReturnType<BrowserContext["cookies"]>>[number] | undefined)[]
): string | undefined {
  const expiries = cookies
    .map((cookie) => cookie?.expires ?? -1)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (expiries.length === 0) return undefined;
  return new Date(Math.min(...expiries) * 1_000).toISOString();
}

export async function loginWithLocalBrowser(
  region: Region,
  options: BrowserLoginOptions = {}
): Promise<BrowserLoginResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const profileDirectory = await mkdtemp(join(tmpdir(), "pi-leetcode-auth-"));
  let context: BrowserContext | undefined;
  let completed = false;

  try {
    context = await launchContext(profileDirectory);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(AUTH_LOGIN_URL[region], { waitUntil: "domcontentloaded" });
    options.onStatus?.(
      "Complete sign-in in the opened browser window. Passwords, CAPTCHA and MFA remain inside the browser."
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (context.pages().length === 0) {
        throw new AuthError(
          "auth_browser_closed",
          "The login browser was closed before authentication completed"
        );
      }
      const cookies = await context.cookies();
      const domain = COOKIE_DOMAIN[region];
      const session = findCookie(cookies, "LEETCODE_SESSION", domain);
      const csrfToken = findCookie(cookies, "csrftoken", domain);
      if (session !== undefined && csrfToken !== undefined) {
        completed = true;
        const expiresAt = cookieExpiry(session, csrfToken);
        return {
          session: session.value,
          csrfToken: csrfToken.value,
          ...(expiresAt === undefined ? {} : { expiresAt })
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    throw new AuthError(
      "auth_login_timeout",
      "Timed out waiting for LeetCode authentication"
    );
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      "auth_browser_unavailable",
      "The isolated login browser could not complete authentication",
      { cause: error }
    );
  } finally {
    let cleanupFailed = false;
    try {
      await context?.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      await rm(profileDirectory, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      throw new AuthError(
        "auth_temporary_profile_cleanup_failed",
        `The temporary authentication browser profile could not be removed${completed ? " after login" : ""}`
      );
    }
  }
}
