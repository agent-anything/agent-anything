import type {
  ExecPolicyAmendment,
  NetworkPolicyAmendment,
  TrustedPolicyAmendment,
} from "./PolicyAmendment.js";

export type PolicyAmendmentValidationCode =
  | "policy_amendment_invalid_identity"
  | "policy_amendment_invalid_command"
  | "policy_amendment_invalid_network_target"
  | "policy_amendment_invalid_effect"
  | "policy_amendment_invalid_fingerprint";

export type NormalizePolicyAmendmentResult =
  | {
      readonly status: "valid";
      readonly amendment: TrustedPolicyAmendment;
    }
  | {
      readonly status: "invalid";
      readonly code: PolicyAmendmentValidationCode;
      readonly message: string;
    };

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function normalizePolicyAmendment(
  input: TrustedPolicyAmendment,
): NormalizePolicyAmendmentResult {
  if (input.kind === "exec_policy") {
    return normalizeExecPolicyAmendment(input.amendment);
  }
  if (input.kind === "network_policy") {
    return normalizeNetworkPolicyAmendment(input.amendment);
  }
  return invalid(
    "policy_amendment_invalid_identity",
    "Policy amendment kind is invalid.",
  );
}

function normalizeExecPolicyAmendment(
  amendment: ExecPolicyAmendment,
): NormalizePolicyAmendmentResult {
  const identityFailure = validateCommon(amendment);
  if (identityFailure) {
    return identityFailure;
  }
  if (
    amendment.commandPattern.length === 0 ||
    amendment.commandPattern.some(
      (segment) => typeof segment !== "string" || segment.length === 0,
    ) ||
    (amendment.cwd !== null && amendment.cwd.length === 0)
  ) {
    return invalid(
      "policy_amendment_invalid_command",
      "Exec-policy amendment command pattern is invalid.",
    );
  }

  return {
    status: "valid",
    amendment: deepFreeze({
      kind: "exec_policy",
      amendment: {
        ...amendment,
        commandPattern: [...amendment.commandPattern] as [string, ...string[]],
      },
    }),
  };
}

function normalizeNetworkPolicyAmendment(
  amendment: NetworkPolicyAmendment,
): NormalizePolicyAmendmentResult {
  const identityFailure = validateCommon(amendment);
  if (identityFailure) {
    return identityFailure;
  }

  const hostPattern = normalizeHostPattern(amendment.hostPattern);
  if (hostPattern === null) {
    return invalid(
      "policy_amendment_invalid_network_target",
      "Network-policy amendment host pattern is invalid.",
    );
  }
  if (
    amendment.ports.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65_535,
    ) ||
    amendment.protocols.some(
      (protocol) =>
        typeof protocol !== "string" ||
        protocol.length === 0 ||
        protocol !== protocol.trim().toLowerCase(),
    )
  ) {
    return invalid(
      "policy_amendment_invalid_network_target",
      "Network-policy amendment ports or protocols are invalid.",
    );
  }

  return {
    status: "valid",
    amendment: deepFreeze({
      kind: "network_policy",
      amendment: {
        ...amendment,
        hostPattern,
        ports: [...new Set(amendment.ports)].sort((left, right) => left - right),
        protocols: [...new Set(amendment.protocols)].sort(),
      },
    }),
  };
}

function validateCommon(
  amendment: ExecPolicyAmendment | NetworkPolicyAmendment,
): Extract<NormalizePolicyAmendmentResult, { status: "invalid" }> | null {
  if (
    !IDENTITY_PATTERN.test(amendment.amendmentId) ||
    !IDENTITY_PATTERN.test(amendment.environmentId)
  ) {
    return invalid(
      "policy_amendment_invalid_identity",
      "Policy amendment identity is invalid.",
    );
  }
  if (amendment.effect !== "allow" && amendment.effect !== "forbidden") {
    return invalid(
      "policy_amendment_invalid_effect",
      "Policy amendment effect is invalid.",
    );
  }
  if (amendment.sourceFingerprint.length === 0) {
    return invalid(
      "policy_amendment_invalid_fingerprint",
      "Policy amendment source fingerprint is invalid.",
    );
  }
  return null;
}

function normalizeHostPattern(value: string): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim().toLowerCase() ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes(":") ||
    /\s/.test(value)
  ) {
    return null;
  }
  const wildcard = value.startsWith("*.");
  const host = (wildcard ? value.slice(2) : value).replace(/\.+$/, "");
  if (host.length === 0 || host.includes("*")) {
    return null;
  }
  let canonicalHost: string;
  try {
    canonicalHost = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (
    canonicalHost.length === 0 ||
    canonicalHost.split(".").some((label) => label.length === 0)
  ) {
    return null;
  }
  return wildcard ? `*.${canonicalHost}` : canonicalHost;
}

function invalid(
  code: PolicyAmendmentValidationCode,
  message: string,
): Extract<NormalizePolicyAmendmentResult, { status: "invalid" }> {
  return Object.freeze({ status: "invalid", code, message });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
