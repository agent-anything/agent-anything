import type { CompositeResult } from "./CompositeResult.js";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import { readOperationLimitFailureDetail, type OperationLimitFailureDetail } from "@agent-anything/operation-catalog/result";

const MAX_CHILDREN = 32;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_DEPTH = 4;

export interface CompositeResultSummary {
  readonly compositeId: string;
  readonly status: string;
  readonly childCount: number;
  readonly omittedChildCount: number;
  readonly children: readonly Readonly<{
    nodeId: string;
    instance: number;
    status: string;
    operation: OperationRevisionRef | null;
    resultId: string | null;
    failure: Readonly<{owner: string; code: string; message: string; messageTruncated: boolean; detail?: OperationLimitFailureDetail}> | null;
    effectCertainty: string | null;
    completionExtent: string | null;
    composite: CompositeResultSummary | null;
    nestedSummaryOmitted: boolean;
  }>[];
}

export function createCompositeResultSummary(result: CompositeResult): CompositeResultSummary {
  // Keep unsuccessful steps visible even when the graph exceeds the projection budget.
  const children = [...result.children].sort((a, b) =>
    Number(a.status === "succeeded" || a.status === "not_selected") -
    Number(b.status === "succeeded" || b.status === "not_selected"));
  return readCompositeResultSummary({
    compositeId: result.compositeId,
    status: result.status,
    childCount: children.length,
    children: children.slice(0, MAX_CHILDREN).map(child => {
      const physical = child.result?.lowerRefs.some(ref =>
        ref.owner === "canonical-action" && ref.kind === "action_settlement");
      const failure = child.result?.failure ?? child.failure;
      return {
        nodeId: child.nodeId, instance: child.instance, status: child.status,
        operation: child.result?.binding.operation ?? null,
        resultId: child.result?.ref.id ?? null,
        failure: failure === null ? null : {
          owner: child.result?.failure?.owner ?? "operation-composition",
          code: failure.code, message: failure.message,
          detail: child.result?.failure?.detail,
        },
        effectCertainty: physical ? child.result?.metadata.effectCertainty : null,
        completionExtent: physical ? child.result?.metadata.completionExtent : null,
        composite: child.result?.metadata.compositeSettlement ?? null,
      };
    }),
  })!;
}

// Metadata is not an authority to expose arbitrary payloads in model results.
export function readCompositeResultSummary(value: unknown): CompositeResultSummary | null {
  return readSummary(value, {remaining: MAX_CHILDREN}, 0);
}

function readSummary(value: unknown, budget: {remaining: number}, depth: number): CompositeResultSummary | null {
  const summary = record(value);
  if (summary === null || typeof summary.compositeId !== "string" ||
    typeof summary.status !== "string" || !Array.isArray(summary.children) ||
    typeof summary.childCount !== "number" || !Number.isSafeInteger(summary.childCount) ||
    summary.childCount < summary.children.length) return null;
  const children: CompositeResultSummary["children"][number][] = [];
  for (const value of summary.children.slice(0, MAX_CHILDREN)) {
    if (budget.remaining === 0) break;
    const child = record(value);
    if (child === null || typeof child.nodeId !== "string" || typeof child.status !== "string" ||
      typeof child.instance !== "number" || !Number.isSafeInteger(child.instance) || child.instance < 1) continue;
    budget.remaining -= 1;
    const operation = record(child.operation), identity = record(operation?.operation);
    const failure = record(child.failure);
    const detail = readOperationLimitFailureDetail(failure?.detail);
    const nested = child.composite == null || depth + 1 >= MAX_DEPTH || budget.remaining === 0
      ? null : readSummary(child.composite, budget, depth + 1);
    children.push(Object.freeze({
      nodeId: child.nodeId, instance: child.instance, status: child.status,
      operation: typeof identity?.namespace === "string" && typeof identity.name === "string" && typeof operation?.revision === "string"
        ? {operation: {namespace: identity.namespace, name: identity.name}, revision: operation.revision} : null,
      resultId: typeof child.resultId === "string" ? child.resultId : null,
      failure: typeof failure?.owner === "string" && typeof failure.code === "string" && typeof failure.message === "string"
        ? {owner: failure.owner, code: failure.code, message: failure.message.slice(0, MAX_MESSAGE_LENGTH),
          ...(detail === null ? {} : {detail}),
          messageTruncated: failure.messageTruncated === true || failure.message.length > MAX_MESSAGE_LENGTH} : null,
      effectCertainty: oneOf(child.effectCertainty, ["none", "confirmed", "partial", "unknown"]),
      completionExtent: oneOf(child.completionExtent, ["none", "partial", "complete", "unknown"]),
      composite: nested,
      nestedSummaryOmitted: child.nestedSummaryOmitted === true || (child.composite != null && nested === null),
    }));
  }
  return Object.freeze({
    compositeId: summary.compositeId, status: summary.status,
    childCount: summary.childCount,
    omittedChildCount: summary.childCount - children.length,
    children: Object.freeze(children),
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function oneOf(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}
