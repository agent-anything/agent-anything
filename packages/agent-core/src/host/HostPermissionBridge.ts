import type {
  PermissionDecision,
  PermissionRequest,
  PermissionService,
} from "@agent-anything/permission";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { HostEventSink } from "./HostEvent.js";
import { createHostEvent } from "./HostEvent.js";
import type { HostSessionId } from "./HostSession.js";

export type HostPermissionBridgeStatus =
  | "granted"
  | "denied"
  | "unavailable";

export interface HostPermissionBridgeResult {
  status: HostPermissionBridgeStatus;
  reason?: string;
  metadata?: Metadata;
}

export interface HostPermissionBridgeInput {
  sessionId: HostSessionId;
  request: PermissionRequest;
  metadata: Metadata;
}

export type HostPermissionBridge = (
  input: HostPermissionBridgeInput,
) => Promise<HostPermissionBridgeResult>;

export interface CreateHostPermissionServiceInput {
  sessionId: HostSessionId;
  bridge: HostPermissionBridge;
  eventSink?: HostEventSink;
  now?: () => ISODateTimeString;
  metadata?: Metadata;
}

export function createHostPermissionService(
  input: CreateHostPermissionServiceInput,
): PermissionService {
  return {
    async request(request): Promise<PermissionDecision> {
      const timestamp = input.now?.() ?? new Date().toISOString();
      await input.eventSink?.(createHostEvent({
        name: "host.permission.requested",
        sessionId: input.sessionId,
        taskId: request.taskId,
        timestamp,
        payload: {
          permissionRequest: request,
        },
        metadata: input.metadata,
      }));

      let decision: PermissionDecision;
      try {
        const result = await input.bridge({
          sessionId: input.sessionId,
          request,
          metadata: input.metadata ?? {},
        });
        decision = mapHostPermissionBridgeResult({
          request,
          result,
          decidedAt: input.now?.() ?? new Date().toISOString(),
        });
      } catch (error) {
        decision = {
          requestId: request.id,
          status: "denied",
          code: "permission_prompt_failed",
          reason: error instanceof Error ? error.message : "Host permission prompt failed.",
          decidedAt: input.now?.() ?? new Date().toISOString(),
          metadata: input.metadata,
        };
      }

      await input.eventSink?.(createHostEvent({
        name: "host.permission.resolved",
        sessionId: input.sessionId,
        taskId: request.taskId,
        timestamp: decision.decidedAt,
        payload: {
          permissionRequest: request,
          permissionDecision: decision,
        },
        metadata: input.metadata,
      }));

      return decision;
    },
  };
}

export interface MapHostPermissionBridgeResultInput {
  request: PermissionRequest;
  result: HostPermissionBridgeResult;
  decidedAt?: ISODateTimeString;
}

export function mapHostPermissionBridgeResult(
  input: MapHostPermissionBridgeResultInput,
): PermissionDecision {
  if (input.result.status === "granted") {
    return {
      requestId: input.request.id,
      status: "granted",
      reason: input.result.reason ?? "Granted by host permission bridge.",
      decidedAt: input.decidedAt ?? new Date().toISOString(),
      metadata: input.result.metadata,
    };
  }

  const code = input.result.status === "unavailable"
    ? "permission_unavailable"
    : "permission_denied";

  return {
    requestId: input.request.id,
    status: "denied",
    code,
    reason: input.result.reason ?? createDeniedReason(input.result.status),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
    metadata: input.result.metadata,
  };
}

function createDeniedReason(status: Exclude<HostPermissionBridgeStatus, "granted">): string {
  if (status === "unavailable") {
    return "Host permission bridge is unavailable.";
  }

  return "Denied by host permission bridge.";
}
