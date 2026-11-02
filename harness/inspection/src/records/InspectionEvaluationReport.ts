/** Public report projection only. Targets, graders and private evidence remain external owners. */
export interface InspectionEvaluationReport {
  readonly version: "1";
  readonly id: string;
  readonly comparison: "C01" | "C02" | "C03" | "C04";
  readonly target: string;
  readonly startingBoundary: string;
  readonly scope: string;
  readonly expectations: readonly string[];
  readonly exclusions: readonly string[];
  readonly limitations: readonly string[];
  readonly trials: readonly {
    readonly id: string;
    readonly arm: string;
    readonly repetition: number;
    readonly execution: string;
    readonly capture: string;
    readonly cleanup: string;
    readonly grades: readonly {readonly dimension: string; readonly verdict: string; readonly method: string; readonly rationale: string}[];
    readonly measurements: readonly {readonly name: string; readonly role: string; readonly unit: string; readonly value: number | null; readonly unavailableReason: string | null}[];
    readonly evidence: readonly {readonly sourceId: string; readonly datasetId: string; readonly watermark: number; readonly recordId: string; readonly label: string}[];
  }[];
}

export function readInspectionEvaluationReport(value: unknown): InspectionEvaluationReport {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const only = (v: Record<string, unknown>, keys: string) => Object.keys(v).every(k => keys.split(" ").includes(k));
  const text = (v: unknown): v is string => typeof v === "string" && v.length <= 16384;
  const list = (v: unknown, check: (entry: unknown) => boolean): boolean => Array.isArray(v) && v.length <= 2048 && v.every(check);
  const ordinal = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!record(value) || !only(value,"version id comparison target startingBoundary scope expectations exclusions limitations trials") || value.version !== "1" || !["C01", "C02", "C03", "C04"].includes(String(value.comparison)) ||
      ![value.id, value.target, value.startingBoundary, value.scope].every(text) ||
      ![value.expectations, value.exclusions, value.limitations].every(v => list(v, text)) || !list(value.trials, t => record(t) &&
        only(t,"id arm repetition execution capture cleanup grades measurements evidence") && [t.id, t.arm, t.execution, t.capture, t.cleanup].every(text) && ordinal(t.repetition) && t.repetition !== 0 &&
        list(t.grades, g => record(g) && only(g,"dimension verdict method rationale") && [g.dimension, g.verdict, g.method, g.rationale].every(text)) &&
        list(t.measurements, m => record(m) && only(m,"name role unit value unavailableReason") && [m.name, m.role, m.unit].every(text) && (m.value === null ? text(m.unavailableReason) : typeof m.value === "number" && Number.isFinite(m.value) && m.value >= 0 && m.unavailableReason === null)) &&
        list(t.evidence, e => record(e) && only(e,"sourceId datasetId watermark recordId label") && [e.sourceId, e.datasetId, e.recordId, e.label].every(text) && ordinal(e.watermark)))) throw new TypeError("Invalid evaluation report projection");
  return value as unknown as InspectionEvaluationReport;
}
