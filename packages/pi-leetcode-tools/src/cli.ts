#!/usr/bin/env node

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { importCredentialsFromTerminal } from "./cli/auth-input.js";
import { loginWithLocalBrowser, type BrowserLoginResult } from "./cli/browser-login.js";
import {
  AuthError,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_ID_VARIABLE,
  createDefaultCredentialStore,
  inspectAuthentication,
  listAuthentication,
  normalizeProfileId,
  probeAuthentication,
  resolveAuthenticationCredentials,
  resolveEffectiveProfileId,
  validateStoredCredentialInput,
  type AuthenticationProbe,
  type AuthRegionStatus,
  type CredentialStore,
  type StoredCredentialInput
} from "./runtime/index.js";
import type { Region } from "./types.js";

const USAGE = `pi-leetcode local authentication

Usage:
  pi-leetcode auth login  --region <global|cn> [--profile <id>] [--browser isolated] [--force]
  pi-leetcode auth import --region <global|cn> [--profile <id>] [--browser default] [--force]
  pi-leetcode auth status [--region <global|cn>] [--profile <id>]
  pi-leetcode auth list   [--region <global|cn>]
  pi-leetcode auth use    --profile <id>
  pi-leetcode auth logout --region <global|cn> [--profile <id>]
  pi-leetcode auth doctor [--region <global|cn>] [--profile <id>]

login uses an isolated temporary Edge/Chrome profile. import opens the system
default browser and reads both cookie values from a hidden local TTY prompt.
Credentials are probed before an atomic OS-credential-store replacement;
passwords, cookies, CAPTCHA, and MFA are never printed.`;

type AuthCommand = "login" | "import" | "status" | "list" | "use" | "logout" | "doctor";

export interface CliDependencies {
  createCredentialStore?: () => CredentialStore;
  login?: (region: Region) => Promise<BrowserLoginResult>;
  importCredentials?: (region: Region) => Promise<StoredCredentialInput>;
  probe?: AuthenticationProbe;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  writeLine?: (line: string) => void;
}

interface ParsedCliOptions {
  values: {
    region?: string;
    profile?: string;
    browser?: string;
    force: boolean;
    help: boolean;
  };
}

function invalidArguments(message: string, cause?: unknown): AuthError {
  return new AuthError(
    "auth_invalid_arguments",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function regionFrom(value: string | undefined, required: boolean): Region | undefined {
  if (value === undefined && !required) return undefined;
  if (value === "global" || value === "cn") return value;
  throw new AuthError("auth_region_invalid", "--region must be global or cn");
}

function profileFrom(value: string | undefined, fallback?: string): string {
  return normalizeProfileId(value ?? fallback ?? DEFAULT_PROFILE_ID);
}

function validateEnvironmentProfile(
  env: Readonly<Record<string, string | undefined>>
): void {
  const value = env[DEFAULT_PROFILE_ID_VARIABLE];
  if (value !== undefined && value.trim().length > 0) normalizeProfileId(value);
}

function assertCommand(value: string): asserts value is AuthCommand {
  if (!["login", "import", "status", "list", "use", "logout", "doctor"].includes(value)) {
    throw invalidArguments(`Unknown auth command: ${value}`);
  }
}

function assertNoOption(
  command: AuthCommand,
  name: string,
  value: string | boolean | undefined,
  defaultValue?: string | boolean
): void {
  if (value !== undefined && value !== defaultValue) {
    throw invalidArguments(`--${name} is not valid for auth ${command}`);
  }
}

function formatStatus(status: AuthRegionStatus): string {
  return [
    `profile=${status.profileId}`,
    `region=${status.region}`,
    `source=${status.source}`,
    `configured=${String(status.configured)}`,
    `operationReady=${String(status.operationReady)}`,
    `active=${String(status.active)}`,
    `verification=${status.verification}`,
    ...(status.verifiedAt === undefined ? [] : [`verifiedAt=${status.verifiedAt}`]),
    ...(status.expiresAt === undefined ? [] : [`expiresAt=${status.expiresAt}`]),
    ...(status.reasonCode === undefined ? [] : [`reason=${status.reasonCode}`])
  ].join(" ");
}

function safeError(error: unknown): AuthError {
  return error instanceof AuthError
    ? error
    : new AuthError("auth_invalid_arguments", "The authentication command failed", {
        cause: error
      });
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {}
): Promise<number> {
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const [group, rawCommand, ...rest] = argv;
  if (group === undefined || group === "--help" || group === "-h") {
    writeLine(USAGE);
    return 0;
  }
  if (group !== "auth" || rawCommand === undefined) {
    throw invalidArguments("Expected an auth command. Run pi-leetcode --help.");
  }
  assertCommand(rawCommand);
  const command = rawCommand;

  let parsed: ParsedCliOptions;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        region: { type: "string" },
        profile: { type: "string" },
        browser: { type: "string" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false }
      }
    }) as ParsedCliOptions;
  } catch (error) {
    throw invalidArguments("The authentication command options are invalid", error);
  }
  if (parsed.values.help) {
    writeLine(USAGE);
    return 0;
  }

  const env = dependencies.env ?? process.env;
  const createStore = dependencies.createCredentialStore ?? createDefaultCredentialStore;
  const probe = dependencies.probe ?? ((region, credentials) => probeAuthentication(region, credentials));

  if (command === "login" || command === "import") {
    const region = regionFrom(parsed.values.region, true)!;
    const profileId = profileFrom(parsed.values.profile);
    const expectedBrowser = command === "login" ? "isolated" : "default";
    if (parsed.values.browser !== undefined && parsed.values.browser !== expectedBrowser) {
      throw invalidArguments(`auth ${command} requires --browser ${expectedBrowser}`);
    }
    const store = createStore();
    // Validate the environment selector before launching a browser or
    // collecting candidate secrets, so a bad value cannot make a successful
    // keyring transaction appear to fail afterward.
    validateEnvironmentProfile(env);
    if (!parsed.values.force && store.has(profileId, region)) {
      throw new AuthError(
        "credentials_already_exist",
        `Credentials already exist for profile ${profileId} (${region}); use --force to replace only that bundle`
      );
    }
    writeLine(
      command === "login"
        ? `Starting isolated browser login for LeetCode ${region}...`
        : `Starting default-browser credential import for LeetCode ${region}...`
    );
    const candidate = command === "login"
      ? await (dependencies.login ?? ((selectedRegion) =>
          loginWithLocalBrowser(selectedRegion, { onStatus: writeLine })))(region)
      : await (dependencies.importCredentials ?? ((selectedRegion) =>
          importCredentialsFromTerminal(selectedRegion, { onStatus: writeLine })))(region);
    const validatedCandidate = validateStoredCredentialInput(candidate);
    if (validatedCandidate.csrfToken.length === 0) {
      throw new AuthError(
        "auth_credentials_incomplete",
        "A complete session and CSRF credential bundle is required"
      );
    }
    const verified = await probe(region, validatedCandidate);
    store.replace(
      profileId,
      region,
      {
        session: validatedCandidate.session,
        csrfToken: validatedCandidate.csrfToken,
        verifiedAt: verified.verifiedAt,
        ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt })
      },
      { activate: true }
    );
    writeLine(`Authentication saved and verified for profile ${profileId} (${region}).`);
    if (resolveEffectiveProfileId(store, env) !== profileId) {
      writeLine(
        `profile=${profileId} selected=true effective=false reason=auth_profile_overridden_by_environment`
      );
    }
    return 0;
  }

  if (command === "status") {
    assertNoOption(command, "browser", parsed.values.browser);
    assertNoOption(command, "force", parsed.values.force, false);
    const region = regionFrom(parsed.values.region, false);
    const store = createStore();
    const statuses = inspectAuthentication({
      store,
      env,
      ...(parsed.values.profile === undefined
        ? {}
        : { profileId: profileFrom(parsed.values.profile) }),
      ...(region === undefined ? {} : { region }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now })
    });
    for (const status of statuses) writeLine(formatStatus(status));
    return 0;
  }

  if (command === "list") {
    assertNoOption(command, "profile", parsed.values.profile);
    assertNoOption(command, "browser", parsed.values.browser);
    assertNoOption(command, "force", parsed.values.force, false);
    const region = regionFrom(parsed.values.region, false);
    const store = createStore();
    const statuses = listAuthentication({
      store,
      env,
      ...(region === undefined ? {} : { region }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now })
    });
    for (const status of statuses) writeLine(formatStatus(status));
    return 0;
  }

  if (command === "use") {
    assertNoOption(command, "region", parsed.values.region);
    assertNoOption(command, "browser", parsed.values.browser);
    assertNoOption(command, "force", parsed.values.force, false);
    if (parsed.values.profile === undefined) {
      throw invalidArguments("auth use requires --profile <id>");
    }
    const profileId = profileFrom(parsed.values.profile);
    const store = createStore();
    validateEnvironmentProfile(env);
    if (!store.has(profileId, "global") && !store.has(profileId, "cn")) {
      throw new AuthError("auth_profile_not_found", "The requested credential profile is not configured");
    }
    store.setActiveProfileId(profileId);
    const effective = resolveEffectiveProfileId(store, env);
    writeLine(
      effective === profileId
        ? `profile=${profileId} selected=true effective=true`
        : `profile=${profileId} selected=true effective=false reason=auth_profile_overridden_by_environment`
    );
    return 0;
  }

  if (command === "logout") {
    assertNoOption(command, "browser", parsed.values.browser);
    assertNoOption(command, "force", parsed.values.force, false);
    const region = regionFrom(parsed.values.region, true)!;
    const store = createStore();
    const profileId = profileFrom(
      parsed.values.profile,
      resolveEffectiveProfileId(store, env)
    );
    const deleted = store.delete(profileId, region);
    const active = resolveEffectiveProfileId(store, env);
    writeLine(
      `profile=${profileId} region=${region} removed=${String(deleted)} activeProfile=${active}`
    );
    return 0;
  }

  assertNoOption(command, "browser", parsed.values.browser);
  assertNoOption(command, "force", parsed.values.force, false);
  const region = regionFrom(parsed.values.region, false);
  const store = createStore();
  let statuses: readonly AuthRegionStatus[];
  try {
    statuses = inspectAuthentication({
      store,
      env,
      ...(parsed.values.profile === undefined
        ? {}
        : { profileId: profileFrom(parsed.values.profile) }),
      ...(region === undefined ? {} : { region }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now })
    });
  } catch (error) {
    const authError = safeError(error);
    writeLine(`healthy=false reason=${authError.code}`);
    return 2;
  }
  let healthy = true;
  for (const status of statuses) {
    if (
      !status.configured ||
      status.reasonCode === "auth_environment_bundle_partial" ||
      status.reasonCode === "credential_store_unavailable" ||
      status.reasonCode === "credential_store_corrupt" ||
      status.reasonCode === "credential_store_rollback_failed"
    ) {
      healthy = false;
      writeLine(
        `profile=${status.profileId} region=${status.region} healthy=false reason=${status.reasonCode ?? "auth_credentials_not_configured"}`
      );
      continue;
    }
    try {
      const credentials = resolveAuthenticationCredentials(
        store,
        env,
        status.profileId,
        status.region
      );
      if (credentials === undefined) {
        healthy = false;
        writeLine(
          `profile=${status.profileId} region=${status.region} healthy=false reason=auth_credentials_not_configured`
        );
        continue;
      }
      await probe(status.region, credentials);
      writeLine(
        `profile=${status.profileId} region=${status.region} healthy=true source=${status.source} operationReady=${String(status.operationReady)}`
      );
    } catch (error) {
      healthy = false;
      writeLine(
        `profile=${status.profileId} region=${status.region} healthy=false reason=${safeError(error).code}`
      );
    }
  }
  return healthy ? 0 : 2;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const authError = safeError(error);
      console.error(`pi-leetcode [${authError.code}]: ${authError.message}`);
      process.exitCode = 1;
    }
  );
}
