import type { EvidenceSensitivity } from "../evidence/index.js";
import type { Metadata } from "../shared/types.js";
import { defaultRedactionRules } from "./defaultRules.js";
import type { Redaction, RedactionResult } from "./RedactionResult.js";
import type { RedactionRule } from "./RedactionRule.js";

export interface RedactInput<TValue = unknown> {
  value: TValue;
  sensitivity?: EvidenceSensitivity;
  metadata?: Metadata;
}

export interface RedactorInput {
  rules?: RedactionRule[];
  replacement?: string;
  restrictedReplacement?: string;
}

export class Redactor {
  private readonly rules: RedactionRule[];
  private readonly replacement: string;
  private readonly restrictedReplacement: string;

  constructor(input: RedactorInput = {}) {
    this.rules = input.rules ?? defaultRedactionRules;
    this.replacement = input.replacement ?? "[REDACTED]";
    this.restrictedReplacement = input.restrictedReplacement ?? "[RESTRICTED]";
  }

  redact<TValue>(input: RedactInput<TValue>): RedactionResult {
    if (input.sensitivity === "secret") {
      return {
        value: this.replacement,
        redacted: true,
        redactions: [
          {
            path: "$",
            ruleId: "sensitivity.secret",
            reason: "Secret content is redacted by default.",
          },
        ],
        metadata: input.metadata ?? {},
      };
    }

    if (input.sensitivity === "restricted") {
      return {
        value: this.restrictedReplacement,
        redacted: true,
        redactions: [
          {
            path: "$",
            ruleId: "sensitivity.restricted",
            reason: "Restricted content is reference-only by default.",
          },
        ],
        metadata: input.metadata ?? {},
      };
    }

    const redactions: Redaction[] = [];
    const value = this.redactValue(input.value, "$", redactions);

    return {
      value,
      redacted: redactions.length > 0,
      redactions,
      metadata: input.metadata ?? {},
    };
  }

  private redactValue(
    value: unknown,
    path: string,
    redactions: Redaction[],
  ): unknown {
    if (typeof value === "string") {
      return this.redactString(value, path, redactions);
    }

    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.redactValue(item, `${path}[${index}]`, redactions),
      );
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          const childPath = `${path}.${key}`;
          const keyRule = this.findKeyRule(key);

          if (keyRule) {
            redactions.push({
              path: childPath,
              ruleId: keyRule.id,
              reason: keyRule.reason,
            });

            return [key, this.replacement];
          }

          return [key, this.redactValue(child, childPath, redactions)];
        }),
      );
    }

    return value;
  }

  private redactString(
    value: string,
    path: string,
    redactions: Redaction[],
  ): string {
    let redactedValue = value;

    for (const rule of this.rules) {
      if (rule.kind !== "pattern") {
        continue;
      }

      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(redactedValue)) {
        continue;
      }

      rule.pattern.lastIndex = 0;
      redactedValue = redactedValue.replace(rule.pattern, this.replacement);
      redactions.push({
        path,
        ruleId: rule.id,
        reason: rule.reason,
      });
    }

    return redactedValue;
  }

  private findKeyRule(key: string): RedactionRule | null {
    const normalizedKey = key.toLowerCase();

    return this.rules.find((rule) =>
      rule.kind === "key" && rule.key.toLowerCase() === normalizedKey,
    ) ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
