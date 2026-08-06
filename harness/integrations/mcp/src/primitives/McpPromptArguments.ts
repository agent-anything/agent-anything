import { validateMcpText } from "../protocol/McpJson.js";
import type { McpPromptDescriptor } from "./McpPrimitives.js";
import { McpPrimitiveError } from "./McpPrimitiveError.js";

export function validateMcpPromptArguments(
  prompt: McpPromptDescriptor,
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new McpPrimitiveError(
      "mcp_prompt_arguments_invalid",
      "MCP Prompt arguments must be a plain object.",
    );
  }
  const descriptors = new Map(
    prompt.arguments.map((argument) => [argument.name, argument]),
  );
  const output: Record<string, string> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !descriptors.has(key)) {
      throw new McpPrimitiveError(
        "mcp_prompt_arguments_invalid",
        "MCP Prompt arguments contain an unknown name.",
      );
    }
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (
      property === undefined ||
      property.get !== undefined ||
      property.set !== undefined ||
      !property.enumerable
    ) {
      throw new McpPrimitiveError(
        "mcp_prompt_arguments_invalid",
        "MCP Prompt arguments must use enumerable data properties.",
      );
    }
    output[key] = validateMcpText(
      input[key],
      `prompt.arguments.${key}`,
      65_536,
    );
  }
  for (const argument of prompt.arguments) {
    if (argument.required && !Object.hasOwn(output, argument.name)) {
      throw new McpPrimitiveError(
        "mcp_prompt_arguments_invalid",
        `MCP Prompt argument '${argument.name}' is required.`,
      );
    }
  }
  return Object.freeze(output);
}
