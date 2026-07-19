import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { Entry } from "@napi-rs/keyring";

import type { CredentialBundle, Region } from "../types.js";
import { asAuthError, AuthError } from "./auth-errors.js";
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_ID_VARIABLE,
  EnvCredentialProvider,
  normalizeProfileId,
  type CredentialConfigurationDescriptor,
  type CredentialProvider,
  type CredentialSourceState,
  type EnvCredentialProviderOptions,
  type RegionCredentialConfiguration
} from "./credentials.js";

/** The service name used for all Pi LeetCode credentials in the OS keyring. */
export const DEFAULT_CREDENTIAL_STORE_SERVICE = "pi-leetcode-tools";
const CREDENTIAL_RECORD_VERSION = 1;
const PROFILE_INDEX_VERSION = 1;
const ACTIVE_PROFILE_ACCOUNT = "__active_profile__";
const PROFILE_INDEX_ACCOUNT = "__profile_index__";
const CREDENTIAL_EPOCH_ACCOUNT = "__credential_epoch__";
const MAX_STORED_PROFILES = 256;

export interface StoredCredentialInput {
  session: string;
  csrfToken?: string;
  verifiedAt?: string;
  expiresAt?: string;
}

export interface StoredCredentialRegionMetadata {
  operationReady: boolean;
  verifiedAt?: string;
  expiresAt?: string;
}

export interface StoredCredentialProfile {
  profileId: string;
  regions: Readonly<Partial<Record<Region, StoredCredentialRegionMetadata>>>;
}

export interface CredentialReplaceOptions {
  activate?: boolean;
}

export interface CredentialStore {
  get(profileId: string, region: Region): CredentialBundle | undefined;
  set(profileId: string, region: Region, credentials: StoredCredentialInput): void;
  replace(
    profileId: string,
    region: Region,
    credentials: StoredCredentialInput,
    options?: CredentialReplaceOptions
  ): void;
  delete(profileId: string, region: Region): boolean;
  has(profileId: string, region: Region): boolean;
  listProfiles(): readonly StoredCredentialProfile[];
  getActiveProfileId(): string | undefined;
  setActiveProfileId(profileId: string): void;
  clearActiveProfileId(): void;
  /** Safe, opaque mutation epoch. It contains no credential-derived material. */
  getEpoch(): string;
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface OsKeyringCredentialStoreOptions {
  /** Test seam; production callers should use the native Entry implementation. */
  entryFactory?: (service: string, account: string) => KeyringEntry;
  revisionFactory?: () => string;
}

interface MutableProfileIndexEntry {
  profileId: string;
  regions: Partial<Record<Region, StoredCredentialRegionMetadata>>;
}

interface ProfileIndexRecord {
  version: number;
  profiles: MutableProfileIndexEntry[];
}

function validSecret(value: string, name: string, optional = false): string {
  if (optional && value.length === 0) return value;
  if (value.length === 0 || value.length > 16_384 || /[\u0000-\u0020\u007f;,]/u.test(value)) {
    throw new AuthError(
      "auth_credentials_incomplete",
      `The ${name} credential is missing or invalid`
    );
  }
  return value;
}

function validTimestamp(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AuthError("auth_invalid_arguments", `${name} must be a valid timestamp`);
  }
  return date.toISOString();
}

export function validateStoredCredentialInput(
  credentials: StoredCredentialInput
): Required<Pick<StoredCredentialInput, "session" | "csrfToken">> &
  Pick<StoredCredentialInput, "verifiedAt" | "expiresAt"> {
  const verifiedAt = validTimestamp(credentials.verifiedAt, "verifiedAt");
  const expiresAt = validTimestamp(credentials.expiresAt, "expiresAt");
  return {
    session: validSecret(credentials.session, "session"),
    csrfToken: validSecret(credentials.csrfToken ?? "", "CSRF token", true),
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt })
  };
}

function accountFor(profileId: string, region: Region): string {
  return `${normalizeProfileId(profileId)}:${region}`;
}

function encode(profileId: string, region: Region, credentials: StoredCredentialInput): string {
  const validated = validateStoredCredentialInput(credentials);
  return JSON.stringify({
    version: CREDENTIAL_RECORD_VERSION,
    profileId: normalizeProfileId(profileId),
    region,
    session: validated.session,
    csrfToken: validated.csrfToken
  });
}

function decode(raw: string, profileId: string, region: Region): CredentialBundle | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.version !== CREDENTIAL_RECORD_VERSION ||
      record.profileId !== profileId ||
      record.region !== region ||
      typeof record.session !== "string" ||
      typeof record.csrfToken !== "string"
    ) return undefined;
    validSecret(record.session, "session");
    validSecret(record.csrfToken, "CSRF token", true);
    return Object.freeze({
      profileId,
      region,
      session: record.session,
      csrfToken: record.csrfToken
    });
  } catch {
    // Malformed keyring values are treated as absent. They are never echoed.
    return undefined;
  }
}

function parseMetadata(value: unknown): StoredCredentialRegionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthError("credential_store_corrupt", "The credential profile index is invalid");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.operationReady !== "boolean") {
    throw new AuthError("credential_store_corrupt", "The credential profile index is invalid");
  }
  const verifiedAt =
    record.verifiedAt === undefined
      ? undefined
      : typeof record.verifiedAt === "string"
        ? validTimestamp(record.verifiedAt, "verifiedAt")
        : undefined;
  const expiresAt =
    record.expiresAt === undefined
      ? undefined
      : typeof record.expiresAt === "string"
        ? validTimestamp(record.expiresAt, "expiresAt")
        : undefined;
  if (
    (record.verifiedAt !== undefined && verifiedAt === undefined) ||
    (record.expiresAt !== undefined && expiresAt === undefined)
  ) {
    throw new AuthError("credential_store_corrupt", "The credential profile index is invalid");
  }
  return Object.freeze({
    operationReady: record.operationReady,
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt })
  });
}

function decodeIndex(raw: string | null): ProfileIndexRecord {
  if (raw === null || raw.length === 0) {
    return { version: PROFILE_INDEX_VERSION, profiles: [] };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (
      record.version !== PROFILE_INDEX_VERSION ||
      !Array.isArray(record.profiles) ||
      record.profiles.length > MAX_STORED_PROFILES
    ) throw new Error();
    const seen = new Set<string>();
    const profiles = record.profiles.map((item): MutableProfileIndexEntry => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error();
      const profile = item as Record<string, unknown>;
      if (typeof profile.profileId !== "string") throw new Error();
      const profileId = normalizeProfileId(profile.profileId);
      if (seen.has(profileId)) throw new Error();
      seen.add(profileId);
      if (typeof profile.regions !== "object" || profile.regions === null || Array.isArray(profile.regions)) {
        throw new Error();
      }
      const regionRecord = profile.regions as Record<string, unknown>;
      const regions: Partial<Record<Region, StoredCredentialRegionMetadata>> = {};
      for (const region of ["global", "cn"] as const) {
        if (regionRecord[region] !== undefined) regions[region] = parseMetadata(regionRecord[region]);
      }
      return { profileId, regions };
    });
    return { version: PROFILE_INDEX_VERSION, profiles };
  } catch (error) {
    if (error instanceof AuthError && error.code === "credential_store_corrupt") throw error;
    throw new AuthError("credential_store_corrupt", "The credential profile index is invalid", {
      cause: error
    });
  }
}

function encodeIndex(index: ProfileIndexRecord): string {
  return JSON.stringify({
    version: PROFILE_INDEX_VERSION,
    profiles: [...index.profiles]
      .sort((left, right) => left.profileId.localeCompare(right.profileId, "en"))
      .map((profile) => ({
        profileId: profile.profileId,
        regions: {
          ...(profile.regions.global === undefined ? {} : { global: profile.regions.global }),
          ...(profile.regions.cn === undefined ? {} : { cn: profile.regions.cn })
        }
      }))
  });
}

function nextActiveProfile(index: ProfileIndexRecord): string | undefined {
  const profileIds = index.profiles
    .filter((profile) => profile.regions.global !== undefined || profile.regions.cn !== undefined)
    .map((profile) => profile.profileId)
    .sort((left, right) => left.localeCompare(right, "en"));
  return profileIds.includes(DEFAULT_PROFILE_ID) ? DEFAULT_PROFILE_ID : profileIds[0];
}

export class OsKeyringCredentialStore implements CredentialStore {
  readonly #service: string;
  readonly #entryFactory: (service: string, account: string) => KeyringEntry;
  readonly #revisionFactory: () => string;

  constructor(options: OsKeyringCredentialStoreOptions = {}) {
    this.#service = DEFAULT_CREDENTIAL_STORE_SERVICE;
    this.#entryFactory = options.entryFactory ?? ((service, account) => new Entry(service, account));
    this.#revisionFactory = options.revisionFactory ?? randomUUID;
  }

  get(profileId: string, region: Region): CredentialBundle | undefined {
    const normalized = normalizeProfileId(profileId);
    const raw = this.#readRaw(accountFor(normalized, region));
    return raw === null || raw.length === 0 ? undefined : decode(raw, normalized, region);
  }

  set(profileId: string, region: Region, credentials: StoredCredentialInput): void {
    this.replace(profileId, region, credentials);
  }

  replace(
    profileId: string,
    region: Region,
    credentials: StoredCredentialInput,
    options: CredentialReplaceOptions = {}
  ): void {
    const normalized = normalizeProfileId(profileId);
    const validated = validateStoredCredentialInput(credentials);
    const credentialAccount = accountFor(normalized, region);
    const index = this.#readIndex();
    let profile = index.profiles.find((entry) => entry.profileId === normalized);
    if (profile === undefined) {
      if (index.profiles.length >= MAX_STORED_PROFILES) {
        throw new AuthError("credential_store_corrupt", "The credential profile limit was reached");
      }
      profile = { profileId: normalized, regions: {} };
      index.profiles.push(profile);
    }
    profile.regions[region] = Object.freeze({
      operationReady: validated.csrfToken.length > 0,
      ...(validated.verifiedAt === undefined ? {} : { verifiedAt: validated.verifiedAt }),
      ...(validated.expiresAt === undefined ? {} : { expiresAt: validated.expiresAt })
    });

    const accounts = [credentialAccount, PROFILE_INDEX_ACCOUNT, CREDENTIAL_EPOCH_ACCOUNT];
    if (options.activate === true) accounts.push(ACTIVE_PROFILE_ACCOUNT);
    this.#transaction(accounts, () => {
      this.#writeRaw(credentialAccount, encode(normalized, region, validated));
      this.#writeRaw(PROFILE_INDEX_ACCOUNT, encodeIndex(index));
      if (options.activate === true) this.#writeRaw(ACTIVE_PROFILE_ACCOUNT, normalized);
      this.#writeRaw(CREDENTIAL_EPOCH_ACCOUNT, this.#newEpoch());
    });
  }

  delete(profileId: string, region: Region): boolean {
    const normalized = normalizeProfileId(profileId);
    const credentialAccount = accountFor(normalized, region);
    if (this.#readRaw(credentialAccount) === null) return false;

    const index = this.#readIndex();
    const otherRegion: Region = region === "global" ? "cn" : "global";
    const otherCredential = this.get(normalized, otherRegion);
    let profile = index.profiles.find((entry) => entry.profileId === normalized);
    if (profile === undefined && otherCredential !== undefined) {
      if (index.profiles.length >= MAX_STORED_PROFILES) {
        throw new AuthError("credential_store_corrupt", "The credential profile limit was reached");
      }
      profile = {
        profileId: normalized,
        regions: {
          [otherRegion]: Object.freeze({
            operationReady: otherCredential.csrfToken.length > 0
          })
        }
      };
      index.profiles.push(profile);
    } else if (
      profile !== undefined &&
      otherCredential !== undefined &&
      profile.regions[otherRegion] === undefined
    ) {
      profile.regions[otherRegion] = Object.freeze({
        operationReady: otherCredential.csrfToken.length > 0
      });
    }
    if (profile !== undefined) {
      delete profile.regions[region];
      if (profile.regions.global === undefined && profile.regions.cn === undefined) {
        index.profiles = index.profiles.filter((entry) => entry.profileId !== normalized);
      }
    }

    const active = this.getActiveProfileId();
    const deletedProfileStillExists = otherCredential !== undefined;
    const activeMustChange = active === normalized && !deletedProfileStillExists;
    const successor = activeMustChange ? nextActiveProfile(index) : active;
    const accounts = [credentialAccount, PROFILE_INDEX_ACCOUNT, CREDENTIAL_EPOCH_ACCOUNT];
    if (activeMustChange) accounts.push(ACTIVE_PROFILE_ACCOUNT);
    this.#transaction(accounts, () => {
      this.#deleteRaw(credentialAccount);
      this.#writeRaw(PROFILE_INDEX_ACCOUNT, encodeIndex(index));
      if (activeMustChange) {
        if (successor === undefined) this.#deleteRaw(ACTIVE_PROFILE_ACCOUNT, true);
        else this.#writeRaw(ACTIVE_PROFILE_ACCOUNT, successor);
      }
      this.#writeRaw(CREDENTIAL_EPOCH_ACCOUNT, this.#newEpoch());
    });
    return true;
  }

  has(profileId: string, region: Region): boolean {
    return this.get(profileId, region) !== undefined;
  }

  listProfiles(): readonly StoredCredentialProfile[] {
    return Object.freeze(
      this.#readIndex().profiles.map((profile) =>
        Object.freeze({
          profileId: profile.profileId,
          regions: Object.freeze({
            ...(profile.regions.global === undefined ? {} : { global: profile.regions.global }),
            ...(profile.regions.cn === undefined ? {} : { cn: profile.regions.cn })
          })
        })
      )
    );
  }

  getActiveProfileId(): string | undefined {
    const value = this.#readRaw(ACTIVE_PROFILE_ACCOUNT);
    if (value === null || value.length === 0) return undefined;
    try {
      return normalizeProfileId(value);
    } catch (error) {
      throw new AuthError("credential_store_corrupt", "The active credential profile pointer is invalid", {
        cause: error
      });
    }
  }

  setActiveProfileId(profileId: string): void {
    const normalized = normalizeProfileId(profileId);
    let current: string | undefined;
    try {
      current = this.getActiveProfileId();
    } catch (error) {
      if (!(error instanceof AuthError) || error.code !== "credential_store_corrupt") throw error;
      current = undefined;
    }
    if (current === normalized) return;
    this.#transaction([ACTIVE_PROFILE_ACCOUNT, CREDENTIAL_EPOCH_ACCOUNT], () => {
      this.#writeRaw(ACTIVE_PROFILE_ACCOUNT, normalized);
      this.#writeRaw(CREDENTIAL_EPOCH_ACCOUNT, this.#newEpoch());
    });
  }

  clearActiveProfileId(): void {
    let activeExists = false;
    try {
      activeExists = this.getActiveProfileId() !== undefined;
    } catch (error) {
      if (!(error instanceof AuthError) || error.code !== "credential_store_corrupt") throw error;
      activeExists = true;
    }
    if (!activeExists) return;
    this.#transaction([ACTIVE_PROFILE_ACCOUNT, CREDENTIAL_EPOCH_ACCOUNT], () => {
      this.#deleteRaw(ACTIVE_PROFILE_ACCOUNT);
      this.#writeRaw(CREDENTIAL_EPOCH_ACCOUNT, this.#newEpoch());
    });
  }

  getEpoch(): string {
    const epoch = this.#readRaw(CREDENTIAL_EPOCH_ACCOUNT);
    if (epoch === null || epoch.length === 0) return "0";
    if (epoch.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(epoch)) {
      throw new AuthError("credential_store_corrupt", "The credential epoch is invalid");
    }
    return epoch;
  }

  #entry(account: string): KeyringEntry {
    try {
      return this.#entryFactory(this.#service, account);
    } catch (error) {
      throw asAuthError(
        error,
        "credential_store_unavailable",
        "The operating-system credential store is unavailable"
      );
    }
  }

  #readRaw(account: string): string | null {
    try {
      return this.#entry(account).getPassword();
    } catch (error) {
      throw asAuthError(
        error,
        "credential_store_unavailable",
        "The operating-system credential store is unavailable"
      );
    }
  }

  #writeRaw(account: string, value: string): void {
    try {
      this.#entry(account).setPassword(value);
    } catch (error) {
      throw asAuthError(
        error,
        "credential_store_unavailable",
        "The operating-system credential store is unavailable"
      );
    }
  }

  #deleteRaw(account: string, allowAbsent = false): void {
    try {
      const deleted = this.#entry(account).deletePassword();
      if (!deleted && !allowAbsent) {
        throw new AuthError(
          "credential_store_unavailable",
          "The operating-system credential store could not complete the update"
        );
      }
    } catch (error) {
      throw asAuthError(
        error,
        "credential_store_unavailable",
        "The operating-system credential store is unavailable"
      );
    }
  }

  #readIndex(): ProfileIndexRecord {
    return decodeIndex(this.#readRaw(PROFILE_INDEX_ACCOUNT));
  }

  #newEpoch(): string {
    const value = this.#revisionFactory();
    if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
      throw new AuthError("credential_store_corrupt", "The credential revision factory returned an invalid value");
    }
    return value;
  }

  #transaction(accounts: readonly string[], update: () => void): void {
    const uniqueAccounts = [...new Set(accounts)];
    const snapshots = new Map<string, string | null>();
    for (const account of uniqueAccounts) snapshots.set(account, this.#readRaw(account));
    try {
      update();
    } catch (error) {
      let rollbackFailure: unknown;
      for (const account of [...uniqueAccounts].reverse()) {
        try {
          const previous = snapshots.get(account) ?? null;
          if (previous === null) this.#deleteRaw(account, true);
          else this.#writeRaw(account, previous);
        } catch (rollbackError) {
          rollbackFailure ??= rollbackError;
        }
      }
      if (rollbackFailure !== undefined) {
        throw new AuthError(
          "credential_store_rollback_failed",
          "The credential store update failed and could not be rolled back safely",
          { cause: rollbackFailure }
        );
      }
      throw asAuthError(
        error,
        "credential_store_unavailable",
        "The operating-system credential store update failed"
      );
    }
  }
}

export function createDefaultCredentialStore(): CredentialStore {
  return new OsKeyringCredentialStore();
}

export interface StoredCredentialProviderOptions {
  store?: CredentialStore;
  profileId?: string;
  resolveProfileId?: () => string;
}

export class StoredCredentialProvider implements CredentialProvider {
  readonly #store: CredentialStore;
  readonly #explicitProfileId: string;
  readonly #resolveProfileId: (() => string) | undefined;
  readonly #revisionKey = randomBytes(32);
  #revisionFingerprint: string | undefined;
  #revision = 0;

  constructor(options: StoredCredentialProviderOptions = {}) {
    this.#store = options.store ?? createDefaultCredentialStore();
    this.#explicitProfileId = options.profileId === undefined
      ? DEFAULT_PROFILE_ID
      : normalizeProfileId(options.profileId);
    this.#resolveProfileId = options.resolveProfileId;
  }

  get profileId(): string {
    return normalizeProfileId(this.#resolveProfileId?.() ?? this.#explicitProfileId);
  }

  async getCredentials(region: Region): Promise<CredentialBundle | undefined> {
    void this.getRevision();
    return this.#store.get(this.profileId, region);
  }

  getSourceState(region: Region): CredentialSourceState {
    return this.#store.get(this.profileId, region) === undefined ? "absent" : "ready";
  }

  isConfigured(region: Region, requirement: "session" | "operation" = "session"): boolean {
    try {
      void this.getRevision();
      const credentials = this.#store.get(this.profileId, region);
      return credentials !== undefined &&
        (requirement === "session" || credentials.csrfToken.length > 0);
    } catch {
      return false;
    }
  }

  getActiveProfileId(): string | undefined {
    return this.isConfigured("global") || this.isConfigured("cn") ? this.profileId : undefined;
  }

  getRevision(): number {
    const profileId = this.profileId;
    const global = this.#store.get(profileId, "global");
    const cn = this.#store.get(profileId, "cn");
    const fingerprint = createHmac("sha256", this.#revisionKey)
      .update(this.#store.getEpoch(), "utf8")
      .update("\0", "utf8")
      .update(profileId, "utf8")
      .update("\0", "utf8")
      .update(global?.session ?? "", "utf8")
      .update("\0", "utf8")
      .update(global?.csrfToken ?? "", "utf8")
      .update("\0", "utf8")
      .update(cn?.session ?? "", "utf8")
      .update("\0", "utf8")
      .update(cn?.csrfToken ?? "", "utf8")
      .digest("hex");
    if (fingerprint !== this.#revisionFingerprint) {
      this.#revisionFingerprint = fingerprint;
      this.#revision += 1;
    }
    return this.#revision;
  }

  async getConfiguration(): Promise<CredentialConfigurationDescriptor> {
    void this.getRevision();
    const configuration = (region: Region): RegionCredentialConfiguration => {
      let credentials: CredentialBundle | undefined;
      try { credentials = this.#store.get(this.profileId, region); } catch { credentials = undefined; }
      const sessionConfigured = credentials !== undefined;
      const csrfConfigured = credentials !== undefined && credentials.csrfToken.length !== 0;
      return Object.freeze({
        sessionConfigured,
        csrfConfigured,
        operationConfigured: sessionConfigured && csrfConfigured
      });
    };
    return Object.freeze({
      profileId: this.profileId,
      regions: Object.freeze({ global: configuration("global"), cn: configuration("cn") })
    });
  }
}

export interface CompositeCredentialProviderOptions {
  providers: readonly CredentialProvider[];
}

export class CompositeCredentialProvider implements CredentialProvider {
  readonly #providers: readonly CredentialProvider[];
  #revisionFingerprint: string | undefined;
  #revision = 0;

  constructor(options: CompositeCredentialProviderOptions | readonly CredentialProvider[]) {
    this.#providers = Array.isArray(options)
      ? options
      : (options as CompositeCredentialProviderOptions).providers;
    if (this.#providers.length === 0) throw new Error("At least one credential provider is required");
  }

  async getCredentials(region: Region): Promise<CredentialBundle | undefined> {
    void this.getRevision();
    for (const provider of this.#providers) {
      const state = provider.getSourceState?.(region);
      if (state === "partial") return undefined;
      if (state === "absent") continue;
      const credentials = await provider.getCredentials(region);
      if (credentials !== undefined) return credentials;
      if (state === "ready") return undefined;
    }
    return undefined;
  }

  getSourceState(region: Region): CredentialSourceState {
    for (const provider of this.#providers) {
      let state: CredentialSourceState | undefined;
      try {
        state = provider.getSourceState?.(region);
      } catch {
        continue;
      }
      if (state !== undefined && state !== "absent") return state;
      if (state === undefined && (provider.isConfigured?.(region, "session") ?? false)) return "ready";
    }
    return "absent";
  }

  isConfigured(region: Region, requirement: "session" | "operation" = "session"): boolean {
    void this.getRevision();
    for (const provider of this.#providers) {
      let state: CredentialSourceState | undefined;
      try {
        state = provider.getSourceState?.(region);
      } catch {
        continue;
      }
      if (state === "partial") return false;
      if (state === "absent") continue;
      const sessionConfigured = provider.isConfigured?.(region, "session") ?? true;
      if (sessionConfigured) {
        return requirement === "session"
          ? true
          : (provider.isConfigured?.(region, "operation") ?? true);
      }
      if (state === "ready") return false;
    }
    return false;
  }

  getActiveProfileId(): string | undefined {
    void this.getRevision();
    for (const provider of this.#providers) {
      const profileId = provider.getActiveProfileId?.();
      if (profileId !== undefined) return profileId;
    }
    return undefined;
  }

  getRevision(): number {
    const revisions = this.#providers.map((provider, index) => {
      try {
        return {
          index,
          revision: provider.getRevision?.() ?? 0,
          profileId: provider.getActiveProfileId?.() ?? null,
          global: provider.getSourceState?.("global") ?? null,
          cn: provider.getSourceState?.("cn") ?? null,
          available: true
        };
      } catch {
        return {
          index,
          revision: -1,
          profileId: null,
          global: null,
          cn: null,
          available: false
        };
      }
    });
    const fingerprint = JSON.stringify(revisions);
    if (fingerprint !== this.#revisionFingerprint) {
      this.#revisionFingerprint = fingerprint;
      this.#revision += 1;
    }
    return this.#revision;
  }

  async getConfiguration(): Promise<CredentialConfigurationDescriptor> {
    void this.getRevision();
    const descriptors = await Promise.all(
      this.#providers.map((provider) =>
        Promise.resolve()
          .then(() => provider.getConfiguration?.())
          .catch(() => undefined)
      )
    );
    const profileId = this.getActiveProfileId() ??
      descriptors.find((descriptor) => descriptor !== undefined)?.profileId ??
      DEFAULT_PROFILE_ID;
    const regionConfiguration = (region: Region): RegionCredentialConfiguration => {
      for (let index = 0; index < this.#providers.length; index += 1) {
        const provider = this.#providers[index];
        const descriptor = descriptors[index];
        let state: CredentialSourceState | undefined;
        try {
          state = provider?.getSourceState?.(region);
        } catch {
          state = "absent";
        }
        if (state === "absent") continue;
        if (state === "partial" || state === "ready") {
          return descriptor?.regions[region] ?? {
            sessionConfigured: false,
            csrfConfigured: false,
            operationConfigured: false
          };
        }
        const candidate = descriptor?.regions[region];
        if (candidate?.sessionConfigured === true || candidate?.csrfConfigured === true) return candidate;
      }
      return {
        sessionConfigured: false,
        csrfConfigured: false,
        operationConfigured: false
      };
    };
    return Object.freeze({
      profileId,
      regions: Object.freeze({
        global: Object.freeze(regionConfiguration("global")),
        cn: Object.freeze(regionConfiguration("cn"))
      })
    });
  }
}

export interface DefaultCredentialProviderOptions {
  env?: EnvCredentialProviderOptions;
  store?: CredentialStore;
}

export function createDefaultCredentialProvider(
  options: DefaultCredentialProviderOptions = {}
): CredentialProvider {
  const store = options.store ?? createDefaultCredentialStore();
  const configuredFallback = options.env?.fallbackProfileId;
  const environment = new EnvCredentialProvider({
    ...options.env,
    fallbackProfileId:
      configuredFallback ?? (() => {
        try {
          return store.getActiveProfileId() ?? DEFAULT_PROFILE_ID;
        } catch {
          return DEFAULT_PROFILE_ID;
        }
      })
  });
  const stored = new StoredCredentialProvider({
    store,
    resolveProfileId: () => environment.profileId
  });
  return new CompositeCredentialProvider({ providers: [environment, stored] });
}
