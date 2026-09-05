import { createHash } from "node:crypto";

export const AGENT_INSTRUCTIONS_SCHEMA_VERSION = 1 as const;
export const AGENT_INSTRUCTIONS_DIGEST_ALGORITHM = "sha256" as const;

const DIGEST_DOMAIN = "agent-anything.agent-instructions.v1";
const MAX_TOKEN_LENGTH = 1_024;
const MAX_BLOCK_COUNT = 128;
const MAX_BLOCK_CONTENT_LENGTH = 262_144;

export interface AgentInstructionReleaseRef {
  readonly id: string;
  readonly revision: string;
}

export interface AgentInstructionsRef {
  readonly id: string;
  readonly revision: string;
}

export interface AgentInstructionSourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface AgentInstructionBlock {
  readonly id: string;
  readonly source: AgentInstructionSourceRef;
  readonly content: string;
}

export interface AgentInstructionModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

export interface AgentInstructionContentDigest {
  readonly algorithm: typeof AGENT_INSTRUCTIONS_DIGEST_ALGORITHM;
  readonly value: string;
}

export interface AgentInstructions {
  readonly schemaVersion: typeof AGENT_INSTRUCTIONS_SCHEMA_VERSION;
  readonly ref: AgentInstructionsRef;
  readonly release: AgentInstructionReleaseRef;
  readonly model: AgentInstructionModelRef;
  readonly resolverRevision: string;
  readonly blocks: readonly AgentInstructionBlock[];
  readonly contentDigest: AgentInstructionContentDigest;
}

export interface CreateAgentInstructionsInput {
  readonly id: string;
  readonly release: AgentInstructionReleaseRef;
  readonly model: AgentInstructionModelRef;
  readonly resolverRevision: string;
  readonly blocks: readonly AgentInstructionBlock[];
}

export function createAgentInstructions(
  input: CreateAgentInstructionsInput,
): AgentInstructions {
  strictRecord(input, "CreateAgentInstructionsInput", [
    "id",
    "release",
    "model",
    "resolverRevision",
    "blocks",
  ]);
  const release = snapshotReleaseRef(input.release);
  const model = snapshotModelRef(input.model);
  const resolverRevision = token(
    input.resolverRevision,
    "CreateAgentInstructionsInput.resolverRevision",
  );
  const blocks = snapshotBlocks(input.blocks);
  const value = digestInstructionMaterial({
    schemaVersion: AGENT_INSTRUCTIONS_SCHEMA_VERSION,
    release,
    model,
    resolverRevision,
    blocks,
  });

  return deepFreeze({
    schemaVersion: AGENT_INSTRUCTIONS_SCHEMA_VERSION,
    ref: {
      id: token(input.id, "CreateAgentInstructionsInput.id"),
      revision: `sha256:${value}`,
    },
    release,
    model,
    resolverRevision,
    blocks,
    contentDigest: {
      algorithm: AGENT_INSTRUCTIONS_DIGEST_ALGORITHM,
      value,
    },
  });
}

export function snapshotAgentInstructions(
  input: AgentInstructions,
): AgentInstructions {
  strictRecord(input, "AgentInstructions", [
    "schemaVersion",
    "ref",
    "release",
    "model",
    "resolverRevision",
    "blocks",
    "contentDigest",
  ]);
  if (input.schemaVersion !== AGENT_INSTRUCTIONS_SCHEMA_VERSION) {
    throw new TypeError("AgentInstructions.schemaVersion is unsupported.");
  }
  const ref = snapshotInstructionsRef(input.ref);
  const release = snapshotReleaseRef(input.release);
  const model = snapshotModelRef(input.model);
  const resolverRevision = token(
    input.resolverRevision,
    "AgentInstructions.resolverRevision",
  );
  const blocks = snapshotBlocks(input.blocks);
  const contentDigest = snapshotContentDigest(input.contentDigest);
  const expected = digestInstructionMaterial({
    schemaVersion: AGENT_INSTRUCTIONS_SCHEMA_VERSION,
    release,
    model,
    resolverRevision,
    blocks,
  });

  if (contentDigest.value !== expected) {
    throw new TypeError("AgentInstructions.contentDigest does not match its canonical content.");
  }
  if (ref.revision !== `sha256:${expected}`) {
    throw new TypeError("AgentInstructions.ref.revision must identify the canonical content digest.");
  }

  return deepFreeze({
    schemaVersion: AGENT_INSTRUCTIONS_SCHEMA_VERSION,
    ref,
    release,
    model,
    resolverRevision,
    blocks,
    contentDigest,
  });
}

function snapshotInstructionsRef(input: AgentInstructionsRef): AgentInstructionsRef {
  strictRecord(input, "AgentInstructions.ref", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "AgentInstructions.ref.id"),
    revision: digestRef(input.revision, "AgentInstructions.ref.revision"),
  });
}

function snapshotReleaseRef(
  input: AgentInstructionReleaseRef,
): AgentInstructionReleaseRef {
  strictRecord(input, "AgentInstructions.release", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "AgentInstructions.release.id"),
    revision: token(input.revision, "AgentInstructions.release.revision"),
  });
}

function snapshotModelRef(input: AgentInstructionModelRef): AgentInstructionModelRef {
  strictRecord(input, "AgentInstructions.model", ["providerId", "modelId"]);
  return Object.freeze({
    providerId: token(input.providerId, "AgentInstructions.model.providerId"),
    modelId: token(input.modelId, "AgentInstructions.model.modelId"),
  });
}

function snapshotContentDigest(
  input: AgentInstructionContentDigest,
): AgentInstructionContentDigest {
  strictRecord(input, "AgentInstructions.contentDigest", ["algorithm", "value"]);
  if (input.algorithm !== AGENT_INSTRUCTIONS_DIGEST_ALGORITHM) {
    throw new TypeError("AgentInstructions.contentDigest.algorithm is unsupported.");
  }
  if (typeof input.value !== "string" || !/^[0-9a-f]{64}$/.test(input.value)) {
    throw new TypeError("AgentInstructions.contentDigest.value must be canonical SHA-256 hex.");
  }
  return Object.freeze({ algorithm: AGENT_INSTRUCTIONS_DIGEST_ALGORITHM, value: input.value });
}

function snapshotBlocks(
  input: readonly AgentInstructionBlock[],
): readonly AgentInstructionBlock[] {
  if (!Array.isArray(input) || input.length > MAX_BLOCK_COUNT) {
    throw new TypeError(`AgentInstructions.blocks must contain 0 to ${MAX_BLOCK_COUNT} blocks.`);
  }
  const ids = new Set<string>();
  return Object.freeze(input.map((block, index) => {
    const field = `AgentInstructions.blocks[${index}]`;
    strictRecord(block, field, ["id", "source", "content"]);
    const id = token(block.id, `${field}.id`);
    if (ids.has(id)) {
      throw new TypeError(`AgentInstructions.blocks contains duplicate block id '${id}'.`);
    }
    ids.add(id);
    if (
      typeof block.content !== "string" ||
      block.content.trim().length === 0 ||
      block.content.length > MAX_BLOCK_CONTENT_LENGTH ||
      block.content.includes("\0")
    ) {
      throw new TypeError(`${field}.content must be bounded non-empty text.`);
    }
    strictRecord(block.source, `${field}.source`, ["owner", "kind", "id", "revision"]);
    return Object.freeze({
      id,
      source: Object.freeze({
        owner: token(block.source.owner, `${field}.source.owner`),
        kind: token(block.source.kind, `${field}.source.kind`),
        id: token(block.source.id, `${field}.source.id`),
        revision: token(block.source.revision, `${field}.source.revision`),
      }),
      content: block.content,
    });
  }));
}

function digestInstructionMaterial(value: unknown): string {
  return createHash("sha256")
    .update(DIGEST_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("AgentInstructions identity requires finite numbers.");
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") {
    throw new TypeError("AgentInstructions identity must be canonical JSON data.");
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort(compareStrings);
  if (Reflect.ownKeys(value).length !== keys.length) {
    throw new TypeError("AgentInstructions identity cannot contain symbol properties.");
  }
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

function strictRecord(
  input: unknown,
  field: string,
  keys: readonly string[],
): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${field} must be an object.`);
  }
  const actual = Object.keys(input).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    Reflect.ownKeys(input).length !== actual.length
  ) {
    throw new TypeError(`${field} must contain exactly: ${keys.join(", ")}.`);
  }
}

function token(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_TOKEN_LENGTH ||
    input !== input.trim() ||
    input.includes("\0")
  ) {
    throw new TypeError(`${field} must be a bounded non-empty token.`);
  }
  return input;
}

function digestRef(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input)) {
    throw new TypeError(`${field} must be a canonical SHA-256 reference.`);
  }
  return input;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
