import type { InspectionContentClass, InspectionJson } from "../records/index.js";

export interface InspectionCapturePolicy {
  readonly revision: string;
  readonly enabled: boolean;
  readonly definition: boolean;
  readonly agent: boolean;
  readonly provider: boolean;
  readonly execution: boolean;
}

export const DEFAULT_INSPECTION_CAPTURE_POLICY: InspectionCapturePolicy = Object.freeze({
  revision: "structural-v1", enabled: true, definition: true, agent: false, provider: false, execution: false,
});

export function validateInspectionCapturePolicy(value: unknown): InspectionCapturePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid inspection capture policy.");
  const candidate = value as Record<string, unknown>;
  const keys = ["revision", "enabled", "definition", "agent", "provider", "execution"];
  if (Object.keys(candidate).length !== keys.length || typeof candidate.revision !== "string" || candidate.revision.length < 1 || candidate.revision.length > 128 || keys.slice(1).some((key) => typeof candidate[key] !== "boolean")) throw new TypeError("Invalid inspection capture policy.");
  return Object.freeze({ revision: candidate.revision, enabled: candidate.enabled as boolean, definition: candidate.definition as boolean, agent: candidate.agent as boolean, provider: candidate.provider as boolean, execution: candidate.execution as boolean });
}

export function captureClassEnabled(policy: InspectionCapturePolicy, kind: InspectionContentClass): boolean {
  return policy.enabled && policy[kind] === true;
}

export function redactInspectionContent(value: InspectionJson): { value: InspectionJson; redacted: boolean } {
  let redacted = false;
  const visit = (current: InspectionJson): InspectionJson => {
    if (Array.isArray(current)) return current.map(visit);
    if (current === null || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current).map(([key, entry]) => {
      if (/^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|private[-_]?key|credential|credentials|grant|grants)$/i.test(key)) {
        redacted = true;
        return [key, "[redacted]"];
      }
      return [key, visit(entry)];
    }));
  };
  return { value: visit(value), redacted };
}
