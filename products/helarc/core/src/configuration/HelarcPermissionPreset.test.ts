import { describe, expect, it } from "vitest";
import { resolveHelarcPermissionPreset } from "./HelarcPermissionPreset.js";

describe("Helarc permission presets", () => {
  it.each([
    ["ask_for_approval", ":workspace", "on-request", "user"],
    ["approve_for_me", ":workspace", "on-request", "auto_review"],
    ["full_access", ":danger-full-access", "never", null],
  ] as const)(
    "maps %s to immutable product permission semantics",
    (preset, baseProfileId, approvalPolicy, reviewerKind) => {
      const definition = resolveHelarcPermissionPreset(preset);

      expect(definition).toEqual({
        preset,
        baseProfileId,
        approvalPolicy,
        reviewerKind,
      });
      expect(Object.isFrozen(definition)).toBe(true);
      expect(resolveHelarcPermissionPreset(preset)).toBe(definition);
    },
  );

  it("rejects an unknown runtime preset", () => {
    expect(() => resolveHelarcPermissionPreset("unknown" as never)).toThrow(
      "Unknown Helarc permission preset",
    );
  });
});
