import type { Evidence, EvidenceSensitivity } from "./Evidence.js";
import type { EvidenceContribution } from "./EvidenceSource.js";

export type ConservativeEvidenceSensitivity = Exclude<
  EvidenceSensitivity,
  "public"
>;

export interface EvidenceSensitivityPolicy {
  readonly unclassifiedSensitivity: ConservativeEvidenceSensitivity;
}

export interface BuildEvidenceInput {
  readonly contribution: EvidenceContribution;
  readonly id?: string;
  readonly sensitivity?: EvidenceSensitivity;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EvidenceBuilderPort {
  build(input: BuildEvidenceInput): readonly Evidence[];
}

export class EvidenceBuilder implements EvidenceBuilderPort {
  readonly #sensitivityPolicy: EvidenceSensitivityPolicy;

  constructor(
    sensitivityPolicy: EvidenceSensitivityPolicy = {
      unclassifiedSensitivity: "restricted",
    },
  ) {
    if (!isConservativeSensitivity(sensitivityPolicy?.unclassifiedSensitivity)) {
      throw new TypeError(
        "EvidenceSensitivityPolicy requires a conservative unclassified sensitivity.",
      );
    }
    this.#sensitivityPolicy = Object.freeze({
      unclassifiedSensitivity: sensitivityPolicy.unclassifiedSensitivity,
    });
  }

  build(input: BuildEvidenceInput): readonly Evidence[] {
    const contribution = snapshotEvidenceContribution(input.contribution);
    const sensitivity = input.sensitivity === undefined
      ? this.#sensitivityPolicy.unclassifiedSensitivity
      : requireSensitivity(input.sensitivity);
    return Object.freeze([
      Object.freeze({
        id: input.id ?? createEvidenceId(contribution),
        source: contribution.source,
        summary: contribution.summary,
        content: contribution.content,
        sensitivity,
        metadata: Object.freeze({
          ...input.metadata,
          contributionUsability: contribution.usability,
          settlementRefs: contribution.settlementRefs,
        }),
      }),
    ]);
  }
}

export function snapshotEvidenceContribution<TContent>(
  input: EvidenceContribution<TContent>,
): EvidenceContribution<TContent> {
  if (input === null || typeof input !== "object") {
    throw new TypeError("EvidenceContribution must be an object.");
  }
  if (input.usability !== "complete" && input.usability !== "partial_validated") {
    throw new TypeError("EvidenceContribution.usability is invalid.");
  }
  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    throw new TypeError("EvidenceContribution.summary must be non-empty text.");
  }
  if (input.content === undefined) {
    throw new TypeError("EvidenceContribution.content must be present.");
  }
  if (!Array.isArray(input.settlementRefs) || input.settlementRefs.length === 0) {
    throw new TypeError("EvidenceContribution requires at least one settlement reference.");
  }
  const source = snapshotReference(input.source, "EvidenceContribution.source");
  const settlementRefs = input.settlementRefs.map((reference, index) =>
    snapshotReference(reference, `EvidenceContribution.settlementRefs[${index}]`)
  ) as [EvidenceContribution["settlementRefs"][number], ...EvidenceContribution["settlementRefs"][number][]];
  if (!isRecord(input.metadata)) {
    throw new TypeError("EvidenceContribution.metadata must be a record.");
  }
  return deepFreeze({
    source,
    settlementRefs,
    usability: input.usability,
    summary: input.summary,
    content: input.content,
    metadata: { ...input.metadata },
  }) as EvidenceContribution<TContent>;
}

function createEvidenceId(contribution: EvidenceContribution): string {
  return `evidence_${encodeIdentity(contribution.source.owner)}_${encodeIdentity(contribution.source.kind)}_${encodeIdentity(contribution.source.id)}`;
}

function encodeIdentity(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function snapshotReference<T extends {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}>(input: T, field: string): T {
  if (!isRecord(input)) throw new TypeError(`${field} must be an object.`);
  token(input.owner, `${field}.owner`);
  token(input.kind, `${field}.kind`);
  token(input.id, `${field}.id`);
  if (input.revision !== null) token(input.revision, `${field}.revision`);
  if ("metadata" in input && !isRecord(input.metadata)) {
    throw new TypeError(`${field}.metadata must be a record.`);
  }
  return deepFreeze({
    ...input,
    ...(input.revision === null ? { revision: null } : {}),
    ...("metadata" in input ? { metadata: { ...(input.metadata as object) } } : {}),
  }) as T;
}

function token(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
}

function requireSensitivity(value: EvidenceSensitivity): EvidenceSensitivity {
  if (!isEvidenceSensitivity(value)) {
    throw new TypeError("BuildEvidenceInput.sensitivity is invalid.");
  }
  return value;
}

function isEvidenceSensitivity(value: unknown): value is EvidenceSensitivity {
  return value === "public" || value === "private" || value === "secret" || value === "restricted";
}

function isConservativeSensitivity(
  value: unknown,
): value is ConservativeEvidenceSensitivity {
  return value === "private" || value === "secret" || value === "restricted";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
