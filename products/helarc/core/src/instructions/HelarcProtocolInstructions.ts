export interface HelarcInstructionSectionSetting {
  readonly id: string;
  readonly enabled: boolean;
  readonly content: string;
}

export const HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS: readonly HelarcInstructionSectionSetting[] = Object.freeze([
  section("native_tool_protocol", [
    "Use only callable definitions supplied with the current model request.",
    "Use update_plan when an explicit plan helps the work; simple tasks may proceed without a plan.",
    "Use stop as the only call when the task cannot be completed safely or required information is unavailable.",
    "Return a normal assistant response with no calls only when the task is complete.",
    "Assistant text accompanying calls describes progress and does not complete the Run.",
  ].join("\n")),
  section("permission_safety", "Use only the active Tool catalog. Permission, approval, policy, and sandbox decisions are enforced by the host from the exact requested action."),
  section("stop_protocol", "Use the stop callable with one bounded reason; refusal may also stop without a callable."),
  section("safe_output_boundary", "Never include workspace root paths, credentials, approval decisions, original content hashes, or patch ids."),
]);

function section(id: string, content: string): HelarcInstructionSectionSetting {
  return Object.freeze({ id, enabled: true, content });
}
