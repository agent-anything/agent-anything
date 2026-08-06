import type { McpActivationSnapshot } from "../lifecycle/McpLifecycle.js";
import type { McpJsonObject } from "../protocol/McpJson.js";
import type { McpOperationError } from "../protocol/McpProtocol.js";
import type { McpServerRegistration } from "../registration/McpRegistration.js";
import type { McpTransportResponseStream } from "../transport/McpTransport.js";

export interface McpPrimitiveTransportLease {
  readonly registration: McpServerRegistration;
  readonly activation: McpActivationSnapshot;
}

export interface McpPrimitiveCoordinatorDependencies {
  getActiveLease(
    serverId: string,
    registrationFingerprint: string,
  ): McpPrimitiveTransportLease | null;
  isLeaseCurrent(lease: McpPrimitiveTransportLease): boolean;
  request(input: {
    readonly lease: McpPrimitiveTransportLease;
    readonly requestId: string;
    readonly method: string;
    readonly params: McpJsonObject;
    readonly name?: string;
    readonly parameterHeaders?: Readonly<Record<string, string>>;
    readonly sourceEpoch: number | null;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  openStream(input: {
    readonly lease: McpPrimitiveTransportLease;
    readonly requestId: string;
    readonly method: "subscriptions/listen";
    readonly params: McpJsonObject;
    readonly sourceEpoch: number;
    readonly signal: AbortSignal;
  }): Promise<McpTransportResponseStream>;
  invalidateLease(
    lease: McpPrimitiveTransportLease,
    error: McpOperationError,
  ): void;
  now(): Date;
  createId(): string;
}
