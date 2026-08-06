
import type {
  ToolAnnotations,
  ToolJsonObject,
} from "@agent-anything/tools";
import { createMcpToolHeaderBindings } from "./McpHeaders.js";
import {
  assertCanonicalDataArray,
  assertExtensibleDataProperties,
  assertPlainRecord,
  createMcpContractFingerprint,
  type McpJsonObject,
  type McpJsonValue,
  snapshotMcpJsonObject,
  validateMcpText,
  validateMcpToken,
  validateNonNegativeSafeInteger,
} from "./McpJson.js";
import type {
  McpIcon,
  McpPrimitiveCache,
  McpPrimitiveDiagnostic,
  McpPromptDescriptor,
  McpPromptGetResult,
  McpPromptMessage,
  McpResourceAnnotations,
  McpResourceContent,
  McpResourceDescriptor,
  McpResourceReadResult,
  McpResourceTemplateDescriptor,
  McpSourceLookup,
  McpToolCallOutput,
  McpToolDescriptor,
} from "../primitives/McpPrimitives.js";
import {
  McpOperationError,
  parseMcpOperationCache,
  parseMcpOperationResponse,
} from "./McpProtocol.js";
import type { McpTransportKind } from "../registration/McpRegistration.js";
import {
  compileMcpSchema,
  type McpCompiledSchema,
} from "./McpSchema.js";

export interface McpParsedTool {
  readonly descriptor: McpToolDescriptor;
  readonly inputValidator: McpCompiledSchema;
  readonly outputValidator: McpCompiledSchema | null;
}

export interface McpParsedListPage<T> {
  readonly items: readonly T[];
  readonly diagnostics: readonly McpPrimitiveDiagnostic[];
  readonly nextCursor: string | null;
  readonly cache: McpPrimitiveCache;
}

export interface McpParsedToolCallResult {
  readonly isError: boolean;
  readonly output: McpToolCallOutput;
}

export function parseMcpToolsListPage(input: {
  readonly response: unknown;
  readonly requestId: string;
  readonly receivedAt: string;
  readonly maxTtlMs: number;
  readonly transportKind: McpTransportKind;
}): McpParsedListPage<McpParsedTool> {
  const page = parseListPage(input, "tools/list", "tools");
  const items: McpParsedTool[] = [];
  const diagnostics: McpPrimitiveDiagnostic[] = [];
  page.rawItems.forEach((candidate, index) => {
    try {
      items.push(parseTool(
        candidate,
        `response.result.tools[${index}]`,
        input.transportKind,
      ));
    } catch (error) {
      diagnostics.push(diagnostic(
        "tool",
        readCandidateIdentity(candidate, "name"),
        error,
      ));
    }
  });
  return freezePage(items, diagnostics, page);
}

export function parseMcpResourcesListPage(input: {
  readonly response: unknown;
  readonly requestId: string;
  readonly receivedAt: string;
  readonly maxTtlMs: number;
}): McpParsedListPage<McpResourceDescriptor> {
  const page = parseListPage(input, "resources/list", "resources");
  const items: McpResourceDescriptor[] = [];
  const diagnostics: McpPrimitiveDiagnostic[] = [];
  page.rawItems.forEach((candidate, index) => {
    try {
      items.push(parseResource(
        candidate,
        `response.result.resources[${index}]`,
      ));
    } catch (error) {
      diagnostics.push(diagnostic(
        "resource",
        readCandidateIdentity(candidate, "uri"),
        error,
      ));
    }
  });
  return freezePage(items, diagnostics, page);
}

export function parseMcpResourceTemplatesListPage(input: {
  readonly response: unknown;
  readonly requestId: string;
  readonly receivedAt: string;
  readonly maxTtlMs: number;
}): McpParsedListPage<McpResourceTemplateDescriptor> {
  const page = parseListPage(
    input,
    "resources/templates/list",
    "resourceTemplates",
  );
  const items: McpResourceTemplateDescriptor[] = [];
  const diagnostics: McpPrimitiveDiagnostic[] = [];
  page.rawItems.forEach((candidate, index) => {
    try {
      items.push(parseResourceTemplate(
        candidate,
        `response.result.resourceTemplates[${index}]`,
      ));
    } catch (error) {
      diagnostics.push(diagnostic(
        "resource-template",
        readCandidateIdentity(candidate, "uriTemplate"),
        error,
      ));
    }
  });
  return freezePage(items, diagnostics, page);
}

export function parseMcpPromptsListPage(input: {
  readonly response: unknown;
  readonly requestId: string;
  readonly receivedAt: string;
  readonly maxTtlMs: number;
}): McpParsedListPage<McpPromptDescriptor> {
  const page = parseListPage(input, "prompts/list", "prompts");
  const items: McpPromptDescriptor[] = [];
  const diagnostics: McpPrimitiveDiagnostic[] = [];
  page.rawItems.forEach((candidate, index) => {
    try {
      items.push(parsePrompt(
        candidate,
        `response.result.prompts[${index}]`,
      ));
    } catch (error) {
      diagnostics.push(diagnostic(
        "prompt",
        readCandidateIdentity(candidate, "name"),
        error,
      ));
    }
  });
  return freezePage(items, diagnostics, page);
}

export function parseMcpToolCallResult(input: {
  readonly response: unknown;
  readonly requestId: string;
  readonly outputValidator: McpCompiledSchema | null;
}): McpParsedToolCallResult {
  const result = parseMcpOperationResponse({
    response: input.response,
    requestId: input.requestId,
    operation: "tools/call",
  });
  requireCompleteResult(result, "tools/call");
  const content = parseContentBlocks(result.content, "response.result.content");
  const isError = result.isError === undefined
    ? false
    : requireBoolean(result.isError, "response.result.isError");
  let structuredContent: McpJsonValue | undefined;
  if (Object.hasOwn(result, "structuredContent")) {
    structuredContent = snapshotJsonValue(
      result.structuredContent,
      "response.result.structuredContent",
    );
  }
  if (input.outputValidator !== null) {
    if (structuredContent === undefined) {
      operationInvalid(
        "MCP Tool result must contain structuredContent for its output schema.",
      );
    }
    const validation = input.outputValidator.validate(structuredContent);
    if (!validation.valid) {
      operationInvalid("MCP Tool structured output does not match its schema.");
    }
  }
  return Object.freeze({
    isError,
    output: Object.freeze({
      content,
      ...(structuredContent === undefined ? {} : { structuredContent }),
    }),
  });
}

export function parseMcpResourceReadResult(input: {
  readonly response: unknown;
  readonly requestId: string;
  readonly source: McpSourceLookup;
  readonly requestedUri: string;
  readonly receivedAt: string;
  readonly maxTtlMs: number;
}): McpResourceReadResult {
  const result = parseMcpOperationResponse({
    response: input.response,
    requestId: input.requestId,
    operation: "resources/read",
  });
  requireCompleteResult(result, "resources/read");
  assertCanonicalDataArray(result.contents, "response.result.contents");
  if (result.contents.length === 0 || result.contents.length > 256) {
    operationInvalid("MCP Resource read contents must be bounded and non-empty.");
  }
  const contents = Object.freeze(result.contents.map((candidate, index) =>
    parseResourceContent(
      candidate,
      `response.result.contents[${index}]`,
    )
  ));
  const cache = parseMcpOperationCache({
    result,
    receivedAt: input.receivedAt,
    maxTtlMs: input.maxTtlMs,
  });
  const fields = Object.freeze({
    source: Object.freeze({ ...input.source }),
    uri: input.requestedUri,
    contents,
    cache,
  });
  return Object.freeze({
    ...fields,
    resultFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-resource-read.v1",
      fields,
    ),
  });
}

export function parseMcpPromptGetResult(input: {
  readonly response: unknown;
  readonly requestId: string;
  readonly source: McpSourceLookup;
  readonly name: string;
}): McpPromptGetResult {
  const result = parseMcpOperationResponse({
    response: input.response,
    requestId: input.requestId,
    operation: "prompts/get",
  });
  requireCompleteResult(result, "prompts/get");
  assertCanonicalDataArray(result.messages, "response.result.messages");
  if (result.messages.length === 0 || result.messages.length > 256) {
    operationInvalid("MCP Prompt messages must be bounded and non-empty.");
  }
  const messages = Object.freeze(result.messages.map((candidate, index) =>
    parsePromptMessage(candidate, `response.result.messages[${index}]`)
  ));
  const description = result.description === undefined
    ? null
    : validateMcpText(
      result.description,
      "response.result.description",
      8_192,
    );
  const fields = Object.freeze({
    source: Object.freeze({ ...input.source }),
    name: input.name,
    description,
    messages,
  });
  return Object.freeze({
    ...fields,
    resultFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-prompt-get.v1",
      fields,
    ),
  });
}

function parseListPage(
  input: {
    readonly response: unknown;
    readonly requestId: string;
    readonly receivedAt: string;
    readonly maxTtlMs: number;
  },
  operation: string,
  itemField: string,
): {
  readonly rawItems: readonly unknown[];
  readonly nextCursor: string | null;
  readonly cache: McpPrimitiveCache;
} {
  const result = parseMcpOperationResponse({
    response: input.response,
    requestId: input.requestId,
    operation,
  });
  requireCompleteResult(result, operation);
  const rawItems = result[itemField];
  assertCanonicalDataArray(rawItems, `response.result.${itemField}`);
  if (rawItems.length > 1_024) {
    operationInvalid(`MCP ${operation} page exceeds the item limit.`);
  }
  const nextCursor = result.nextCursor === undefined
    ? null
    : validateCursor(result.nextCursor, "response.result.nextCursor");
  const cache = parseMcpOperationCache({
    result,
    receivedAt: input.receivedAt,
    maxTtlMs: input.maxTtlMs,
  });
  return Object.freeze({ rawItems, nextCursor, cache });
}

function parseTool(
  input: unknown,
  path: string,
  transportKind: McpTransportKind,
): McpParsedTool {
  assertPlainRecord(input, path);
  assertExtensibleDataProperties(
    input,
    new Set(["name", "inputSchema"]),
    path,
  );
  const name = validatePrimitiveName(input.name, `${path}.name`);
  const inputValidator = compileMcpSchema(input.inputSchema, `${path}.inputSchema`);
  if (inputValidator.schema.type !== "object") {
    throw new TypeError(`${path}.inputSchema must describe an object root.`);
  }
  const outputValidator = input.outputSchema === undefined
    ? null
    : compileMcpSchema(input.outputSchema, `${path}.outputSchema`);
  const title = optionalText(input.title, `${path}.title`, 512);
  const description = optionalText(
    input.description,
    `${path}.description`,
    8_192,
  );
  const annotations = parseToolAnnotations(
    input.annotations,
    `${path}.annotations`,
    title,
  );
  const icons = parseIcons(input.icons, `${path}.icons`);
  const sourceMetadata = parseMetadata(input._meta, `${path}._meta`);
  const headerBindings = createMcpToolHeaderBindings({
    schema: inputValidator.schema,
    transportKind,
    path: `${path}.inputSchema`,
  });
  const fields = Object.freeze({
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    icons,
    inputSchema: inputValidator.schema as ToolJsonObject,
    ...(outputValidator === null
      ? {}
      : { outputSchema: outputValidator.schema as ToolJsonObject }),
    schema: inputValidator.identity,
    inputSchemaFingerprint: inputValidator.schemaFingerprint,
    outputSchemaFingerprint: outputValidator?.schemaFingerprint ?? null,
    annotations,
    headerBindings,
    sourceMetadata,
  });
  const descriptor: McpToolDescriptor = Object.freeze({
    ...fields,
    descriptorFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-tool-descriptor.v1",
      fields,
    ),
  });
  return Object.freeze({ descriptor, inputValidator, outputValidator });
}

function parseResource(
  input: unknown,
  path: string,
): McpResourceDescriptor {
  assertPlainRecord(input, path);
  assertExtensibleDataProperties(input, new Set(["uri", "name"]), path);
  const uri = validateUri(input.uri, `${path}.uri`);
  const name = validateMcpText(input.name, `${path}.name`, 512);
  const fields = Object.freeze({
    uri,
    name,
    ...optionalCommonDescriptorFields(input, path),
    ...(input.size === undefined
      ? {}
      : {
          size: validateNonNegativeSafeInteger(input.size, `${path}.size`),
        }),
    icons: parseIcons(input.icons, `${path}.icons`),
    annotations: parseResourceAnnotations(
      input.annotations,
      `${path}.annotations`,
    ),
    sourceMetadata: parseMetadata(input._meta, `${path}._meta`),
  });
  return Object.freeze({
    ...fields,
    descriptorFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-resource-descriptor.v1",
      fields,
    ),
  });
}

function parseResourceTemplate(
  input: unknown,
  path: string,
): McpResourceTemplateDescriptor {
  assertPlainRecord(input, path);
  assertExtensibleDataProperties(
    input,
    new Set(["uriTemplate", "name"]),
    path,
  );
  const uriTemplate = boundedString(
    input.uriTemplate,
    `${path}.uriTemplate`,
    8_192,
  );
  if (/[\u0000-\u001f\u007f]/.test(uriTemplate)) {
    throw new TypeError(`${path}.uriTemplate contains control characters.`);
  }
  const fields = Object.freeze({
    uriTemplate,
    name: validateMcpText(input.name, `${path}.name`, 512),
    ...optionalCommonDescriptorFields(input, path),
    icons: parseIcons(input.icons, `${path}.icons`),
    annotations: parseResourceAnnotations(
      input.annotations,
      `${path}.annotations`,
    ),
    sourceMetadata: parseMetadata(input._meta, `${path}._meta`),
  });
  return Object.freeze({
    ...fields,
    descriptorFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-resource-template-descriptor.v1",
      fields,
    ),
  });
}

function parsePrompt(
  input: unknown,
  path: string,
): McpPromptDescriptor {
  assertPlainRecord(input, path);
  assertExtensibleDataProperties(input, new Set(["name"]), path);
  const name = validatePrimitiveName(input.name, `${path}.name`);
  const title = optionalText(input.title, `${path}.title`, 512);
  const description = optionalText(
    input.description,
    `${path}.description`,
    8_192,
  );
  const argumentsValue = input.arguments;
  if (argumentsValue !== undefined) {
    assertCanonicalDataArray(argumentsValue, `${path}.arguments`);
  }
  const argumentNames = new Set<string>();
  const args = Object.freeze((argumentsValue ?? []).map((candidate, index) => {
    const argumentPath = `${path}.arguments[${index}]`;
    assertPlainRecord(candidate, argumentPath);
    assertExtensibleDataProperties(candidate, new Set(["name"]), argumentPath);
    const argumentName = validatePrimitiveName(
      candidate.name,
      `${argumentPath}.name`,
    );
    if (argumentNames.has(argumentName)) {
      throw new TypeError(`${argumentPath}.name is duplicated.`);
    }
    argumentNames.add(argumentName);
    return Object.freeze({
      name: argumentName,
      ...(candidate.description === undefined
        ? {}
        : {
            description: validateMcpText(
              candidate.description,
              `${argumentPath}.description`,
              8_192,
            ),
          }),
      required: candidate.required === undefined
        ? false
        : requireBoolean(candidate.required, `${argumentPath}.required`),
    });
  }));
  const fields = Object.freeze({
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    arguments: args,
    icons: parseIcons(input.icons, `${path}.icons`),
    sourceMetadata: parseMetadata(input._meta, `${path}._meta`),
  });
  return Object.freeze({
    ...fields,
    descriptorFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-prompt-descriptor.v1",
      fields,
    ),
  });
}

function parseResourceContent(
  input: unknown,
  path: string,
): McpResourceContent {
  assertPlainRecord(input, path);
  assertExtensibleDataProperties(input, new Set(["uri"]), path);
  const uri = validateUri(input.uri, `${path}.uri`);
  const mimeType = input.mimeType === undefined
    ? null
    : boundedString(input.mimeType, `${path}.mimeType`, 512);
  const annotations = parseResourceAnnotations(
    input.annotations,
    `${path}.annotations`,
  );
  const hasText = Object.hasOwn(input, "text");
  const hasBlob = Object.hasOwn(input, "blob");
  if (hasText === hasBlob) {
    throw new TypeError(`${path} must contain exactly one text or blob value.`);
  }
  if (hasText) {
    return Object.freeze({
      kind: "text",
      uri,
      mimeType,
      text: boundedString(input.text, `${path}.text`, 65_536, true),
      annotations,
    });
  }
  const base64Data = boundedString(
    input.blob,
    `${path}.blob`,
    65_536,
  );
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64Data)) {
    throw new TypeError(`${path}.blob must be canonical Base64 data.`);
  }
  return Object.freeze({
    kind: "blob",
    uri,
    mimeType,
    base64Data,
    annotations,
  });
}

function parsePromptMessage(input: unknown, path: string): McpPromptMessage {
  assertPlainRecord(input, path);
  assertExtensibleDataProperties(input, new Set(["role", "content"]), path);
  if (input.role !== "user" && input.role !== "assistant") {
    throw new TypeError(`${path}.role is invalid.`);
  }
  const content = snapshotMcpJsonObject(input.content, `${path}.content`);
  if (typeof content.type !== "string" || content.type.length === 0) {
    throw new TypeError(`${path}.content.type is required.`);
  }
  return Object.freeze({ role: input.role, content });
}

function parseContentBlocks(
  input: unknown,
  path: string,
): readonly McpJsonObject[] {
  assertCanonicalDataArray(input, path);
  if (input.length > 256) {
    operationInvalid("MCP content block count exceeds the supported limit.");
  }
  return Object.freeze(input.map((candidate, index) => {
    const content = snapshotMcpJsonObject(candidate, `${path}[${index}]`);
    if (typeof content.type !== "string" || content.type.length === 0) {
      throw new TypeError(`${path}[${index}].type is required.`);
    }
    return content;
  }));
}

function parseToolAnnotations(
  input: unknown,
  path: string,
  title: string | undefined,
): ToolAnnotations {
  if (input === undefined) {
    return Object.freeze(title === undefined ? {} : { title });
  }
  assertPlainRecord(input, path);
  const booleanFields = [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const;
  const annotations: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  } = {};
  const annotationTitle = input.title === undefined
    ? title
    : validateMcpText(input.title, `${path}.title`, 512);
  if (annotationTitle !== undefined) annotations.title = annotationTitle;
  for (const field of booleanFields) {
    if (input[field] !== undefined) {
      annotations[field] = requireBoolean(input[field], `${path}.${field}`);
    }
  }
  return Object.freeze(annotations);
}

function parseResourceAnnotations(
  input: unknown,
  path: string,
): McpResourceAnnotations {
  if (input === undefined) return Object.freeze({});
  assertPlainRecord(input, path);
  let audience: readonly ("user" | "assistant")[] | undefined;
  if (input.audience !== undefined) {
    assertCanonicalDataArray(input.audience, `${path}.audience`);
    const unique = new Set<"user" | "assistant">();
    for (const role of input.audience) {
      if (role !== "user" && role !== "assistant") {
        throw new TypeError(`${path}.audience contains an invalid role.`);
      }
      unique.add(role);
    }
    audience = Object.freeze([...unique].sort());
  }
  let priority: number | undefined;
  if (input.priority !== undefined) {
    if (
      typeof input.priority !== "number" ||
      !Number.isFinite(input.priority) ||
      input.priority < 0 ||
      input.priority > 1
    ) {
      throw new TypeError(`${path}.priority must be between 0 and 1.`);
    }
    priority = input.priority;
  }
  let lastModified: string | undefined;
  if (input.lastModified !== undefined) {
    const value = boundedString(
      input.lastModified,
      `${path}.lastModified`,
      128,
    );
    if (!Number.isFinite(Date.parse(value))) {
      throw new TypeError(`${path}.lastModified is invalid.`);
    }
    lastModified = value;
  }
  return Object.freeze({
    ...(audience === undefined ? {} : { audience }),
    ...(priority === undefined ? {} : { priority }),
    ...(lastModified === undefined ? {} : { lastModified }),
  });
}

function parseIcons(input: unknown, path: string): readonly McpIcon[] {
  if (input === undefined) return Object.freeze([]);
  assertCanonicalDataArray(input, path);
  if (input.length > 32) {
    throw new TypeError(`${path} exceeds the icon limit.`);
  }
  return Object.freeze(input.map((candidate, index) => {
    const iconPath = `${path}[${index}]`;
    assertPlainRecord(candidate, iconPath);
    assertExtensibleDataProperties(candidate, new Set(["src"]), iconPath);
    const src = validateUri(candidate.src, `${iconPath}.src`, true);
    const mimeType = candidate.mimeType === undefined
      ? undefined
      : boundedString(candidate.mimeType, `${iconPath}.mimeType`, 256);
    let sizes: readonly string[] | undefined;
    if (candidate.sizes !== undefined) {
      assertCanonicalDataArray(candidate.sizes, `${iconPath}.sizes`);
      sizes = Object.freeze(candidate.sizes.map((size, sizeIndex) =>
        boundedString(size, `${iconPath}.sizes[${sizeIndex}]`, 32)
      ));
    }
    const theme = candidate.theme;
    if (theme !== undefined && theme !== "light" && theme !== "dark") {
      throw new TypeError(`${iconPath}.theme is invalid.`);
    }
    return Object.freeze({
      src,
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(sizes === undefined ? {} : { sizes }),
      ...(theme === undefined ? {} : { theme }),
    });
  }));
}

function parseMetadata(input: unknown, path: string): McpJsonObject {
  return input === undefined
    ? Object.freeze({})
    : snapshotMcpJsonObject(input, path);
}

function optionalCommonDescriptorFields(
  input: Record<string, unknown>,
  path: string,
): {
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
} {
  const title = optionalText(input.title, `${path}.title`, 512);
  const description = optionalText(
    input.description,
    `${path}.description`,
    8_192,
  );
  const mimeType = optionalText(input.mimeType, `${path}.mimeType`, 512);
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
  });
}

function requireCompleteResult(
  result: McpJsonObject,
  operation: string,
): void {
  if (result.resultType === "input_required") {
    throw new McpOperationError(
      "mcp_operation_result_unsupported",
      `MCP ${operation} requires an unsupported multi-round-trip client feature.`,
    );
  }
  if (result.resultType !== "complete") {
    throw new McpOperationError(
      "mcp_operation_result_unsupported",
      `MCP ${operation} returned an unsupported result type.`,
    );
  }
}

function validatePrimitiveName(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 128 ||
    !/^[A-Za-z0-9_.-]+$/.test(input)
  ) {
    throw new TypeError(`${path} is not a valid MCP primitive name.`);
  }
  return input;
}

function validateCursor(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw new TypeError(`${path} must be a bounded opaque cursor.`);
  }
  return input;
}

function validateUri(
  input: unknown,
  path: string,
  allowData = false,
): string {
  const value = boundedString(input, path, 8_192);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${path} contains control characters.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${path} must be an absolute URI.`);
  }
  if (!allowData && url.protocol === "data:") {
    throw new TypeError(`${path} cannot use a data URI.`);
  }
  return value;
}

function optionalText(
  input: unknown,
  path: string,
  maxLength: number,
): string | undefined {
  return input === undefined
    ? undefined
    : validateMcpText(input, path, maxLength);
}

function boundedString(
  input: unknown,
  path: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof input !== "string" ||
    (!allowEmpty && input.length === 0) ||
    input.length > maxLength
  ) {
    throw new TypeError(`${path} must be bounded text.`);
  }
  return input;
}

function requireBoolean(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") {
    throw new TypeError(`${path} must be boolean.`);
  }
  return input;
}

function snapshotJsonValue(input: unknown, path: string): McpJsonValue {
  if (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input)
  ) {
    return snapshotMcpJsonObject(input, path);
  }
  return snapshotMcpJsonObject(
    Object.freeze({ value: input as never }),
    path,
  ).value!;
}

function readCandidateIdentity(
  input: unknown,
  field: string,
): string | null {
  if (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input)
  ) {
    const value = (input as Record<string, unknown>)[field];
    if (
      field === "name" &&
      typeof value === "string" &&
      value.length <= 128 &&
      /^[A-Za-z0-9_.-]+$/.test(value)
    ) {
      return value;
    }
  }
  return null;
}

function diagnostic(
  primitive: McpPrimitiveDiagnostic["primitive"],
  itemIdentity: string | null,
  error: unknown,
): McpPrimitiveDiagnostic {
  const code = error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : "mcp_primitive_invalid";
  return Object.freeze({
    primitive,
    itemIdentity,
    code,
    message: `MCP ${primitive} definition was excluded because it is invalid.`,
  });
}

function freezePage<T>(
  items: readonly T[],
  diagnostics: readonly McpPrimitiveDiagnostic[],
  page: {
    readonly nextCursor: string | null;
    readonly cache: McpPrimitiveCache;
  },
): McpParsedListPage<T> {
  return Object.freeze({
    items: Object.freeze([...items]),
    diagnostics: Object.freeze([...diagnostics]),
    nextCursor: page.nextCursor,
    cache: page.cache,
  });
}

function operationInvalid(message: string): never {
  throw new McpOperationError("mcp_operation_response_invalid", message);
}
