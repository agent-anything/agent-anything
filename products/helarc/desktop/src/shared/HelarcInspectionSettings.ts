export interface HelarcInspectionSettings {
  readonly enabled: boolean;
  readonly definition: boolean;
  readonly agent: boolean;
  readonly provider: boolean;
  readonly execution: boolean;
}
export interface HelarcInspectionSettingsSnapshot {
  readonly settings: HelarcInspectionSettings;
  readonly health: { readonly available: boolean; readonly queued: number; readonly dropped: number; readonly rejected: number; readonly code: string | null };
}
export function snapshotHelarcInspectionSettings(value: unknown): HelarcInspectionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Inspection settings.");
  const candidate = value as Record<string, unknown>;
  const keys = ["enabled", "definition", "agent", "provider", "execution"];
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => typeof candidate[key] !== "boolean")) throw new TypeError("Invalid Inspection settings.");
  return Object.freeze({ enabled: candidate.enabled as boolean, definition: candidate.definition as boolean, agent: candidate.agent as boolean, provider: candidate.provider as boolean, execution: candidate.execution as boolean });
}
