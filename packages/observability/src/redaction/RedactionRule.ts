export type RedactionRuleKind = "key" | "pattern";

export type RedactionRule =
  | KeyRedactionRule
  | PatternRedactionRule;

export interface BaseRedactionRule {
  id: string;
  reason: string;
}

export interface KeyRedactionRule extends BaseRedactionRule {
  kind: "key";
  key: string;
}

export interface PatternRedactionRule extends BaseRedactionRule {
  kind: "pattern";
  pattern: RegExp;
}
