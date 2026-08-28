export type HelarcToolGuidanceErrorCode =
  | "tool_guidance_source_invalid"
  | "tool_guidance_release_invalid"
  | "tool_guidance_catalog_corrupt"
  | "tool_guidance_release_missing"
  | "tool_guidance_release_withdrawn"
  | "tool_guidance_source_missing"
  | "tool_guidance_source_duplicate"
  | "tool_guidance_model_condition_ambiguous"
  | "tool_guidance_profile_invalid"
  | "tool_guidance_coverage_missing"
  | "tool_guidance_coverage_extra"
  | "tool_guidance_binding_invalid"
  | "tool_guidance_schema_pointer_invalid"
  | "tool_guidance_schema_coverage_invalid"
  | "tool_guidance_schema_structure_changed";

export class HelarcToolGuidanceError extends TypeError {
  constructor(
    readonly code: HelarcToolGuidanceErrorCode,
    message: string,
    readonly path: string | null = null,
  ) {
    super(message);
    this.name = "HelarcToolGuidanceError";
  }
}

export function toolGuidanceError(
  code: HelarcToolGuidanceErrorCode,
  message: string,
  path: string | null = null,
): never {
  throw new HelarcToolGuidanceError(code, message, path);
}
