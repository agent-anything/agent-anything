const codes = new Set([
  "inspection_start_timeout", "inspection_initialization_stalled", "inspection_initialization_timeout",
  "inspection_start_cancelled", "inspection_worker_failed", "inspection_worker_exited",
  "inspection_storage_budget_exhausted", "inspection_storage_unavailable", "inspection_path_invalid",
  "inspection_storage_scan_limit", "inspection_storage_scan_stalled", "inspection_storage_scan_timeout",
  "inspection_storage_scan_failed", "inspection_storage_scan_cancelled",
  "inspection_source_unsupported", "inspection_source_invalid",
]);

export class InspectionRecorderError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(codes.has(code) ? code : "inspection_storage_unavailable");
    this.name = "InspectionRecorderError";
    this.code = this.message;
  }
}

export function inspectionRecorderFailureCode(error: unknown): string {
  return error instanceof Error && codes.has(error.message) ? error.message : "inspection_storage_unavailable";
}
