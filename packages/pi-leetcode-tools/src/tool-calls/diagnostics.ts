import type { Static } from "typebox";

import type {
  CapabilityManifest,
  Region,
  ToolErrorCode,
  ToolResult
} from "../types.js";
import {
  BEHAVIOR_MANIFEST_DIGEST,
  CAPABILITY_MANIFEST_DIGEST,
  CONTRACT_VERSION,
  DiagnosticsSnapshotSchema,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_DIGEST,
  type ToolName
} from "./contract.js";

export type DiagnosticsSnapshot = Static<typeof DiagnosticsSnapshotSchema>;

export type DiagnosticsOperation =
  | ToolName
  | "notes.read"
  | "notes.write"
  | "notes.search"
  | "notes.get"
  | "notes.create"
  | "notes.update"
  | "user.status"
  | "gateway";

interface RegionDiagnosticsState {
  queueDepth: number;
  queueLimit: number;
  circuitState: "unknown" | "closed" | "open" | "half_open";
  nextProbeAt?: string;
  lastSafeErrorCode?: ToolErrorCode;
}

type RegionReadinessLike = {
  configured?: boolean;
  sessionConfigured?: boolean;
  operationConfigured?: boolean;
};

function regionReadiness(
  manifest: CapabilityManifest,
  region: Region
): Required<RegionReadinessLike> {
  const readiness = (
    manifest as CapabilityManifest & {
      regionReadiness?: Record<Region, RegionReadinessLike>;
    }
  ).regionReadiness?.[region];
  const capabilityReadiness = manifest.regionReadiness[region];

  const sessionConfigured =
    readiness?.sessionConfigured ??
    capabilityReadiness.sessionReads !== false;
  const operationConfigured =
    readiness?.operationConfigured ??
    capabilityReadiness.execution !== false;

  return {
    configured: readiness?.configured ?? capabilityReadiness.configured,
    sessionConfigured,
    operationConfigured
  };
}

function safeEpoch(value: Date): number {
  const epoch = value.getTime();
  return Number.isFinite(epoch) ? epoch : 0;
}

/**
 * Maintains the bounded, redacted diagnostic state exposed by the non-model RPC.
 * It deliberately observes only normalized ToolResult fields and never stores inputs,
 * error messages, error details, code, notes, paths, credentials, or remote payloads.
 */
export class GatewayDiagnostics {
  readonly #now: () => Date;
  readonly #regions: Record<Region, RegionDiagnosticsState> = {
    global: { queueDepth: 0, queueLimit: 0, circuitState: "unknown" },
    cn: { queueDepth: 0, queueLimit: 0, circuitState: "unknown" }
  };
  #storageWritable = false;
  #snapshotRevision = 0;
  #lastObservedEpoch = -1;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  updateQueue(region: Region, depth: number, limit: number): void {
    const state = this.#regions[region];
    state.queueDepth = Math.max(0, Math.trunc(depth));
    state.queueLimit = Math.max(0, Math.trunc(limit));
  }

  observe(
    operation: DiagnosticsOperation,
    region: Region,
    result: ToolResult<unknown>
  ): void {
    const state = this.#regions[region];

    if (result.ok) {
      state.circuitState = "closed";
      delete state.nextProbeAt;
      if (operation === "lc_run" || operation === "lc_submit") {
        this.#storageWritable = true;
      }
      return;
    }

    state.lastSafeErrorCode = result.error.code;

    if (result.error.code === "RATE_LIMITED") {
      state.queueDepth = Math.max(state.queueDepth, state.queueLimit);
    }

    if (
      result.error.code === "REMOTE_UNAVAILABLE" &&
      result.error.details?.circuitOpen === true
    ) {
      state.circuitState = "open";
      if (result.error.retryAfterMs !== undefined) {
        state.nextProbeAt = new Date(
          safeEpoch(this.#now()) + result.error.retryAfterMs
        ).toISOString();
      }
    }

    if (
      (operation === "lc_run" || operation === "lc_submit") &&
      result.error.code === "CAPABILITY_UNAVAILABLE"
    ) {
      this.#storageWritable = false;
    }
  }

  getSnapshot(manifest: CapabilityManifest): DiagnosticsSnapshot {
    const nowEpoch = Math.max(safeEpoch(this.#now()), this.#lastObservedEpoch + 1);
    this.#lastObservedEpoch = nowEpoch;
    this.#snapshotRevision += 1;

    return {
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest: SCHEMA_DIGEST,
      behaviorManifestDigest: BEHAVIOR_MANIFEST_DIGEST,
      capabilityManifestDigest: CAPABILITY_MANIFEST_DIGEST,
      providerId: manifest.providerId,
      instanceId: manifest.instanceId,
      contextRevision: manifest.contextRevision,
      ...(manifest.activeAccountProfileId === undefined
        ? {}
        : { activeAccountProfileId: manifest.activeAccountProfileId }),
      storageWritable: this.#storageWritable,
      providerConflict: false,
      regions: {
        global: this.#regionSnapshot(manifest, "global"),
        cn: this.#regionSnapshot(manifest, "cn")
      },
      observedAt: new Date(nowEpoch).toISOString(),
      snapshotRevision: this.#snapshotRevision
    };
  }

  #regionSnapshot(manifest: CapabilityManifest, region: Region) {
    const readiness = regionReadiness(manifest, region);
    const state = this.#regions[region];
    return {
      ...readiness,
      queueDepth: state.queueDepth,
      queueLimit: state.queueLimit,
      circuitState: state.circuitState,
      ...(state.nextProbeAt === undefined ? {} : { nextProbeAt: state.nextProbeAt }),
      ...(state.lastSafeErrorCode === undefined
        ? {}
        : { lastSafeErrorCode: state.lastSafeErrorCode })
    };
  }
}
