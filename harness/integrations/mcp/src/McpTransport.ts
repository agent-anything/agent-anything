import type { ISODateTimeString } from "@agent-anything/foundation";
import type { McpJsonObject } from "./McpJson.js";
import type {
  McpProtocolRevision,
  McpTransportBindingIdentity,
} from "./McpRegistration.js";

export interface McpJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params: McpJsonObject;
}

export interface McpHttpRequestHeaders {
  readonly Accept: "application/json, text/event-stream";
  readonly "MCP-Protocol-Version": McpProtocolRevision;
  readonly "Mcp-Method": string;
  readonly "Mcp-Name"?: string;
}

export interface McpTransportRequest {
  readonly message: McpJsonRpcRequest;
  readonly httpHeaders: McpHttpRequestHeaders | null;
}

export interface McpTransportOperationControl {
  readonly operationId: string;
  readonly registrationFingerprint: string;
  readonly sourceEpoch: number | null;
  readonly deadlineAt: ISODateTimeString;
  readonly signal: AbortSignal;
}

export interface McpTransportConnectRequest {
  readonly registrationFingerprint: string;
  readonly binding: McpTransportBindingIdentity;
  readonly credentialRef: string | null;
}

export interface McpTransportConnectionIdentity {
  readonly connectionId: string;
  readonly registrationFingerprint: string;
  readonly binding: McpTransportBindingIdentity;
}

export interface McpTransportClosure {
  readonly kind: "closed" | "failed";
  readonly code: string | null;
  readonly message: string | null;
}

export interface McpTransportCloseRequest {
  readonly reason:
    | "activation_failed"
    | "deactivated"
    | "stale_connection";
}

export interface McpTransportConnection {
  readonly identity: McpTransportConnectionIdentity;
  readonly closed: Promise<McpTransportClosure>;
  request(
    request: McpTransportRequest,
    control: McpTransportOperationControl,
  ): Promise<unknown>;
  close(
    request: McpTransportCloseRequest,
    control: McpTransportOperationControl,
  ): Promise<void>;
}

export interface McpTransportConnector {
  connect(
    request: McpTransportConnectRequest,
    control: McpTransportOperationControl,
  ): Promise<McpTransportConnection>;
}
