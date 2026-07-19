import { randomUUID } from "node:crypto";

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import type { CapabilityManifest, Region, ToolMeta, ToolResult } from "../types.js";
import {
  CONTRACT_VERSION,
  DEACTIVATED_CHANNEL,
  DEFAULT_RPC_TIMEOUT_MS,
  DISCOVERY_CHANNEL,
  GatewayDiscoveryRequestSchema,
  GatewayDiscoveryResponseSchema,
  GatewayLifecycleEventSchema,
  GATEWAY_RPC_METHODS,
  GatewayRpcRequestSchema,
  PROTOCOL_VERSION,
  READY_CHANNEL,
  RPC_CHANNEL,
  type GatewayRpcMethodName
} from "./contract.js";
import {
  createGatewayFailure,
  type GatewayInteractionBridge,
  type ToolGateway
} from "./gateway.js";

const MAX_RPC_PAYLOAD_BYTES = 1024 * 1024;
const LONG_OPERATION_RPC_OVERHEAD_MS = 30_000;
const MAX_LONG_OPERATION_RPC_TIMEOUT_MS = 330_000;

export type GatewayRpcMethod = GatewayRpcMethodName;

export interface GatewayDiscoveryRequest {
  protocolVersion: string;
  requestId: string;
  respond(response: GatewayDiscoveryResponse): void;
}

export interface GatewayDiscoveryResponse {
  protocolVersion: string;
  requestId: string;
  descriptor: CapabilityManifest;
}

export interface GatewayRpcRequest {
  protocolVersion: string;
  requestId: string;
  providerId: string;
  instanceId: string;
  contextRevision: number;
  method: GatewayRpcMethod;
  params: unknown;
  deadlineAt: number;
  respond(response: GatewayRpcResponse): void;
}

export interface GatewayRpcResponse {
  protocolVersion: string;
  requestId: string;
  providerId: string;
  instanceId: string;
  contextRevision: number;
  result: ToolResult<unknown>;
}

export interface GatewayLifecycleEvent {
  descriptor: CapabilityManifest;
}

export interface GatewayProviderOptions {
  interaction?: GatewayInteractionBridge;
  now?: () => number;
  maxConcurrentRpc?: number;
}

export interface GatewayProviderRegistration {
  descriptor: CapabilityManifest;
  deactivate(): void;
}

export interface GatewayDiscoveryAggregate {
  status: "none" | "unique" | "conflict";
  conflict: boolean;
  descriptors: CapabilityManifest[];
  descriptor?: CapabilityManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function rpcTimeoutMs(payload: GatewayRpcRequest): number {
  if (payload.method !== "tool.execute" || !isRecord(payload.params)) {
    return DEFAULT_RPC_TIMEOUT_MS;
  }
  const tool = payload.params.tool;
  const input = payload.params.input;
  if (
    (tool !== "lc_run" && tool !== "lc_submit") ||
    !isRecord(input) ||
    typeof input.timeoutMs !== "number" ||
    !Number.isFinite(input.timeoutMs)
  ) {
    return DEFAULT_RPC_TIMEOUT_MS;
  }
  return Math.min(
    MAX_LONG_OPERATION_RPC_TIMEOUT_MS,
    Math.max(DEFAULT_RPC_TIMEOUT_MS, input.timeoutMs + LONG_OPERATION_RPC_OVERHEAD_MS)
  );
}

function isDiscoveryRequest(value: unknown): value is GatewayDiscoveryRequest {
  return (
    Check(GatewayDiscoveryRequestSchema, value) &&
    isRecord(value) &&
    typeof value.respond === "function"
  );
}

function isRpcMethod(value: unknown): value is GatewayRpcMethod {
  return (
    typeof value === "string" &&
    (GATEWAY_RPC_METHODS as readonly string[]).includes(value)
  );
}

function isRpcRequest(value: unknown): value is GatewayRpcRequest {
  return (
    isRecord(value) &&
    typeof value.protocolVersion === "string" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 128 &&
    typeof value.providerId === "string" &&
    typeof value.instanceId === "string" &&
    Number.isSafeInteger(value.contextRevision) &&
    isRpcMethod(value.method) &&
    Number.isSafeInteger(value.deadlineAt) &&
    typeof value.respond === "function"
  );
}

function payloadWithinLimit(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_RPC_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

export function aggregateGatewayDiscoveryResponses(
  responses: readonly GatewayDiscoveryResponse[]
): GatewayDiscoveryAggregate {
  const descriptors = new Map<string, CapabilityManifest>();

  for (const response of responses) {
    if (!Check(GatewayDiscoveryResponseSchema, response)) {
      continue;
    }
    const descriptor = response.descriptor;
    const key = `${descriptor.providerId}\u0000${descriptor.instanceId}`;
    const current = descriptors.get(key);
    if (
      current === undefined ||
      descriptor.snapshotRevision > current.snapshotRevision
    ) {
      descriptors.set(key, descriptor);
    }
  }

  const uniqueDescriptors = [...descriptors.values()];
  if (uniqueDescriptors.length === 0) {
    return { status: "none", conflict: false, descriptors: [] };
  }
  if (uniqueDescriptors.length === 1) {
    return {
      status: "unique",
      conflict: false,
      descriptors: uniqueDescriptors,
      descriptor: uniqueDescriptors[0]!
    };
  }
  return { status: "conflict", conflict: true, descriptors: uniqueDescriptors };
}

function safeRespond<T>(respond: (response: T) => void): (response: T) => void {
  let used = false;
  return (response) => {
    if (used) {
      return;
    }
    used = true;
    try {
      respond(response);
    } catch {
      // A consumer-owned callback must not break the provider event loop.
    }
  };
}

function rpcMeta(descriptor: CapabilityManifest, requestId: string): ToolMeta {
  return {
    region: "global",
    packageVersion: descriptor.packageVersion,
    contractVersion: descriptor.contractVersion,
    schemaDigest: descriptor.schemaDigest,
    behaviorManifestDigest: descriptor.behaviorManifestDigest,
    instanceId: descriptor.instanceId,
    contextRevision: descriptor.contextRevision,
    ...(descriptor.activeAccountProfileId === undefined
      ? {}
      : { accountProfileId: descriptor.activeAccountProfileId }),
    requestId
  };
}

function requestRegion(request: GatewayRpcRequest): Region {
  if (isRecord(request.params)) {
    const directRegion = request.params.region;
    if (directRegion === "cn") {
      return "cn";
    }
    const input = request.params.input;
    if (isRecord(input) && input.region === "cn") {
      return "cn";
    }
  }
  if (
    request.method === "notes.search" ||
    request.method === "notes.get" ||
    request.method === "notes.create" ||
    request.method === "notes.update"
  ) {
    return "cn";
  }
  return "global";
}

export function registerGatewayProvider(
  events: EventBus,
  gateway: ToolGateway,
  options: GatewayProviderOptions = {}
): GatewayProviderRegistration {
  const initialDescriptor = gateway.getCapabilities();
  const now = options.now ?? Date.now;
  const maxConcurrentRpc = Math.max(1, Math.min(options.maxConcurrentRpc ?? 8, 64));
  let active = true;
  let activeRpc = 0;
  const activeRpcByRegion: Record<Region, number> = { global: 0, cn: 0 };

  gateway.updateDiagnosticsQueue("global", 0, maxConcurrentRpc);
  gateway.updateDiagnosticsQueue("cn", 0, maxConcurrentRpc);

  function hasOtherProvider(): boolean {
    const responses: GatewayDiscoveryResponse[] = [];
    events.emit(DISCOVERY_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      respond(response: GatewayDiscoveryResponse) {
        responses.push(response);
      }
    } satisfies GatewayDiscoveryRequest);
    const aggregate = aggregateGatewayDiscoveryResponses(responses);
    return aggregate.descriptors.some(
      (descriptor) =>
        descriptor.providerId !== initialDescriptor.providerId ||
        descriptor.instanceId !== initialDescriptor.instanceId
    );
  }

  gateway.setProviderConflict(hasOtherProvider());

  const unsubscribeDiscovery = events.on(DISCOVERY_CHANNEL, (payload) => {
    if (!active || !isDiscoveryRequest(payload)) {
      return;
    }

    safeRespond(payload.respond)({
      protocolVersion: PROTOCOL_VERSION,
      requestId: payload.requestId,
      descriptor: gateway.getCapabilities()
    });
  });

  const unsubscribeReady = events.on(READY_CHANNEL, (payload) => {
    if (!active || !Check(GatewayLifecycleEventSchema, payload) || !isRecord(payload)) {
      return;
    }
    const descriptor = payload.descriptor as unknown as CapabilityManifest;
    if (
      descriptor.providerId !== initialDescriptor.providerId ||
      descriptor.instanceId !== initialDescriptor.instanceId
    ) {
      gateway.setProviderConflict(true);
    }
  });

  const unsubscribeDeactivated = events.on(DEACTIVATED_CHANNEL, (payload) => {
    if (!active || !Check(GatewayLifecycleEventSchema, payload) || !isRecord(payload)) {
      return;
    }
    const descriptor = payload.descriptor as unknown as CapabilityManifest;
    if (
      descriptor.providerId === initialDescriptor.providerId &&
      descriptor.instanceId !== initialDescriptor.instanceId
    ) {
      gateway.setProviderConflict(hasOtherProvider());
    }
  });

  const unsubscribeRpc = events.on(RPC_CHANNEL, (payload) => {
    if (!active || !isRpcRequest(payload) || payload.providerId !== initialDescriptor.providerId) {
      return;
    }

    const respond = safeRespond(payload.respond);
    const send = (result: ToolResult<unknown>, observeFailure = true): void => {
      const descriptor = gateway.getCapabilities();
      if (observeFailure && !result.ok) {
        gateway.recordDiagnosticsResult("gateway", requestRegion(payload), result);
      }
      respond({
        protocolVersion: PROTOCOL_VERSION,
        requestId: payload.requestId,
        providerId: descriptor.providerId,
        instanceId: descriptor.instanceId,
        contextRevision: descriptor.contextRevision,
        result
      });
    };

    void (async () => {
      const descriptor = gateway.getCapabilities();
      const region = requestRegion(payload);

      const requestMatchesSchema: boolean = Check(GatewayRpcRequestSchema, payload);
      if (!requestMatchesSchema) {
        send(
          createGatewayFailure("VALIDATION_ERROR", "Gateway RPC request is invalid", {
            requestId: payload.requestId,
            region,
            manifest: descriptor
          })
        );
        return;
      }

      if (descriptor.tools.some((tool) => tool.reason === "provider_conflict")) {
        send(
          createGatewayFailure(
            "PROVIDER_CONFLICT",
            "Multiple active pi-leetcode-tools providers were detected",
            { requestId: payload.requestId, region, manifest: descriptor }
          )
        );
        return;
      }
      if (payload.protocolVersion !== PROTOCOL_VERSION) {
        send(
          createGatewayFailure("CONTRACT_MISMATCH", "Unsupported Gateway protocol version", {
            requestId: payload.requestId,
            region,
            manifest: descriptor
          })
        );
        return;
      }
      if (payload.instanceId !== descriptor.instanceId) {
        send(
          createGatewayFailure(
            "STALE_OPERATION",
            "The selected LeetCode Gateway instance is no longer active",
            {
              requestId: payload.requestId,
              region,
              manifest: descriptor,
              details: { currentInstanceId: descriptor.instanceId }
            }
          )
        );
        return;
      }
      if (payload.contextRevision !== descriptor.contextRevision) {
        send(
          createGatewayFailure("STALE_OPERATION", "The LeetCode Gateway context changed", {
            requestId: payload.requestId,
            region,
            manifest: descriptor,
            details: { currentContextRevision: descriptor.contextRevision }
          })
        );
        return;
      }
      if (!payloadWithinLimit(payload.params)) {
        send(
          createGatewayFailure("VALIDATION_ERROR", "Gateway RPC payload is invalid or too large", {
            requestId: payload.requestId,
            region,
            manifest: descriptor
          })
        );
        return;
      }

      const remainingMs = payload.deadlineAt - now();
      if (remainingMs <= 0) {
        send(
          createGatewayFailure("PROTOCOL_TIMEOUT", "Gateway RPC deadline has expired", {
            requestId: payload.requestId,
            region,
            manifest: descriptor
          })
        );
        return;
      }

      if (activeRpc >= maxConcurrentRpc) {
        send(
          createGatewayFailure("RATE_LIMITED", "Gateway RPC concurrency limit reached", {
            requestId: payload.requestId,
            region,
            retryable: true,
            manifest: descriptor
          })
        );
        return;
      }
      activeRpc += 1;
      activeRpcByRegion[region] += 1;
      gateway.updateDiagnosticsQueue(
        region,
        activeRpcByRegion[region],
        maxConcurrentRpc
      );

      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(new DOMException("RPC deadline exceeded", "TimeoutError")),
        Math.max(1, Math.min(remainingMs, rpcTimeoutMs(payload)))
      );
      try {
        let result: ToolResult<unknown>;
        let observedByGateway = false;
        switch (payload.method) {
          case "tool.execute": {
            if (
              !isRecord(payload.params) ||
              typeof payload.params.tool !== "string" ||
              !("input" in payload.params)
            ) {
              result = createGatewayFailure("VALIDATION_ERROR", "Invalid tool.execute params", {
                requestId: payload.requestId,
                region,
                manifest: descriptor
              });
            } else {
              observedByGateway = true;
              result = await gateway.execute(payload.params.tool, payload.params.input, {
                requestId: payload.requestId,
                signal: timeoutController.signal,
                ...(options.interaction === undefined
                  ? {}
                  : { interaction: options.interaction })
              });
            }
            break;
          }
          case "notes.capabilities":
            result = {
              ok: true,
              data: descriptor.notesPort,
              meta: rpcMeta(descriptor, payload.requestId)
            };
            break;
          case "notes.read":
            observedByGateway = true;
            result = await gateway.readNotes(payload.params, {
              requestId: payload.requestId,
              signal: timeoutController.signal
            });
            break;
          case "notes.write":
            observedByGateway = true;
            result = await gateway.writeNotes(payload.params, {
              requestId: payload.requestId,
              signal: timeoutController.signal,
              ...(options.interaction === undefined
                ? {}
                : { interaction: options.interaction })
            });
            break;
          case "notes.search":
            observedByGateway = true;
            result = await gateway.searchUserNotes(payload.params, {
              requestId: payload.requestId,
              signal: timeoutController.signal
            });
            break;
          case "notes.get":
            observedByGateway = true;
            result = await gateway.getUserNotes(payload.params, {
              requestId: payload.requestId,
              signal: timeoutController.signal
            });
            break;
          case "notes.create":
            observedByGateway = true;
            result = await gateway.createUserNote(payload.params, {
              requestId: payload.requestId,
              signal: timeoutController.signal,
              ...(options.interaction === undefined
                ? {}
                : { interaction: options.interaction })
            });
            break;
          case "notes.update":
            observedByGateway = true;
            result = await gateway.updateUserNote(payload.params, {
              requestId: payload.requestId,
              signal: timeoutController.signal,
              ...(options.interaction === undefined
                ? {}
                : { interaction: options.interaction })
            });
            break;
          case "user.status":
            observedByGateway = true;
            result = await gateway.getUserStatus(payload.params, {
              requestId: payload.requestId,
              signal: timeoutController.signal
            });
            break;
          case "diagnostics.getSnapshot":
            if (
              !isRecord(payload.params) ||
              Object.keys(payload.params).length !== 0
            ) {
              result = createGatewayFailure(
                "VALIDATION_ERROR",
                "diagnostics.getSnapshot params must be an empty object",
                { requestId: payload.requestId, region, manifest: descriptor }
              );
            } else {
              gateway.updateDiagnosticsQueue(
                region,
                Math.max(0, activeRpcByRegion[region] - 1),
                maxConcurrentRpc
              );
              result = {
                ok: true,
                data: gateway.getDiagnosticsSnapshot(),
                meta: rpcMeta(descriptor, payload.requestId)
              };
            }
            break;
        }
        if (
          timeoutController.signal.aborted &&
          !result.ok &&
          result.error.code === "CANCELLED"
        ) {
          result = createGatewayFailure("PROTOCOL_TIMEOUT", "Gateway RPC deadline expired", {
            requestId: payload.requestId,
            region,
            manifest: gateway.getCapabilities()
          });
          observedByGateway = false;
        }
        send(result, !observedByGateway);
      } finally {
        clearTimeout(timeout);
        activeRpc -= 1;
        activeRpcByRegion[region] = Math.max(0, activeRpcByRegion[region] - 1);
        gateway.updateDiagnosticsQueue(
          region,
          activeRpcByRegion[region],
          maxConcurrentRpc
        );
      }
    })().catch(() => {
      send(
        createGatewayFailure("REMOTE_UNAVAILABLE", "LeetCode Gateway request failed", {
          requestId: payload.requestId,
          retryable: true,
          manifest: gateway.getCapabilities()
        })
      );
    });
  });

  events.emit(READY_CHANNEL, {
    descriptor: gateway.getCapabilities()
  } satisfies GatewayLifecycleEvent);

  return {
    get descriptor() {
      return gateway.getCapabilities();
    },
    deactivate() {
      if (!active) {
        return;
      }

      active = false;
      unsubscribeDiscovery();
      unsubscribeRpc();
      unsubscribeReady();
      unsubscribeDeactivated();
      events.emit(DEACTIVATED_CHANNEL, {
        descriptor: gateway.getCapabilities()
      } satisfies GatewayLifecycleEvent);
    }
  };
}
