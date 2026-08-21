import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";

export interface ToolKey {
  readonly namespace: string;
  readonly name: string;
}

export interface ToolRevisionRef {
  readonly tool: ToolKey;
  readonly revision: string;
}

export interface ToolSchemaRevisionRefs {
  readonly dialect: string;
  readonly input: string;
  readonly output: string | null;
  readonly translation: string;
}

export interface ToolOperationBindingRef {
  readonly kind: "operation";
  readonly operation: OperationRevisionRef;
  readonly revision: string;
}

export interface ToolInteractionBindingRef {
  readonly kind: "interaction";
  readonly protocol: {
    readonly owner: string;
    readonly kind: string;
    readonly revision: string;
  };
  readonly blockingScope: "none" | "branch" | "run";
  readonly revision: string;
}

export interface ToolDescendantAgentBindingRef {
  readonly kind: "descendant_agent";
  readonly agent: {
    readonly id: string;
    readonly revision: string;
  };
  readonly revision: string;
}

export type ToolBindingRef =
  | ToolOperationBindingRef
  | ToolInteractionBindingRef
  | ToolDescendantAgentBindingRef;

export interface ToolSourceRef {
  readonly kind: "harness" | "product" | "mcp" | "plugin" | "remote";
  readonly sourceId: string;
  readonly sourceRevision: string | null;
  readonly activationEpoch: number | null;
}

export function toolRevisionKey(ref: ToolRevisionRef): string {
  return `${ref.tool.namespace}/${ref.tool.name}@${ref.revision}`;
}
