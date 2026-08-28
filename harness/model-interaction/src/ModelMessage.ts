import {
  modelCallRefKey,
  snapshotModelToolCall,
  snapshotModelToolResult,
  type ModelToolCall,
  type ModelToolResult,
} from "./ModelCall.js";
import { strictRecord } from "./ModelInteractionContractValidation.js";

const MAX_MESSAGE_BLOCK_COUNT = 256;
const MAX_TEXT_BLOCK_LENGTH = 131_072;

export interface ModelTextContentBlock {
  readonly kind: "text";
  readonly text: string;
}

export interface ModelToolCallContentBlock {
  readonly kind: "model_tool_call";
  readonly call: ModelToolCall;
}

export interface ModelToolResultContentBlock {
  readonly kind: "model_tool_result";
  readonly result: ModelToolResult;
}

export type ModelInputContentBlock = ModelTextContentBlock;
export type ModelAssistantContentBlock =
  | ModelTextContentBlock
  | ModelToolCallContentBlock;
export type ModelToolResultBlock = ModelToolResultContentBlock;

export type ModelMessage =
  | {
      readonly role: "user";
      readonly content: readonly ModelInputContentBlock[];
    }
  | {
      readonly role: "assistant";
      readonly content: readonly ModelAssistantContentBlock[];
    }
  | {
      readonly role: "tool";
      readonly content: readonly ModelToolResultBlock[];
    };

export type ModelMessageRole = ModelMessage["role"];

export function snapshotModelMessage(input: ModelMessage): ModelMessage {
  strictRecord(input, "ModelMessage", ["role", "content"]);
  if (!Array.isArray(input.content) || input.content.length > MAX_MESSAGE_BLOCK_COUNT) {
    throw new TypeError("ModelMessage.content must be a bounded array.");
  }
  if (input.role === "user") {
    if (input.content.length === 0) {
      throw new TypeError("User Model Messages must contain text.");
    }
    return Object.freeze({
      role: input.role,
      content: Object.freeze(input.content.map((block, index) =>
        snapshotModelTextContentBlock(block, `ModelMessage.content[${index}]`))),
    });
  }
  if (input.role === "assistant") {
    const refs = new Set<string>();
    const providerRefs = new Set<string>();
    const content = input.content.map((block, index) => {
      strictRecord(block as unknown, `ModelMessage.content[${index}]`, ["kind", "text", "call"]);
      if (block.kind === "text") {
        return snapshotModelTextContentBlock(block, `ModelMessage.content[${index}]`);
      }
      if (block.kind !== "model_tool_call") {
        throw new TypeError("Assistant Model Message content is unsupported.");
      }
      strictRecord(block as unknown, `ModelMessage.content[${index}]`, ["kind", "call"]);
      const call = snapshotModelToolCall(block.call);
      if (
        call.ordinal !== index ||
        call.modelCallRef.contentBlockOrdinal !== index
      ) {
        throw new TypeError("Model Tool Call ordinal must match its assistant content position.");
      }
      const ref = modelCallRefKey(call.modelCallRef);
      if (refs.has(ref)) throw new TypeError("Model Call refs must be unique within a turn.");
      refs.add(ref);
      if (call.providerCallRef !== null) {
        const providerRef = `${call.providerCallRef.providerId}\u0000${call.providerCallRef.id}`;
        if (providerRefs.has(providerRef)) {
          throw new TypeError("Provider Call refs must be unique within a turn.");
        }
        providerRefs.add(providerRef);
      }
      return Object.freeze({ kind: "model_tool_call" as const, call });
    });
    return Object.freeze({ role: "assistant", content: Object.freeze(content) });
  }
  if (input.role === "tool") {
    if (input.content.length === 0) {
      throw new TypeError("Tool Model Messages must contain correlated results.");
    }
    const refs = new Set<string>();
    const content = input.content.map((block, index) => {
      strictRecord(block as unknown, `ModelMessage.content[${index}]`, ["kind", "result"]);
      if (block.kind !== "model_tool_result") {
        throw new TypeError("Tool Model Message content is unsupported.");
      }
      const result = snapshotModelToolResult(block.result);
      const ref = modelCallRefKey(result.modelCallRef);
      if (refs.has(ref)) throw new TypeError("Model Tool results must settle unique calls.");
      refs.add(ref);
      return Object.freeze({ kind: "model_tool_result" as const, result });
    });
    return Object.freeze({ role: "tool", content: Object.freeze(content) });
  }
  throw new TypeError("ModelMessage.role is unsupported.");
}

export function snapshotModelMessages(input: readonly ModelMessage[]): readonly ModelMessage[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1_024) {
    throw new TypeError("Model messages must be a bounded non-empty array.");
  }
  return Object.freeze(input.map(snapshotModelMessage));
}

export function modelMessagesEqual(
  left: readonly ModelMessage[],
  right: readonly ModelMessage[],
): boolean {
  return JSON.stringify(snapshotModelMessages(left)) ===
    JSON.stringify(snapshotModelMessages(right));
}

export function snapshotModelTextContentBlock(
  input: ModelTextContentBlock,
  path: string,
): ModelTextContentBlock {
  strictRecord(input, path, ["kind", "text"]);
  if (
    input.kind !== "text" ||
    typeof input.text !== "string" ||
    input.text.length > MAX_TEXT_BLOCK_LENGTH
  ) {
    throw new TypeError(`${path} must be a bounded text block.`);
  }
  return Object.freeze({ kind: "text", text: input.text });
}
