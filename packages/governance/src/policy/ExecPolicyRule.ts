export type ExecPolicyRuleDecision = "allow" | "prompt" | "forbidden";

export interface ExecPolicyRule {
  readonly id: string;
  readonly commandPattern: readonly [string, ...string[]];
  readonly cwd: string | null;
  readonly decision: ExecPolicyRuleDecision;
  readonly source: string;
  readonly justification: string | null;
}

export function snapshotExecPolicyRule(rule: ExecPolicyRule): ExecPolicyRule {
  if (typeof rule !== "object" || rule === null) {
    throw new TypeError("ExecPolicyRule must be an object.");
  }
  assertNonEmpty(rule.id, "ExecPolicyRule.id");
  if (
    !Array.isArray(rule.commandPattern) ||
    rule.commandPattern.length === 0 ||
    rule.commandPattern.some(
      (segment) => typeof segment !== "string" || segment.length === 0,
    )
  ) {
    throw new TypeError("ExecPolicyRule.commandPattern must be non-empty segments.");
  }
  if (rule.cwd !== null) {
    assertNonEmpty(rule.cwd, "ExecPolicyRule.cwd");
  }
  if (
    rule.decision !== "allow" &&
    rule.decision !== "prompt" &&
    rule.decision !== "forbidden"
  ) {
    throw new TypeError("ExecPolicyRule.decision is unsupported.");
  }
  assertNonEmpty(rule.source, "ExecPolicyRule.source");
  if (rule.justification !== null && typeof rule.justification !== "string") {
    throw new TypeError("ExecPolicyRule.justification must be text or null.");
  }

  return Object.freeze({
    ...rule,
    commandPattern: Object.freeze([...rule.commandPattern]) as unknown as readonly [
      string,
      ...string[],
    ],
  });
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
