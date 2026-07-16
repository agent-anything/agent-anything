import type { Metadata } from "@agent-anything/shared";
import type { PolicyDecision } from "./PolicyDecision.js";

export type ActionPolicyOperationKind =
  | "file_system"
  | "process"
  | "network"
  | "remote_tool"
  | "skill";

export type ActionPolicyEffectKind =
  | "file_system_read"
  | "file_system_write"
  | "process_spawn"
  | "network_connect"
  | "remote_tool_invoke";

export interface ActionPolicyCheckInput {
  readonly kind: "prepared_action";
  readonly checkId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionName: string;
  readonly actionFingerprint: string;
  readonly workspaceId: string;
  readonly workspaceTrustState: "trusted" | "restricted" | "unknown";
  readonly identity: {
    readonly kind: "user" | "service" | "anonymous";
    readonly id: string;
  };
  readonly environmentId: string;
  readonly operation: {
    readonly kind: ActionPolicyOperationKind;
    readonly targetKeys: readonly string[];
  };
  readonly effects: readonly {
    readonly kind: ActionPolicyEffectKind;
    readonly targetKeys: readonly string[];
  }[];
  readonly requestsAdditionalPermissions: boolean;
  readonly metadata: Readonly<Metadata>;
}

export interface ActionPolicyPort {
  evaluate(input: ActionPolicyCheckInput): Promise<PolicyDecision>;
}

export function createAllowAllActionPolicyPort(): ActionPolicyPort {
  return Object.freeze({
    async evaluate(input: ActionPolicyCheckInput) {
      return Object.freeze({
        checkId: input.checkId,
        status: "allowed" as const,
        decidedAt: new Date().toISOString(),
      });
    },
  });
}
