export interface HelarcInstructionSectionSetting {
  readonly id: string;
  readonly enabled: boolean;
  readonly content: string;
}

export const HELARC_DEFAULT_PROTOCOL_INSTRUCTIONS: readonly HelarcInstructionSectionSetting[] = Object.freeze([
  section("native_tool_protocol", [
    "Use only callable definitions supplied with the current model request.",
    "When multiple calls do not require results from one another, issue them together in the same response.",
    "When a call requires another call's result, wait for that result and issue the dependent call in a later response.",
    "Use update_plan when an explicit plan helps the work; simple tasks may proceed without a plan.",
    "Return a normal assistant response with no calls when this Run has no further work to perform. Describe the result, limitations, or refusal truthfully; ending a Run does not assert that the user's objective was achieved.",
    "Assistant text accompanying calls describes progress and does not complete the Run.",
  ].join("\n")),
  section("permission_safety", "Use only the active Tool catalog. Permission, approval, policy, and sandbox decisions are enforced by the host from the exact requested action."),
  section("safe_output_boundary", "Never include workspace root paths, credentials, approval decisions, original content hashes, or patch ids."),
]);

function section(id: string, content: string): HelarcInstructionSectionSetting {
  return Object.freeze({ id, enabled: true, content });
}
