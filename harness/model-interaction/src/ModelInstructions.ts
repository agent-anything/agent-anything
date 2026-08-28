import {
  snapshotModelTextContentBlock,
  type ModelTextContentBlock,
} from "./ModelMessage.js";
import { strictRecord } from "./ModelInteractionContractValidation.js";

const MAX_INSTRUCTION_BLOCK_COUNT = 256;

export type ModelInstructionContentBlock = ModelTextContentBlock;

export interface ModelInstructions {
  readonly content: readonly ModelInstructionContentBlock[];
}

export function snapshotModelInstructions(input: ModelInstructions): ModelInstructions {
  strictRecord(input, "ModelInstructions", ["content"]);
  if (
    !Array.isArray(input.content) ||
    input.content.length === 0 ||
    input.content.length > MAX_INSTRUCTION_BLOCK_COUNT
  ) {
    throw new TypeError("ModelInstructions.content must be a bounded non-empty array.");
  }
  return Object.freeze({
    content: Object.freeze(input.content.map((block, index) =>
      snapshotModelTextContentBlock(block, `ModelInstructions.content[${index}]`))),
  });
}

export function modelInstructionsEqual(
  left: ModelInstructions,
  right: ModelInstructions,
): boolean {
  return JSON.stringify(snapshotModelInstructions(left)) ===
    JSON.stringify(snapshotModelInstructions(right));
}
