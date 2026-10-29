import {createHash} from "node:crypto";
import {createProviderSemanticRequestDigest, type ProviderRequest} from "../ProviderRequest.js";
import {modelInputValueDigest} from "./ModelWorkingView.js";

/** Credentials and mutable transport handles are deliberately absent. */
export interface EncodedModelInput {
  readonly kind: "encoded_model_input";
  readonly revision: "1";
  readonly id: string;
  readonly requestDigest: string;
  readonly targetDigest: string;
  readonly adapterRevision: string;
  readonly endpoint: string;
  readonly mode: "buffered" | "streaming";
  readonly mediaType: string;
  readonly body: string;
  readonly bodyDigest: string;
  readonly bytes: number;
}

export function createEncodedModelInput(input: {
  request: ProviderRequest; target: unknown; adapterRevision: string; endpoint: string;
  mode: EncodedModelInput["mode"]; body: string; mediaType?: string;
}): EncodedModelInput {
  const value = {
    kind: "encoded_model_input" as const, revision: "1" as const,
    requestDigest: createProviderSemanticRequestDigest(input.request),
    targetDigest: modelInputValueDigest(input.target), adapterRevision: input.adapterRevision,
    endpoint: input.endpoint, mode: input.mode, mediaType: input.mediaType ?? "application/json",
    body: input.body, bodyDigest: bytesDigest(input.body), bytes: Buffer.byteLength(input.body, "utf8"),
  };
  return Object.freeze({...value, id: modelInputValueDigest(value)});
}

export function verifyEncodedModelInput(artifact: EncodedModelInput, input: {
  request: ProviderRequest; target: unknown; adapterRevision: string; endpoint: string;
  mode: EncodedModelInput["mode"];
}): void {
  assertEncodedModelInputIntegrity(artifact,input.request);
  if (artifact.targetDigest !== modelInputValueDigest(input.target) ||
      artifact.adapterRevision !== input.adapterRevision || artifact.endpoint !== input.endpoint ||
      artifact.mode !== input.mode) throw new TypeError("encoded_model_input_binding_changed");
}

export function assertEncodedModelInputIntegrity(artifact:EncodedModelInput,request:ProviderRequest):void {
  const {id, ...value} = artifact;
  if (artifact.kind !== "encoded_model_input" || artifact.revision !== "1" ||
      id !== modelInputValueDigest(value) || artifact.bodyDigest !== bytesDigest(artifact.body) ||
      artifact.bytes !== Buffer.byteLength(artifact.body, "utf8") ||
      artifact.requestDigest !== createProviderSemanticRequestDigest(request)) throw new TypeError("encoded_model_input_binding_changed");
}

function bytesDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
