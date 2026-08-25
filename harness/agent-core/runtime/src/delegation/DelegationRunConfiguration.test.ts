import { describe, expect, it } from "vitest";
import type { DelegationAuthorityDimensionInput } from "./DelegationAuthority.js";
import { assertDelegationAuthorityRequestWithinCeiling } from "./DelegationRunConfiguration.js";

describe("delegated Run authority", () => {
  it("admits an equal or narrower request", () => {
    const ceiling = authorityDimensions();
    const requested = ceiling.map((dimension) => Object.freeze({
      ...dimension,
      allowed: dimension.kind === "workspace"
        ? Object.freeze([dimension.allowed[0]!])
        : dimension.allowed,
      required: Object.freeze([...dimension.required, "request-restriction"]),
    }));

    expect(() => assertDelegationAuthorityRequestWithinCeiling({
      requested,
      ceiling,
    })).not.toThrow();
  });

  it.each([
    "workspace",
    "tool",
    "permission",
    "action_execution",
    "validation",
    "disclosure",
  ] as const)("rejects widening the %s dimension", (kind) => {
    const ceiling = authorityDimensions();
    const requested = ceiling.map((dimension) => dimension.kind === kind
      ? Object.freeze({
          ...dimension,
          allowed: Object.freeze([...dimension.allowed, "unauthorized"]),
        })
      : dimension);

    expect(() => assertDelegationAuthorityRequestWithinCeiling({
      requested,
      ceiling,
    })).toThrow(`widens '${kind}'`);
  });

  it("rejects removal of a required restriction", () => {
    const ceiling = authorityDimensions();
    const requested = ceiling.map((dimension) => dimension.kind === "permission"
      ? Object.freeze({ ...dimension, required: Object.freeze([]) })
      : dimension);

    expect(() => assertDelegationAuthorityRequestWithinCeiling({
      requested,
      ceiling,
    })).toThrow("weakens 'permission'");
  });
});

function authorityDimensions(): readonly DelegationAuthorityDimensionInput[] {
  return Object.freeze([
    dimension("workspace", ["workspace-a", "workspace-b"]),
    dimension("tool", ["tool-a"]),
    dimension("permission", ["permission-a"], ["approval-required"]),
    dimension("action_execution", ["executor-a"]),
    dimension("validation", ["validation-a"]),
    dimension("disclosure", ["model", "runtime"], ["source-explicit"]),
  ]);
}

function dimension(
  kind: DelegationAuthorityDimensionInput["kind"],
  allowed: readonly string[],
  required: readonly string[] = [],
): DelegationAuthorityDimensionInput {
  return Object.freeze({
    kind,
    allowed: Object.freeze([...allowed]),
    required: Object.freeze([...required]),
  });
}
