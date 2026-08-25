import type { DelegationLimits } from "./DelegationRequest.js";

export interface DelegationResourceUsage {
  readonly controllerTurns: number;
  readonly actions: number;
  readonly contextBytes: number;
  readonly resultBytes: number;
}

export interface DelegationResourceCapacity extends DelegationResourceUsage {}

export type DelegationResourceReservation =
  | { readonly status: "accepted"; readonly requestId: string }
  | {
      readonly status: "rejected";
      readonly code: "delegation_resource_limit_exceeded";
    };

export interface DelegationResourceSettlement {
  readonly status: "settled" | "limit_exceeded";
  readonly usage: DelegationResourceUsage;
}

export class DelegationResourceLedger {
  private readonly reservations = new Map<string, DelegationResourceUsage>();
  private consumed: DelegationResourceUsage = zeroUsage();

  constructor(private readonly capacity: DelegationResourceCapacity) {
    assertUsage(capacity, "Delegation resource capacity");
  }

  reserve(requestId: string, limits: DelegationLimits): DelegationResourceReservation {
    token(requestId, "Delegation request id");
    if (this.reservations.has(requestId)) {
      throw new TypeError("Delegation resources are already reserved for this request.");
    }
    const requested = Object.freeze({
      controllerTurns: limits.maxControllerTurns,
      actions: limits.maxActions,
      contextBytes: limits.maxContextBytes,
      resultBytes: limits.maxResultBytes,
    });
    const reserved = sum([...this.reservations.values()]);
    if (resourceKeys.some((key) =>
      this.consumed[key] + reserved[key] + requested[key] > this.capacity[key])) {
      return Object.freeze({
        status: "rejected" as const,
        code: "delegation_resource_limit_exceeded" as const,
      });
    }
    this.reservations.set(requestId, requested);
    return Object.freeze({ status: "accepted" as const, requestId });
  }

  release(requestId: string): void {
    if (!this.reservations.delete(requestId)) {
      throw new TypeError("Delegation resource reservation does not exist.");
    }
  }

  settle(requestId: string, usage: DelegationResourceUsage): DelegationResourceSettlement {
    const reservation = this.reservations.get(requestId);
    if (reservation === undefined) {
      throw new TypeError("Delegation resource reservation does not exist.");
    }
    assertUsage(usage, "Delegation resource usage");
    this.reservations.delete(requestId);
    this.consumed = Object.freeze(resourceKeys.reduce<DelegationResourceUsage>(
      (current, key) => ({ ...current, [key]: this.consumed[key] + usage[key] }),
      zeroUsage(),
    ));
    const limitExceeded = resourceKeys.some((key) => usage[key] > reservation[key]) ||
      resourceKeys.some((key) => this.consumed[key] > this.capacity[key]);
    return Object.freeze({
      status: limitExceeded ? "limit_exceeded" as const : "settled" as const,
      usage: Object.freeze({ ...usage }),
    });
  }
}

export function createDelegationResourceCapacity(input: {
  readonly perDescendant: DelegationLimits;
  readonly maxTotalDescendants: number;
}): DelegationResourceCapacity {
  if (!Number.isSafeInteger(input.maxTotalDescendants) || input.maxTotalDescendants < 0) {
    throw new TypeError("Delegation total-descendant capacity must be a non-negative safe integer.");
  }
  return Object.freeze({
    controllerTurns: safeProduct(input.perDescendant.maxControllerTurns, input.maxTotalDescendants),
    actions: safeProduct(input.perDescendant.maxActions, input.maxTotalDescendants),
    contextBytes: safeProduct(input.perDescendant.maxContextBytes, input.maxTotalDescendants),
    resultBytes: safeProduct(input.perDescendant.maxResultBytes, input.maxTotalDescendants),
  });
}

const resourceKeys = [
  "controllerTurns",
  "actions",
  "contextBytes",
  "resultBytes",
] as const;

function zeroUsage(): DelegationResourceUsage {
  return { controllerTurns: 0, actions: 0, contextBytes: 0, resultBytes: 0 };
}

function sum(values: readonly DelegationResourceUsage[]): DelegationResourceUsage {
  return values.reduce<DelegationResourceUsage>(
    (current, value) => Object.freeze(resourceKeys.reduce<DelegationResourceUsage>(
      (next, key) => ({ ...next, [key]: next[key] + value[key] }),
      current,
    )),
    zeroUsage(),
  );
}

function assertUsage(input: DelegationResourceUsage, field: string): void {
  for (const key of resourceKeys) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
      throw new TypeError(`${field}.${key} must be a non-negative safe integer.`);
    }
  }
}

function safeProduct(left: number, right: number): number {
  const product = left * right;
  if (!Number.isSafeInteger(product) || product < 0) {
    throw new TypeError("Delegation resource capacity exceeds the supported range.");
  }
  return product;
}

function token(input: unknown, field: string): asserts input is string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
}
