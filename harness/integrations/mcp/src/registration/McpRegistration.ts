import {
  assertCanonicalDataArray,
  assertExactDataProperties,
  assertPlainRecord,
  createMcpContractFingerprint,
  type McpJsonObject,
  snapshotMcpJsonObject,
  validateMcpText,
  validateMcpToken,
  validateNonNegativeSafeInteger,
  validatePositiveSafeInteger,
} from "../protocol/McpJson.js";

export const MCP_PROTOCOL_REVISION = "2026-07-28" as const;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type McpProtocolRevision = typeof MCP_PROTOCOL_REVISION;
export type McpTransportKind = "stdio" | "streamable-http";
export type McpRegistrationTrustClassification =
  | "host-configured"
  | "managed";
export type McpServerCapabilityId = "tools" | "resources" | "prompts";

export interface McpImplementationInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpTransportBindingInput {
  readonly kind: McpTransportKind;
  readonly bindingId: string;
  readonly bindingRevision: string;
  readonly configurationRef: string;
}

export interface McpTransportBindingIdentity extends McpTransportBindingInput {
  readonly bindingFingerprint: string;
}

export interface McpClientProfileInput {
  readonly profileId: string;
  readonly info: McpImplementationInfo;
  readonly capabilities: McpJsonObject;
}

export interface McpClientProfile {
  readonly profileId: string;
  readonly info: McpImplementationInfo;
  readonly capabilities: McpJsonObject;
  readonly profileFingerprint: string;
}

export interface McpConnectionLimits {
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxDiscoveryTtlMs: number;
}

export interface McpServerRegistrationInput {
  readonly serverId: string;
  readonly displayName: string;
  readonly registrationRevision: string;
  readonly authorityBindingId: string;
  readonly transport: McpTransportBindingInput;
  readonly protocolRevision: McpProtocolRevision;
  readonly requiredCapabilities: readonly McpServerCapabilityId[];
  readonly client: McpClientProfileInput;
  readonly credentialRef: string | null;
  readonly trustClassification: McpRegistrationTrustClassification;
  readonly limits: McpConnectionLimits;
}

export interface McpServerRegistration
  extends Omit<McpServerRegistrationInput, "transport" | "client"> {
  readonly transport: McpTransportBindingIdentity;
  readonly client: McpClientProfile;
  readonly registrationFingerprint: string;
}

export class McpRegistrationError extends TypeError {
  constructor(
    readonly code:
      | "mcp_registration_invalid"
      | "mcp_protocol_revision_unsupported",
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "McpRegistrationError";
  }
}

export function createMcpServerRegistration(
  input: McpServerRegistrationInput,
): McpServerRegistration {
  try {
    assertPlainRecord(input, "registration");
    assertExactDataProperties(
      input,
      new Set([
        "serverId",
        "displayName",
        "registrationRevision",
        "authorityBindingId",
        "transport",
        "protocolRevision",
        "requiredCapabilities",
        "client",
        "credentialRef",
        "trustClassification",
        "limits",
      ]),
      new Set(),
      "registration",
    );
    if (input.protocolRevision !== MCP_PROTOCOL_REVISION) {
      throw new McpRegistrationError(
        "mcp_protocol_revision_unsupported",
        `MCP registration must use protocol revision ${MCP_PROTOCOL_REVISION}.`,
        "registration.protocolRevision",
      );
    }
    const transport = snapshotTransport(input.transport);
    const client = snapshotClient(input.client);
    const requiredCapabilities = snapshotRequiredCapabilities(
      input.requiredCapabilities,
    );
    const limits = snapshotLimits(input.limits);
    if (
      input.trustClassification !== "host-configured" &&
      input.trustClassification !== "managed"
    ) {
      invalid(
        "registration.trustClassification",
        "MCP registration trust classification is invalid.",
      );
    }
    const credentialRef = input.credentialRef === null
      ? null
      : validateMcpToken(
        input.credentialRef,
        "registration.credentialRef",
        1_024,
      );
    const fields = Object.freeze({
      serverId: validateMcpToken(input.serverId, "registration.serverId"),
      displayName: validateMcpText(
        input.displayName,
        "registration.displayName",
        512,
      ),
      registrationRevision: validateMcpToken(
        input.registrationRevision,
        "registration.registrationRevision",
      ),
      authorityBindingId: validateMcpToken(
        input.authorityBindingId,
        "registration.authorityBindingId",
      ),
      transport,
      protocolRevision: MCP_PROTOCOL_REVISION,
      requiredCapabilities,
      client,
      credentialRef,
      trustClassification: input.trustClassification,
      limits,
    });
    return Object.freeze({
      ...fields,
      registrationFingerprint: createMcpContractFingerprint(
        "agent-anything.mcp-registration.v1",
        fields,
      ),
    });
  } catch (error) {
    if (error instanceof McpRegistrationError) throw error;
    const message = error instanceof Error
      ? error.message
      : "MCP registration is invalid.";
    throw new McpRegistrationError(
      "mcp_registration_invalid",
      message,
      inferPath(message),
    );
  }
}

function snapshotTransport(
  input: McpTransportBindingInput,
): McpTransportBindingIdentity {
  assertPlainRecord(input, "registration.transport");
  assertExactDataProperties(
    input,
    new Set(["kind", "bindingId", "bindingRevision", "configurationRef"]),
    new Set(),
    "registration.transport",
  );
  if (input.kind !== "stdio" && input.kind !== "streamable-http") {
    invalid(
      "registration.transport.kind",
      "MCP transport kind must be stdio or streamable-http.",
    );
  }
  const fields = Object.freeze({
    kind: input.kind,
    bindingId: validateMcpToken(
      input.bindingId,
      "registration.transport.bindingId",
    ),
    bindingRevision: validateMcpToken(
      input.bindingRevision,
      "registration.transport.bindingRevision",
    ),
    configurationRef: validateMcpToken(
      input.configurationRef,
      "registration.transport.configurationRef",
      1_024,
    ),
  });
  return Object.freeze({
    ...fields,
    bindingFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-transport-binding.v1",
      fields,
    ),
  });
}

function snapshotClient(input: McpClientProfileInput): McpClientProfile {
  assertPlainRecord(input, "registration.client");
  assertExactDataProperties(
    input,
    new Set(["profileId", "info", "capabilities"]),
    new Set(),
    "registration.client",
  );
  assertPlainRecord(input.info, "registration.client.info");
  assertExactDataProperties(
    input.info,
    new Set(["name", "version"]),
    new Set(),
    "registration.client.info",
  );
  const capabilities = snapshotMcpJsonObject(
    input.capabilities,
    "registration.client.capabilities",
  );
  if (Reflect.ownKeys(capabilities).length !== 0) {
    invalid(
      "registration.client.capabilities",
      "The current MCP client profile must not advertise unsupported client features.",
    );
  }
  const fields = Object.freeze({
    profileId: validateMcpToken(
      input.profileId,
      "registration.client.profileId",
    ),
    info: Object.freeze({
      name: validateMcpText(
        input.info.name,
        "registration.client.info.name",
        256,
      ),
      version: validateMcpToken(
        input.info.version,
        "registration.client.info.version",
      ),
    }),
    capabilities,
  });
  return Object.freeze({
    ...fields,
    profileFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-client-profile.v1",
      fields,
    ),
  });
}

function snapshotRequiredCapabilities(
  input: readonly McpServerCapabilityId[],
): readonly McpServerCapabilityId[] {
  assertCanonicalDataArray(input, "registration.requiredCapabilities");
  const accepted = new Set<McpServerCapabilityId>();
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      invalid(
        `registration.requiredCapabilities[${index}]`,
        "MCP required capabilities cannot be sparse.",
      );
    }
    const capability = input[index];
    if (
      capability !== "tools" &&
      capability !== "resources" &&
      capability !== "prompts"
    ) {
      invalid(
        `registration.requiredCapabilities[${index}]`,
        "MCP required capability is not supported by this Harness revision.",
      );
    }
    if (accepted.has(capability)) {
      invalid(
        `registration.requiredCapabilities[${index}]`,
        `MCP required capability '${capability}' is duplicated.`,
      );
    }
    accepted.add(capability);
  }
  return Object.freeze([...accepted].sort());
}

function snapshotLimits(input: McpConnectionLimits): McpConnectionLimits {
  assertPlainRecord(input, "registration.limits");
  assertExactDataProperties(
    input,
    new Set([
      "connectTimeoutMs",
      "requestTimeoutMs",
      "shutdownTimeoutMs",
      "maxDiscoveryTtlMs",
    ]),
    new Set(),
    "registration.limits",
  );
  return Object.freeze({
    connectTimeoutMs: validateTimerDuration(
      input.connectTimeoutMs,
      "registration.limits.connectTimeoutMs",
    ),
    requestTimeoutMs: validateTimerDuration(
      input.requestTimeoutMs,
      "registration.limits.requestTimeoutMs",
    ),
    shutdownTimeoutMs: validateTimerDuration(
      input.shutdownTimeoutMs,
      "registration.limits.shutdownTimeoutMs",
    ),
    maxDiscoveryTtlMs: validateTimerDuration(
      input.maxDiscoveryTtlMs,
      "registration.limits.maxDiscoveryTtlMs",
      true,
    ),
  });
}

function validateTimerDuration(
  input: unknown,
  path: string,
  allowZero = false,
): number {
  const value = allowZero
    ? validateNonNegativeSafeInteger(input, path)
    : validatePositiveSafeInteger(input, path);
  if (value > MAX_TIMER_DELAY_MS) {
    invalid(
      path,
      `MCP duration must not exceed ${MAX_TIMER_DELAY_MS} milliseconds.`,
    );
  }
  return value;
}

function invalid(path: string, message: string): never {
  throw new McpRegistrationError("mcp_registration_invalid", message, path);
}

function inferPath(message: string): string {
  const match = message.match(/registration(?:\.[A-Za-z0-9_[\].-]+)?/);
  return match?.[0] ?? "registration";
}
