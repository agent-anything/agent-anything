/** Bounded public facts supplied by the owner of a rejected execution limit. */
export interface OperationLimitFailureDetail {
  readonly kind: "capacity" | "limit";
  readonly stage: string;
  readonly scope: { readonly owner: string; readonly kind: string };
  readonly limit: { readonly name: string; readonly count: number; readonly maximum: number };
  readonly description: string;
  readonly dispatch: "never_dispatched";
}

export function readOperationLimitFailureDetail(value: unknown): OperationLimitFailureDetail | null {
  const detail = record(value), scope = record(detail?.scope), limit = record(detail?.limit);
  if (detail === null || scope === null || limit === null ||
    (detail.kind !== "capacity" && detail.kind !== "limit") || detail.dispatch !== "never_dispatched" ||
    !token(detail.stage) || !token(scope.owner) || !token(scope.kind) || !token(limit.name) ||
    typeof detail.description !== "string" || detail.description.trim().length === 0 || detail.description.length > 1_000 ||
    typeof limit.count !== "number" || !Number.isSafeInteger(limit.count) ||
    typeof limit.maximum !== "number" || !Number.isSafeInteger(limit.maximum) ||
    limit.maximum <= 0 || limit.count < limit.maximum) return null;
  return Object.freeze({
    kind: detail.kind, stage: detail.stage,
    scope: Object.freeze({owner: scope.owner, kind: scope.kind}),
    limit: Object.freeze({name: limit.name, count: limit.count, maximum: limit.maximum}),
    description: detail.description, dispatch: detail.dispatch,
  });
}

function token(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[a-z][a-z0-9_.:-]*$/.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
