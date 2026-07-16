import type {
  ExecPolicyAmendment,
  NetworkPolicyAmendment,
} from "../amendment/PolicyAmendment.js";
import type { ExecPolicyRule, ExecPolicyRuleDecision } from "./ExecPolicyRule.js";

export interface NetworkPolicyRule {
  readonly id: string;
  readonly hostPattern: string;
  readonly ports: readonly number[];
  readonly protocols: readonly string[];
  readonly decision: ExecPolicyRuleDecision;
  readonly source: string;
  readonly justification: string | null;
}

export interface ActionRuleOutcome {
  readonly decision: ExecPolicyRuleDecision | "none";
  readonly matchedRuleIds: readonly string[];
}

export function snapshotNetworkPolicyRule(
  rule: NetworkPolicyRule,
): NetworkPolicyRule {
  assertText(rule?.id, "NetworkPolicyRule.id");
  assertText(rule.hostPattern, "NetworkPolicyRule.hostPattern");
  assertDecision(rule.decision);
  assertText(rule.source, "NetworkPolicyRule.source");
  if (rule.justification !== null && typeof rule.justification !== "string") {
    throw new TypeError("NetworkPolicyRule.justification must be text or null.");
  }
  if (!Array.isArray(rule.ports) || rule.ports.some((port) =>
    !Number.isSafeInteger(port) || port < 1 || port > 65_535
  )) {
    throw new TypeError("NetworkPolicyRule.ports contains an invalid port.");
  }
  if (!Array.isArray(rule.protocols) || rule.protocols.some((protocol) =>
    typeof protocol !== "string" || protocol.length === 0
  )) {
    throw new TypeError("NetworkPolicyRule.protocols contains an invalid protocol.");
  }
  return Object.freeze({
    ...rule,
    hostPattern: rule.hostPattern.toLowerCase(),
    ports: Object.freeze([...new Set(rule.ports)].sort((left, right) => left - right)),
    protocols: Object.freeze([...new Set(rule.protocols.map((value) => value.toLowerCase()))].sort()),
  });
}

export function evaluateExecPolicyRules(input: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly environmentId: string;
  readonly rules: readonly ExecPolicyRule[];
  readonly amendments: readonly ExecPolicyAmendment[];
}): ActionRuleOutcome {
  const matches: { readonly id: string; readonly decision: ExecPolicyRuleDecision }[] = [];
  for (const rule of input.rules) {
    if ((rule.cwd === null || rule.cwd === input.cwd) &&
      prefixMatches(rule.commandPattern, input.command)) {
      matches.push({ id: rule.id, decision: rule.decision });
    }
  }
  for (const amendment of input.amendments) {
    if (amendment.environmentId === input.environmentId &&
      (amendment.cwd === null || amendment.cwd === input.cwd) &&
      prefixMatches(amendment.commandPattern, input.command)) {
      matches.push({
        id: amendment.amendmentId,
        decision: amendment.effect === "forbidden" ? "forbidden" : "allow",
      });
    }
  }
  return collapse(matches);
}

export function evaluateNetworkPolicyRules(input: {
  readonly host: string;
  readonly port: number;
  readonly protocol: string | null;
  readonly environmentId: string;
  readonly rules: readonly NetworkPolicyRule[];
  readonly amendments: readonly NetworkPolicyAmendment[];
}): ActionRuleOutcome {
  const matches: { readonly id: string; readonly decision: ExecPolicyRuleDecision }[] = [];
  for (const rule of input.rules) {
    if (matchesNetwork(rule, input)) {
      matches.push({ id: rule.id, decision: rule.decision });
    }
  }
  for (const amendment of input.amendments) {
    if (amendment.environmentId === input.environmentId &&
      hostMatches(amendment.hostPattern, input.host) &&
      (amendment.ports.length === 0 || amendment.ports.includes(input.port)) &&
      (amendment.protocols.length === 0 ||
        (input.protocol !== null && amendment.protocols.includes(input.protocol)))) {
      matches.push({
        id: amendment.amendmentId,
        decision: amendment.effect === "forbidden" ? "forbidden" : "allow",
      });
    }
  }
  return collapse(matches);
}

function matchesNetwork(
  rule: NetworkPolicyRule,
  input: { readonly host: string; readonly port: number; readonly protocol: string | null },
): boolean {
  return hostMatches(rule.hostPattern, input.host) &&
    (rule.ports.length === 0 || rule.ports.includes(input.port)) &&
    (rule.protocols.length === 0 ||
      (input.protocol !== null && rule.protocols.includes(input.protocol)));
}

function prefixMatches(pattern: readonly string[], command: readonly string[]): boolean {
  return pattern.length <= command.length &&
    pattern.every((segment, index) => segment === command[index]);
}

function hostMatches(pattern: string, host: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedHost = host.toLowerCase();
  return normalizedPattern.startsWith("*.")
    ? normalizedHost.endsWith(`.${normalizedPattern.slice(2)}`)
    : normalizedPattern === normalizedHost;
}

function collapse(
  matches: readonly { readonly id: string; readonly decision: ExecPolicyRuleDecision }[],
): ActionRuleOutcome {
  const matchedRuleIds = Object.freeze(matches.map(({ id }) => id).sort());
  const decision = matches.some((match) => match.decision === "forbidden")
    ? "forbidden"
    : matches.some((match) => match.decision === "prompt")
      ? "prompt"
      : matches.some((match) => match.decision === "allow")
        ? "allow"
        : "none";
  return Object.freeze({ decision, matchedRuleIds });
}

function assertDecision(value: unknown): asserts value is ExecPolicyRuleDecision {
  if (value !== "allow" && value !== "prompt" && value !== "forbidden") {
    throw new TypeError("NetworkPolicyRule.decision is unsupported.");
  }
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text.`);
  }
}
