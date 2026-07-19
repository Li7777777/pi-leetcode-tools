import { createHmac, randomBytes } from "node:crypto";

import type { CredentialBundle, Region } from "../types.js";
import { AuthError } from "./auth-errors.js";

export type CredentialSourceState = "absent" | "partial" | "ready";

export interface RegionCredentialConfiguration {
  sessionConfigured: boolean;
  csrfConfigured: boolean;
  operationConfigured: boolean;
}

export interface CredentialConfigurationDescriptor {
  profileId: string;
  regions: Readonly<Record<Region, RegionCredentialConfiguration>>;
}

export interface CredentialProvider {
  getCredentials(region: Region): Promise<CredentialBundle | undefined>;
  getConfiguration?(): Promise<CredentialConfigurationDescriptor>;
  isConfigured?(region: Region, requirement?: "session" | "operation"): boolean;
  getActiveProfileId?(): string | undefined;
  /**
   * Returns a process-local monotonic revision. Implementations must advance it
   * when profile selection, credential presence, or credential bytes change.
   */
  getRevision?(): number;
  /**
   * Indicates whether this source is absent, incomplete (and therefore shadows
   * lower-priority sources), or contains a complete regional bundle.
   */
  getSourceState?(region: Region): CredentialSourceState;
}

export interface RegionEnvironmentVariables {
  session: string;
  csrfToken: string;
}

export interface EnvCredentialProviderOptions {
  env?: Readonly<Record<string, string | undefined>>;
  profileId?: string;
  profileIdVariable?: string;
  fallbackProfileId?: () => string | undefined;
  variables?: Partial<Record<Region, Partial<RegionEnvironmentVariables>>>;
}

export const DEFAULT_CREDENTIAL_ENVIRONMENT: Readonly<Record<Region, RegionEnvironmentVariables>> =
  Object.freeze({
    global: Object.freeze({
      session: "LEETCODE_SESSION",
      csrfToken: "LEETCODE_CSRF_TOKEN"
    }),
    cn: Object.freeze({
      session: "LEETCODE_CN_SESSION",
      csrfToken: "LEETCODE_CN_CSRF_TOKEN"
    })
  });

export const DEFAULT_PROFILE_ID_VARIABLE = "PI_LEETCODE_PROFILE_ID";
export const DEFAULT_PROFILE_ID = "default";
export const PROFILE_ID_PATTERN_SOURCE = "^[A-Za-z0-9._:-]+$";
export const PROFILE_ID_PATTERN = new RegExp(PROFILE_ID_PATTERN_SOURCE, "u");
export const MAX_PROFILE_ID_LENGTH = 128;

export class CredentialsUnavailableError extends Error {
  readonly region: Region;

  constructor(region: Region) {
    super(`Credentials are not configured for the ${region} region`);
    this.name = "CredentialsUnavailableError";
    this.region = region;
  }
}

function configuredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : value;
}

export function isSafeCredentialValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 16_384 &&
    !/[\u0000-\u0020\u007f;,]/u.test(value)
  );
}

export function normalizeProfileId(profileId: string): string {
  if (
    profileId.length === 0 ||
    profileId.length > MAX_PROFILE_ID_LENGTH ||
    !PROFILE_ID_PATTERN.test(profileId)
  ) {
    throw new AuthError(
      "auth_profile_invalid",
      "Credential profile IDs must contain only ASCII letters, digits, dot, underscore, colon, or hyphen"
    );
  }

  return profileId;
}

function sourceState(
  env: Readonly<Record<string, string | undefined>>,
  names: RegionEnvironmentVariables
): CredentialSourceState {
  const session = configuredValue(env[names.session]);
  const csrfToken = configuredValue(env[names.csrfToken]);
  if (session === undefined && csrfToken === undefined) return "absent";
  return session !== undefined &&
    csrfToken !== undefined &&
    isSafeCredentialValue(session) &&
    isSafeCredentialValue(csrfToken)
    ? "ready"
    : "partial";
}

export class EnvCredentialProvider implements CredentialProvider {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #explicitProfileId: string | undefined;
  readonly #profileIdVariable: string;
  readonly #fallbackProfileId: (() => string | undefined) | undefined;
  readonly #variables: Readonly<Record<Region, RegionEnvironmentVariables>>;
  readonly #revisionKey = randomBytes(32);
  #revisionFingerprint: string | undefined;
  #revision = 0;

  constructor(options: EnvCredentialProviderOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#explicitProfileId = options.profileId;
    if (this.#explicitProfileId !== undefined) {
      normalizeProfileId(this.#explicitProfileId);
    }
    this.#profileIdVariable =
      options.profileIdVariable ?? DEFAULT_PROFILE_ID_VARIABLE;
    this.#fallbackProfileId = options.fallbackProfileId;
    this.#variables = {
      global: {
        ...DEFAULT_CREDENTIAL_ENVIRONMENT.global,
        ...options.variables?.global
      },
      cn: {
        ...DEFAULT_CREDENTIAL_ENVIRONMENT.cn,
        ...options.variables?.cn
      }
    };
    // Explicit values are validated above. Environment and fallback values are
    // deliberately observed lazily so a missing desktop keyring cannot prevent
    // public, unauthenticated tools from constructing.
  }

  get profileId(): string {
    const environmentProfile = configuredValue(this.#env[this.#profileIdVariable]);
    return normalizeProfileId(
      this.#explicitProfileId ??
        environmentProfile ??
        this.#fallbackProfileId?.() ??
        DEFAULT_PROFILE_ID
    );
  }

  getSourceState(region: Region): CredentialSourceState {
    return sourceState(this.#env, this.#variables[region]);
  }

  async getCredentials(region: Region): Promise<CredentialBundle | undefined> {
    void this.getRevision();
    if (this.getSourceState(region) !== "ready") return undefined;
    const names = this.#variables[region];
    const session = configuredValue(this.#env[names.session]);
    const csrfToken = configuredValue(this.#env[names.csrfToken]);
    if (session === undefined || csrfToken === undefined) return undefined;

    return Object.freeze({
      profileId: this.profileId,
      region,
      session,
      csrfToken
    });
  }

  async getConfiguration(): Promise<CredentialConfigurationDescriptor> {
    void this.getRevision();
    const regionConfiguration = (
      region: Region
    ): RegionCredentialConfiguration => {
      const names = this.#variables[region];
      const sessionConfigured = configuredValue(this.#env[names.session]) !== undefined;
      const csrfConfigured = configuredValue(this.#env[names.csrfToken]) !== undefined;
      return Object.freeze({
        sessionConfigured,
        csrfConfigured,
        operationConfigured: sessionConfigured && csrfConfigured
      });
    };

    return Object.freeze({
      profileId: this.profileId,
      regions: Object.freeze({
        global: regionConfiguration("global"),
        cn: regionConfiguration("cn")
      })
    });
  }

  isConfigured(
    region: Region,
    _requirement: "session" | "operation" = "session"
  ): boolean {
    void this.getRevision();
    // Environment credentials are an atomic bundle. A half bundle must not be
    // treated as read-ready and must shadow the keyring fallback.
    return this.getSourceState(region) === "ready";
  }

  getActiveProfileId(): string | undefined {
    void this.getRevision();
    return this.isConfigured("global") || this.isConfigured("cn")
      ? this.profileId
      : undefined;
  }

  getRevision(): number {
    const values: (string | null)[] = [this.profileId];
    for (const region of ["global", "cn"] as const) {
      const names = this.#variables[region];
      values.push(
        this.#env[names.session] ?? null,
        this.#env[names.csrfToken] ?? null
      );
    }
    const fingerprint = createHmac("sha256", this.#revisionKey)
      .update(JSON.stringify(values), "utf8")
      .digest("hex");
    if (fingerprint !== this.#revisionFingerprint) {
      this.#revisionFingerprint = fingerprint;
      this.#revision += 1;
    }
    return this.#revision;
  }

  async requireCredentials(region: Region): Promise<CredentialBundle> {
    const credentials = await this.getCredentials(region);
    if (credentials === undefined) {
      throw new CredentialsUnavailableError(region);
    }

    return credentials;
  }
}
