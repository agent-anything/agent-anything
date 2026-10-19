import type { ModelToolResult } from "@agent-anything/model-interaction";
import type { OperationLowerResultRef, OperationResult } from "@agent-anything/operation-catalog/result";
import { toolRevisionKey, type ToolRevisionRef } from "@agent-anything/tools/identity";
import type { ToolCall } from "@agent-anything/tools/invocation";
import type { OperationCorrelation } from "@agent-anything/operation-catalog/identity";

/** A trusted callable adapter; presenting a result never executes its operation. */
export interface ToolResultPresenter {
  readonly tool: ToolRevisionRef;
  readonly ref: { readonly id: string; readonly revision: string };
  /** Pure trusted locators, preserved even if the body cannot be presented. */
  references?(result: OperationResult): readonly OperationLowerResultRef[];
  present(result: OperationResult): {
    readonly output: unknown;
    readonly disposition: "complete" | "bounded";
  };
  /** Idempotent owner bookkeeping by call identity, after result commit. Not telemetry. */
  committed?(input: {
    readonly runId: string;
    readonly call: ToolCall;
    readonly correlation: OperationCorrelation;
    readonly resultRevision: string;
    readonly result: OperationResult;
    readonly presentation: ModelToolResult;
  }): void | Promise<void>;
}

export function snapshotToolResultPresenters(input: readonly ToolResultPresenter[]): readonly ToolResultPresenter[] {
  const keys = new Set<string>();
  return Object.freeze(input.map(presenter => {
    const key = toolRevisionKey(presenter.tool);
    if (keys.has(key) || typeof presenter.present !== "function" ||
        (presenter.committed !== undefined && typeof presenter.committed !== "function") ||
      (presenter.references !== undefined && typeof presenter.references !== "function") ||
        [presenter.tool.tool.namespace, presenter.tool.tool.name, presenter.tool.revision,
          presenter.ref.id, presenter.ref.revision].some(value => typeof value !== "string" || !value || value !== value.trim())) {
      throw new TypeError("Invalid or duplicate Tool result presenter binding.");
    }
    keys.add(key);
    return Object.freeze({tool: Object.freeze({tool: Object.freeze({...presenter.tool.tool}), revision: presenter.tool.revision}),
      ref: Object.freeze({...presenter.ref}), present: presenter.present.bind(presenter),
      ...(presenter.references === undefined ? {} : {references: presenter.references.bind(presenter)}),
      ...(presenter.committed === undefined ? {} : {committed: presenter.committed.bind(presenter)})});
  }));
}

export function presentToolResultReferences(presenter: ToolResultPresenter | undefined, result: OperationResult): readonly OperationLowerResultRef[] {
  const references = presenter?.references ? presenter.references(result) : [];
  if (!Array.isArray(references) || references.length > 16) throw new TypeError("Invalid result references.");
  const keys = new Set<string>();
  let characters = 0;
  return Object.freeze(Array.from(references, ref => {
    if (!ref || Object.keys(ref).some(key => !["owner", "kind", "id", "revision"].includes(key)) ||
        [ref.owner, ref.kind, ref.id].some(value => typeof value !== "string" || !value || value !== value.trim() || value.length > 1024) ||
        (ref.revision !== null && (typeof ref.revision !== "string" || !ref.revision || ref.revision !== ref.revision.trim() || ref.revision.length > 256))) {
      throw new TypeError("Invalid result reference.");
    }
    const key = JSON.stringify([ref.owner, ref.kind, ref.id, ref.revision]);
    characters += key.length;
    if (characters > 8192) throw new TypeError("Result reference capacity exceeded.");
    if (keys.has(key)) throw new TypeError("Duplicate result reference.");
    keys.add(key);
    return Object.freeze({owner: ref.owner, kind: ref.kind, id: ref.id, revision: ref.revision});
  }));
}
