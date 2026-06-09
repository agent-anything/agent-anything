import {
  Redactor,
  defaultRedactionRules,
  type RedactionRule,
} from "@agent-anything/platform";

const netDoctorPromptRedactionRules: RedactionRule[] = [
  ...defaultRedactionRules,
  {
    id: "net-doctor.pattern.proxy-url",
    kind: "pattern",
    pattern: /\bhttps?:\/\/[^\s@/]+:[^\s@/]+@[^\s]+/g,
    reason: "Matches proxy or URL credentials.",
  },
  {
    id: "net-doctor.pattern.token-like-ref",
    kind: "pattern",
    pattern: /\b[A-Za-z0-9_-]*token[A-Za-z0-9_-]*\b/g,
    reason: "Matches token-like prompt text.",
  },
];

const promptRedactor = new Redactor({
  rules: netDoctorPromptRedactionRules,
});

export function redactNetDoctorPromptText(value: string): string {
  return String(promptRedactor.redact({
    value,
  }).value);
}

export function redactNetDoctorPromptTexts(values: string[]): string[] {
  return values.map(redactNetDoctorPromptText);
}
