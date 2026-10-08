import { strictRecord } from "./ModelInteractionContractValidation.js";

export type ModelThinkingSelection =
  | { readonly mode: "default" }
  | { readonly mode: "disabled" }
  | { readonly mode: "enabled"; readonly effort?: string };

export interface ModelThinkingCapability {
  readonly status: "known" | "unknown";
  readonly values: readonly (boolean | string)[];
  readonly defaultValue: boolean | string | null;
  readonly source: "endpoint" | "declaration" | "unknown";
}

export function snapshotModelThinkingSelection(value: ModelThinkingSelection): ModelThinkingSelection {
  strictRecord(value, "ModelThinkingSelection", ["mode", "effort"]);
  if (value.mode === "default" || value.mode === "disabled") {
    strictRecord(value, "ModelThinkingSelection", ["mode"]);
    return Object.freeze({ mode: value.mode });
  }
  if (value.mode !== "enabled") throw new TypeError("Thinking mode is invalid.");
  return Object.freeze({ mode: "enabled", ...(value.effort === undefined ? {} : {
    effort: effortToken(value.effort),
  }) });
}

export function snapshotModelThinkingCapability(value: ModelThinkingCapability): ModelThinkingCapability {
  strictRecord(value, "ModelThinkingCapability", ["status", "values", "defaultValue", "source"]);
  if (!Array.isArray(value.values) || value.values.length > 32 ||
    !["endpoint", "declaration", "unknown"].includes(value.source) ||
    !["known", "unknown"].includes(value.status)) throw new TypeError("Thinking capability is invalid.");
  const values = value.values.map(v => typeof v === "boolean" ? v : effortToken(v));
  if (new Set(values).size !== values.length ||
      (value.defaultValue !== null && !values.includes(value.defaultValue)) ||
      (value.status === "unknown" && (values.length !== 0 || value.defaultValue !== null || value.source !== "unknown")) ||
      (value.status === "known" && (values.length === 0 || value.source === "unknown"))) {
    throw new TypeError("Thinking capability values are inconsistent.");
  }
  return Object.freeze({ ...value, values: Object.freeze(values) });
}

export function resolveModelThinkingSelection(
  selection: ModelThinkingSelection, capability: ModelThinkingCapability,
): ModelThinkingSelection {
  const requested = snapshotModelThinkingSelection(selection);
  const support = snapshotModelThinkingCapability(capability);
  if (requested.mode === "default") {
    const value = support.defaultValue;
    return value === null ? requested : value === false ? Object.freeze({ mode: "disabled" })
      : value === true ? Object.freeze({ mode: "enabled" })
        : Object.freeze({ mode: "enabled", effort: value });
  }
  if (support.status === "unknown") throw new TypeError("Thinking controls are not known for this model.");
  const value = requested.mode === "disabled" ? false : requested.effort ?? true;
  if (value === true && typeof support.defaultValue === "string") {
    return Object.freeze({ mode: "enabled", effort: support.defaultValue });
  }
  if (!support.values.includes(value)) {
    throw new TypeError("The selected thinking control is not supported by this model.");
  }
  return requested;
}

function effortToken(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new TypeError("Thinking effort must be a bounded level token.");
  }
  return value;
}
