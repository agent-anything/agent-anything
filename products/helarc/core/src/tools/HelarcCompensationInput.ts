import type { ToolJsonObject } from "@agent-anything/tools/catalog";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import { snapshotExecutionEvidenceRef, type ExecutionEvidenceRef } from "@agent-anything/operation-catalog/evidence";

export const HELARC_COMPENSATION_INPUT_REVISION = "compensation-v1";
export const HELARC_COMPENSATION_GUIDANCE = "Optional declared intent to address earlier execution or effects. Copy exact references from Tool results. It records intent, not proof of successful reversal, and does not grant permission or bypass normal execution checks. Omit it for ordinary work.";
export const HELARC_COMPENSATION_FIELD_GUIDANCE = Object.freeze({
  "/properties/compensation_of": HELARC_COMPENSATION_GUIDANCE,
  "/properties/compensation_of/properties/targets": "One to 64 distinct exact execution or effect references previously delivered to this Run. All targets must resolve before execution.",
  "/properties/compensation_of/properties/explanation": "Optional explanation of the intended relationship, at most 4096 characters. This is model-authored intent, not verified outcome evidence.",
  "/properties/compensation_of/properties/targets/items/properties/owner": "Copy the reference's exact owner; do not substitute a Tool name.",
  "/properties/compensation_of/properties/targets/items/properties/kind": "Copy execution or effect from the reference. A material or support reference is not a compensation target.",
  "/properties/compensation_of/properties/targets/items/properties/id": "Copy the exact reference identity; paths, PIDs and guessed identities are not execution references.",
  "/properties/compensation_of/properties/targets/items/properties/revision": "Copy the exact immutable reference revision.",
});

export function withHelarcCompensationInput(input: ToolRegistrationInput): ToolRegistrationInput {
  const descriptor = input.descriptor;
  const schema = descriptor.inputSchema;
  if (schema.type !== "object" || !record(schema.properties) || Object.hasOwn(schema.properties, "compensation_of")) {
    throw new TypeError("Compensation input requires an object schema without a compensation_of field.");
  }
  return {...input, descriptor: {...descriptor,
    ref: {...descriptor.ref, revision: `${descriptor.ref.revision}.${HELARC_COMPENSATION_INPUT_REVISION}`},
    inputSchema: {...schema, properties: {...schema.properties, compensation_of: compensationSchema()}},
    schemaRevisions: {...descriptor.schemaRevisions, input: `${descriptor.schemaRevisions.input}.${HELARC_COMPENSATION_INPUT_REVISION}`},
    metadata: {...descriptor.metadata, compensationInputRevision: HELARC_COMPENSATION_INPUT_REVISION,
      domainInputRevision: descriptor.schemaRevisions.input},
  }};
}

export function withoutHelarcCompensationInput(input: unknown): unknown {
  if (!record(input) || !Object.hasOwn(input, "compensation_of")) return input;
  const {compensation_of: _association, ...domain} = input;
  return domain;
}

export function readHelarcCompensationInput(input: unknown): {
  readonly targets: readonly ExecutionEvidenceRef<"execution" | "effect">[];
  readonly explanation: string | null;
} | null {
  if (!record(input) || !Object.hasOwn(input, "compensation_of")) return null;
  const value = input.compensation_of;
  if (!record(value) || Object.keys(value).some(key => key !== "targets" && key !== "explanation") ||
      !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 64 ||
      (value.explanation !== undefined && (typeof value.explanation !== "string" || value.explanation.length > 4096))) {
    throw new TypeError("compensation_of requires 1 to 64 exact execution/effect targets and an optional explanation of at most 4096 characters.");
  }
  const targets = Array.from(value.targets, target => {
    const ref = snapshotExecutionEvidenceRef(target);
    if (ref.kind !== "execution" && ref.kind !== "effect") throw new TypeError("Compensation targets must be execution or effect references.");
    return ref as ExecutionEvidenceRef<"execution" | "effect">;
  });
  if (new Set(targets.map(ref => JSON.stringify(ref))).size !== targets.length) throw new TypeError("Compensation targets must not repeat.");
  return {targets, explanation: value.explanation as string | undefined ?? null};
}

function compensationSchema(): ToolJsonObject {
  return {type: "object", additionalProperties: false, required: ["targets"], description: HELARC_COMPENSATION_GUIDANCE,
    properties: {
      targets: {type: "array", minItems: 1, maxItems: 64, items: {type: "object", additionalProperties: false,
        required: ["owner", "kind", "id", "revision"], properties: {
          owner: {type: "string", minLength: 1, maxLength: 256}, kind: {enum: ["execution", "effect"]},
          id: {type: "string", minLength: 1, maxLength: 1024}, revision: {type: "string", minLength: 1, maxLength: 256},
        }}},
      explanation: {type: "string", maxLength: 4096},
    }};
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
