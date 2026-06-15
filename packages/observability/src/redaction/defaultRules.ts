import type { RedactionRule } from "./RedactionRule.js";

export const defaultRedactionRules: RedactionRule[] = [
  createKeyRule("password"),
  createKeyRule("token"),
  createKeyRule("secret"),
  createKeyRule("apiKey"),
  createKeyRule("authorization"),
  createKeyRule("credential"),
  {
    id: "pattern.bearer-token",
    kind: "pattern",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
    reason: "Matches bearer token pattern.",
  },
];

function createKeyRule(key: string): RedactionRule {
  return {
    id: `key.${key}`,
    kind: "key",
    key,
    reason: `Matches sensitive key '${key}'.`,
  };
}
