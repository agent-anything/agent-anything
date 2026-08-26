import { createHash } from "node:crypto";

import {
  snapshotAgent,
  toAgentRevisionRef,
  type Agent,
  type AgentInstructionModelRef,
  type AgentInstructionsRef,
  type AgentRevisionRef,
} from "@agent-anything/agent-core/agent";
import type { RunRef } from "@agent-anything/agent-core/run";

const BINDING_DIGEST_DOMAIN = "agent-anything.agent-instruction-binding.v1";

export interface AgentInstructionBindingRef {
  readonly id: string;
  readonly revision: string;
}

export interface AgentInstructionBinding {
  readonly ref: AgentInstructionBindingRef;
  readonly run: RunRef;
  readonly agent: AgentRevisionRef;
  readonly instructions: AgentInstructionsRef;
  readonly model: AgentInstructionModelRef;
  readonly effectiveFromRunRevision: number;
  readonly supersedes: AgentInstructionBindingRef | null;
}

export interface AgentInstructionBindingProjection {
  readonly ref: AgentInstructionBindingRef;
  readonly agent: AgentRevisionRef;
  readonly instructions: AgentInstructionsRef;
  readonly release: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly model: AgentInstructionModelRef;
  readonly resolverRevision: string;
  readonly contentDigest: Readonly<{ readonly algorithm: "sha256"; readonly value: string }>;
  readonly blockCount: number;
  readonly effectiveFromRunRevision: number;
  readonly supersedes: AgentInstructionBindingRef | null;
}

export function createAgentInstructionBinding<TOutput>(input: {
  readonly run: RunRef;
  readonly agent: Agent<TOutput>;
  readonly effectiveFromRunRevision: number;
  readonly supersedes: AgentInstructionBindingRef | null;
}): AgentInstructionBinding {
  const run = snapshotRunRef(input.run);
  const agent = snapshotAgent(input.agent);
  const effectiveFromRunRevision = nonNegativeInteger(
    input.effectiveFromRunRevision,
    "AgentInstructionBinding.effectiveFromRunRevision",
  );
  const supersedes = input.supersedes === null
    ? null
    : snapshotAgentInstructionBindingRef(input.supersedes);
  const material = {
    run,
    agent: toAgentRevisionRef(agent),
    instructions: agent.instructions.ref,
    model: agent.instructions.model,
    effectiveFromRunRevision,
    supersedes,
  };
  const revision = bindingRevision(material);

  return deepFreeze({
    ref: {
      id: `${run.id}:agent-instruction-binding:${effectiveFromRunRevision}`,
      revision,
    },
    ...material,
  });
}

export function snapshotAgentInstructionBinding(
  input: AgentInstructionBinding,
): AgentInstructionBinding {
  strictRecord(input, "AgentInstructionBinding", [
    "ref",
    "run",
    "agent",
    "instructions",
    "model",
    "effectiveFromRunRevision",
    "supersedes",
  ]);
  const snapshot = deepFreeze({
    ref: snapshotAgentInstructionBindingRef(input.ref),
    run: snapshotRunRef(input.run),
    agent: snapshotAgentRef(input.agent),
    instructions: snapshotInstructionsRef(input.instructions),
    model: snapshotModelRef(input.model),
    effectiveFromRunRevision: nonNegativeInteger(
      input.effectiveFromRunRevision,
      "AgentInstructionBinding.effectiveFromRunRevision",
    ),
    supersedes: input.supersedes === null
      ? null
      : snapshotAgentInstructionBindingRef(input.supersedes),
  });
  const expectedId = `${snapshot.run.id}:agent-instruction-binding:${snapshot.effectiveFromRunRevision}`;
  const expectedRevision = bindingRevision({
    run: snapshot.run,
    agent: snapshot.agent,
    instructions: snapshot.instructions,
    model: snapshot.model,
    effectiveFromRunRevision: snapshot.effectiveFromRunRevision,
    supersedes: snapshot.supersedes,
  });
  if (snapshot.ref.id !== expectedId || snapshot.ref.revision !== expectedRevision) {
    throw new TypeError("AgentInstructionBinding.ref does not identify its canonical material.");
  }
  return snapshot;
}

function bindingRevision(material: {
  readonly run: RunRef;
  readonly agent: AgentRevisionRef;
  readonly instructions: AgentInstructionsRef;
  readonly model: AgentInstructionModelRef;
  readonly effectiveFromRunRevision: number;
  readonly supersedes: AgentInstructionBindingRef | null;
}): string {
  const digest = createHash("sha256")
    .update(BINDING_DIGEST_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(material), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function snapshotAgentInstructionBindingRef(
  input: AgentInstructionBindingRef,
): AgentInstructionBindingRef {
  strictRecord(input, "AgentInstructionBindingRef", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "AgentInstructionBindingRef.id"),
    revision: digest(input.revision, "AgentInstructionBindingRef.revision"),
  });
}

export function assertAgentInstructionBindingMatches<TOutput>(input: {
  readonly binding: AgentInstructionBinding;
  readonly run: RunRef;
  readonly agent: Agent<TOutput>;
}): void {
  const binding = snapshotAgentInstructionBinding(input.binding);
  const agent = snapshotAgent(input.agent);
  if (
    binding.run.id !== input.run.id ||
    binding.agent.id !== agent.id ||
    binding.agent.revision !== agent.revision ||
    binding.instructions.id !== agent.instructions.ref.id ||
    binding.instructions.revision !== agent.instructions.ref.revision ||
    binding.model.providerId !== agent.instructions.model.providerId ||
    binding.model.modelId !== agent.instructions.model.modelId
  ) {
    throw new TypeError("AgentInstructionBinding does not match the active Run and Agent.");
  }
}

export function projectAgentInstructionBinding<TOutput>(input: {
  readonly binding: AgentInstructionBinding;
  readonly run: RunRef;
  readonly agent: Agent<TOutput>;
}): AgentInstructionBindingProjection {
  assertAgentInstructionBindingMatches(input);
  const binding = snapshotAgentInstructionBinding(input.binding);
  const agent = snapshotAgent(input.agent);
  return deepFreeze({
    ref: binding.ref,
    agent: binding.agent,
    instructions: binding.instructions,
    release: agent.instructions.release,
    model: binding.model,
    resolverRevision: agent.instructions.resolverRevision,
    contentDigest: agent.instructions.contentDigest,
    blockCount: agent.instructions.blocks.length,
    effectiveFromRunRevision: binding.effectiveFromRunRevision,
    supersedes: binding.supersedes,
  });
}

function snapshotRunRef(input: RunRef): RunRef {
  strictRecord(input, "AgentInstructionBinding.run", ["id"]);
  return Object.freeze({ id: token(input.id, "AgentInstructionBinding.run.id") });
}

function snapshotAgentRef(input: AgentRevisionRef): AgentRevisionRef {
  strictRecord(input, "AgentInstructionBinding.agent", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "AgentInstructionBinding.agent.id"),
    revision: token(input.revision, "AgentInstructionBinding.agent.revision"),
  });
}

function snapshotInstructionsRef(input: AgentInstructionsRef): AgentInstructionsRef {
  strictRecord(input, "AgentInstructionBinding.instructions", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "AgentInstructionBinding.instructions.id"),
    revision: digest(input.revision, "AgentInstructionBinding.instructions.revision"),
  });
}

function snapshotModelRef(input: AgentInstructionModelRef): AgentInstructionModelRef {
  strictRecord(input, "AgentInstructionBinding.model", ["providerId", "modelId"]);
  return Object.freeze({
    providerId: token(input.providerId, "AgentInstructionBinding.model.providerId"),
    modelId: token(input.modelId, "AgentInstructionBinding.model.modelId"),
  });
}

function strictRecord(
  input: unknown,
  field: string,
  keys: readonly string[],
): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${field} must be an object.`);
  }
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} must contain exactly: ${keys.join(", ")}.`);
  }
}

function token(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    throw new TypeError(`${field} must be a non-empty token.`);
  }
  return input;
}

function digest(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input)) {
    throw new TypeError(`${field} must be a canonical SHA-256 reference.`);
  }
  return input;
}

function nonNegativeInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return input as number;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
