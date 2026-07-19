import type { CredentialBundle, Region } from "../types.js";
import { AuthError, type AuthErrorCode } from "./auth-errors.js";
import {
  DEFAULT_CREDENTIAL_ENVIRONMENT,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_ID_VARIABLE,
  isSafeCredentialValue,
  normalizeProfileId
} from "./credentials.js";
import {
  type CredentialStore,
  type StoredCredentialInput,
  type StoredCredentialProfile,
  validateStoredCredentialInput
} from "./stored-credentials.js";

export const AUTH_LOGIN_URL: Readonly<Record<Region, string>> = Object.freeze({
  global: "https://leetcode.com/accounts/login/",
  cn: "https://leetcode.cn/accounts/login/"
});

const AUTH_PROBE_ENDPOINT: Readonly<Record<Region, string>> = Object.freeze({
  global: "https://leetcode.com/graphql/",
  cn: "https://leetcode.cn/graphql/noj-go/"
});

const AUTH_PROBE_QUERY = /* GraphQL */ `
  query userStatus {
    userStatus {
      username
      isSignedIn
    }
  }
`;

const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;

export type AuthCredentialSource = "environment" | "store" | "none";
export type AuthVerificationState = "verified" | "unverified" | "expired" | "invalid";

export interface AuthRegionStatus {
  profileId: string;
  region: Region;
  source: AuthCredentialSource;
  configured: boolean;
  operationReady: boolean;
  active: boolean;
  verification: AuthVerificationState;
  verifiedAt?: string;
  expiresAt?: string;
  reasonCode?: AuthErrorCode;
}

export interface AuthInspectionOptions {
  store: CredentialStore;
  env?: Readonly<Record<string, string | undefined>>;
  profileId?: string;
  region?: Region;
  now?: () => Date;
}

export interface AuthenticationProbeOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export interface AuthenticationProbeResult {
  verifiedAt: string;
}

export type AuthenticationProbe = (
  region: Region,
  credentials: StoredCredentialInput
) => Promise<AuthenticationProbeResult>;

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : value;
}

function environmentProfileId(
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const value = configured(env[DEFAULT_PROFILE_ID_VARIABLE]);
  return value === undefined ? undefined : normalizeProfileId(value);
}

export function resolveEffectiveProfileId(
  store: CredentialStore,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const selectedByEnvironment = environmentProfileId(env);
  if (selectedByEnvironment !== undefined) return selectedByEnvironment;
  try {
    return store.getActiveProfileId() ?? DEFAULT_PROFILE_ID;
  } catch {
    return DEFAULT_PROFILE_ID;
  }
}

function environmentState(
  env: Readonly<Record<string, string | undefined>>,
  region: Region
): "absent" | "partial" | "ready" {
  const names = DEFAULT_CREDENTIAL_ENVIRONMENT[region];
  const session = configured(env[names.session]);
  const csrfToken = configured(env[names.csrfToken]);
  if (session === undefined && csrfToken === undefined) return "absent";
  return session !== undefined &&
    csrfToken !== undefined &&
    isSafeCredentialValue(session) &&
    isSafeCredentialValue(csrfToken)
    ? "ready"
    : "partial";
}

function environmentCredential(
  env: Readonly<Record<string, string | undefined>>,
  profileId: string,
  region: Region
): CredentialBundle | undefined {
  if (environmentState(env, region) !== "ready") return undefined;
  const names = DEFAULT_CREDENTIAL_ENVIRONMENT[region];
  const session = configured(env[names.session]);
  const csrfToken = configured(env[names.csrfToken]);
  if (session === undefined || csrfToken === undefined) return undefined;
  return { profileId, region, session, csrfToken };
}

function metadataFor(
  profiles: readonly StoredCredentialProfile[],
  profileId: string,
  region: Region
) {
  return profiles.find((profile) => profile.profileId === profileId)?.regions[region];
}

function readProfiles(store: CredentialStore): {
  profiles: readonly StoredCredentialProfile[];
  reasonCode?: AuthErrorCode;
} {
  try {
    return { profiles: store.listProfiles() };
  } catch (error) {
    return {
      profiles: [],
      reasonCode:
        error instanceof AuthError
          ? error.code
          : "credential_store_unavailable"
    };
  }
}

function statusFor(
  store: CredentialStore,
  profiles: readonly StoredCredentialProfile[],
  env: Readonly<Record<string, string | undefined>>,
  profileId: string,
  environmentOwner: string,
  effectiveProfile: string,
  region: Region,
  now: Date,
  profileIndexReason?: AuthErrorCode
): AuthRegionStatus {
  if (profileId === environmentOwner) {
    const state = environmentState(env, region);
    if (state === "partial") {
      return Object.freeze({
        profileId,
        region,
        source: "environment",
        configured: false,
        operationReady: false,
        active: profileId === effectiveProfile,
        verification: "invalid",
        reasonCode: "auth_environment_bundle_partial"
      });
    }
    if (state === "ready") {
      return Object.freeze({
        profileId,
        region,
        source: "environment",
        configured: true,
        operationReady: true,
        active: profileId === effectiveProfile,
        verification: profileIndexReason === undefined ? "unverified" : "invalid",
        ...(profileIndexReason === undefined ? {} : { reasonCode: profileIndexReason })
      });
    }
  }

  let credentials: CredentialBundle | undefined;
  try {
    credentials = store.get(profileId, region);
  } catch (error) {
    return Object.freeze({
      profileId,
      region,
      source: "none",
      configured: false,
      operationReady: false,
      active: profileId === effectiveProfile,
      verification: "invalid",
      reasonCode:
        error instanceof AuthError
          ? error.code
          : "credential_store_unavailable"
    });
  }
  if (credentials === undefined) {
    return Object.freeze({
      profileId,
      region,
      source: "none",
      configured: false,
      operationReady: false,
      active: profileId === effectiveProfile,
      verification: profileIndexReason === undefined ? "unverified" : "invalid",
      reasonCode: profileIndexReason ?? "auth_credentials_not_configured"
    });
  }

  const metadata = metadataFor(profiles, profileId, region);
  const expired =
    metadata?.expiresAt !== undefined && new Date(metadata.expiresAt).getTime() <= now.getTime();
  return Object.freeze({
    profileId,
    region,
    source: "store",
    configured: true,
    operationReady: credentials.csrfToken.length > 0,
    active: profileId === effectiveProfile,
    verification: profileIndexReason !== undefined
      ? "invalid"
      : expired
        ? "expired"
        : metadata?.verifiedAt === undefined
          ? "unverified"
          : "verified",
    ...(metadata?.verifiedAt === undefined ? {} : { verifiedAt: metadata.verifiedAt }),
    ...(metadata?.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
    ...(profileIndexReason !== undefined
      ? { reasonCode: profileIndexReason }
      : expired
        ? { reasonCode: "auth_expired" as const }
        : {})
  });
}

export function inspectAuthentication(
  options: AuthInspectionOptions
): readonly AuthRegionStatus[] {
  const env = options.env ?? process.env;
  const effectiveProfile = resolveEffectiveProfileId(options.store, env);
  const requestedProfile = options.profileId === undefined
    ? effectiveProfile
    : normalizeProfileId(options.profileId);
  const environmentOwner = environmentProfileId(env) ?? effectiveProfile;
  const profileIndex = readProfiles(options.store);
  const profiles = profileIndex.profiles;
  const regions: readonly Region[] = options.region === undefined
    ? ["global", "cn"]
    : [options.region];
  const now = (options.now ?? (() => new Date()))();
  return Object.freeze(
    regions.map((region) =>
      statusFor(
        options.store,
        profiles,
        env,
        requestedProfile,
        environmentOwner,
        effectiveProfile,
        region,
        now,
        profileIndex.reasonCode
      )
    )
  );
}

export function listAuthentication(
  options: Omit<AuthInspectionOptions, "profileId">
): readonly AuthRegionStatus[] {
  const env = options.env ?? process.env;
  const effectiveProfile = resolveEffectiveProfileId(options.store, env);
  const environmentOwner = environmentProfileId(env) ?? effectiveProfile;
  const profileIndex = readProfiles(options.store);
  const profiles = profileIndex.profiles;
  const profileIds = new Set(profiles.map((profile) => profile.profileId));
  profileIds.add(effectiveProfile);
  if (["global", "cn"].some((region) => environmentState(env, region as Region) !== "absent")) {
    profileIds.add(environmentOwner);
  }
  const regions: readonly Region[] = options.region === undefined
    ? ["global", "cn"]
    : [options.region];
  const now = (options.now ?? (() => new Date()))();
  const statuses: AuthRegionStatus[] = [];
  for (const profileId of [...profileIds].sort((left, right) => left.localeCompare(right, "en"))) {
    for (const region of regions) {
      statuses.push(
        statusFor(
          options.store,
          profiles,
          env,
          profileId,
          environmentOwner,
          effectiveProfile,
          region,
          now,
          profileIndex.reasonCode
        )
      );
    }
  }
  return Object.freeze(statuses);
}

export function resolveAuthenticationCredentials(
  store: CredentialStore,
  env: Readonly<Record<string, string | undefined>>,
  profileId: string,
  region: Region
): CredentialBundle | undefined {
  const effectiveProfile = resolveEffectiveProfileId(store, env);
  const environmentOwner = environmentProfileId(env) ?? effectiveProfile;
  if (profileId === environmentOwner) {
    const state = environmentState(env, region);
    if (state === "partial") {
      throw new AuthError(
        "auth_environment_bundle_partial",
        "The environment credential bundle is incomplete; both session and CSRF values are required"
      );
    }
    if (state === "ready") return environmentCredential(env, profileId, region);
  }
  return store.get(profileId, region);
}

export async function probeAuthentication(
  region: Region,
  credentials: StoredCredentialInput,
  options: AuthenticationProbeOptions = {}
): Promise<AuthenticationProbeResult> {
  const validated = validateStoredCredentialInput(credentials);
  if (validated.csrfToken.length === 0) {
    throw new AuthError(
      "auth_credentials_incomplete",
      "A complete session and CSRF credential bundle is required"
    );
  }
  const endpoint = AUTH_PROBE_ENDPOINT[region];
  const endpointUrl = new URL(endpoint);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new AuthError("auth_invalid_arguments", "Authentication probe timeout must be between 1 and 60000 milliseconds");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: `LEETCODE_SESSION=${validated.session}; csrftoken=${validated.csrfToken}`,
        origin: endpointUrl.origin,
        referer: AUTH_LOGIN_URL[region],
        "x-csrftoken": validated.csrfToken
      },
      body: JSON.stringify({ operationName: "userStatus", query: AUTH_PROBE_QUERY, variables: {} })
    });
  } catch (error) {
    if (signal.aborted) {
      throw new AuthError("auth_probe_timeout", "The authentication check timed out", {
        cause: error
      });
    }
    throw new AuthError("auth_probe_unavailable", "The authentication check could not reach LeetCode", {
      cause: error
    });
  }

  let responseUrl: URL;
  try {
    responseUrl = new URL(response.url || endpoint);
  } catch (error) {
    throw new AuthError("auth_probe_invalid_response", "LeetCode returned an invalid authentication response", {
      cause: error
    });
  }
  if (
    (response.status >= 300 && response.status < 400) ||
    responseUrl.origin !== endpointUrl.origin
  ) {
    throw new AuthError("auth_region_mismatch", "The credentials did not remain on the selected LeetCode region");
  }
  if (response.status === 401 || response.status === 403) {
    throw new AuthError("auth_probe_rejected", "LeetCode rejected the supplied credentials");
  }
  if (!response.ok) {
    throw new AuthError("auth_probe_unavailable", "LeetCode could not verify the supplied credentials");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROBE_RESPONSE_BYTES) {
    throw new AuthError("auth_probe_invalid_response", "LeetCode returned an oversized authentication response");
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    if (signal.aborted) {
      throw new AuthError("auth_probe_timeout", "The authentication check timed out", {
        cause: error
      });
    }
    throw new AuthError("auth_probe_unavailable", "LeetCode could not complete the authentication check", {
      cause: error
    });
  }
  if (Buffer.byteLength(body, "utf8") > MAX_PROBE_RESPONSE_BYTES) {
    throw new AuthError("auth_probe_invalid_response", "LeetCode returned an oversized authentication response");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new AuthError("auth_probe_invalid_response", "LeetCode returned an invalid authentication response", {
      cause: error
    });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AuthError("auth_probe_invalid_response", "LeetCode returned an invalid authentication response");
  }
  const root = payload as Record<string, unknown>;
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new AuthError("auth_probe_rejected", "LeetCode rejected the supplied credentials");
  }
  const data = root.data;
  const userStatus =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).userStatus
      : undefined;
  if (
    typeof userStatus !== "object" ||
    userStatus === null ||
    Array.isArray(userStatus) ||
    (userStatus as Record<string, unknown>).isSignedIn !== true
  ) {
    throw new AuthError("auth_probe_rejected", "LeetCode did not confirm an authenticated account");
  }
  return Object.freeze({ verifiedAt: (options.now ?? (() => new Date()))().toISOString() });
}
