import type { ApprovalCategory } from "./ApprovalCategory.js";
import type { ApprovalPolicy } from "./ApprovalPolicy.js";

export type ActionApprovalCause =
  | "governance_review"
  | "rule_prompt"
  | "missing_authority";

export function allowsActionApproval(input: {
  readonly policy: ApprovalPolicy;
  readonly category: ApprovalCategory;
  readonly cause: ActionApprovalCause;
}): boolean {
  if (input.policy === "never") return false;
  if (input.policy === "untrusted" || input.policy === "on-request") return true;
  if (input.cause === "rule_prompt") return input.policy.granular.rules;
  switch (input.category) {
    case "mcpToolCall":
      return input.policy.granular.mcpElicitations;
    case "skill":
      return input.policy.granular.skillApproval;
    case "permissions":
      return input.policy.granular.requestPermissions;
    case "commandExecution":
    case "fileChange":
    case "networkAccess":
      return input.policy.granular.sandboxApproval;
  }
}
