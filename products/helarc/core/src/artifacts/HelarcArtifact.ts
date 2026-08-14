export type HelarcSafeValue =
  | null
  | boolean
  | number
  | string
  | readonly HelarcSafeValue[]
  | { readonly [key: string]: HelarcSafeValue };

export type HelarcArtifactKind =
  | "final-output"
  | "proposal-revision"
  | "applied-change"
  | "trace-projection"
  | "tool-output-summary"
  | "evidence-bundle"
  | "validation-report"
  | "evaluation-report"
  | "engineering-review"
  | "error-report";

export type HelarcArtifactProducerKind =
  | "agent"
  | "product"
  | "tool"
  | "operation"
  | "validation"
  | "evaluation"
  | "review"
  | "user";

export interface HelarcArtifactProducer {
  readonly kind: HelarcArtifactProducerKind;
  readonly owner: string;
  readonly refId: string;
}

export interface HelarcArtifactRecordRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export type HelarcArtifactContent =
  | {
      readonly kind: "inline";
      readonly mediaType: string;
      readonly value: HelarcSafeValue;
    }
  | {
      readonly kind: "reference";
      readonly mediaType: string;
      readonly uri: string;
      readonly digest: string | null;
    };

export type HelarcArtifactCompleteness = "complete" | "partial" | "unknown";
export type HelarcArtifactSensitivity = "public" | "private" | "secret" | "restricted";

export type HelarcArtifactFreshness =
  | {
      readonly status: "current";
      readonly observedAt: string;
      readonly sourceRevision: string | null;
    }
  | {
      readonly status: "stale";
      readonly observedAt: string;
      readonly sourceRevision: string | null;
      readonly reason: string;
    }
  | {
      readonly status: "unknown";
      readonly observedAt: string | null;
    };

export type HelarcArtifactIntegrity =
  | {
      readonly status: "verified";
      readonly algorithm: string;
      readonly digest: string;
    }
  | { readonly status: "unverified" }
  | { readonly status: "failed"; readonly reason: string };

export type HelarcArtifactLifecycle = "draft" | "final" | "superseded" | "withdrawn";
export type HelarcArtifactPersistence = "thread_record" | "external_reference";

export interface CreateHelarcArtifactInput {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly kind: HelarcArtifactKind;
  readonly title: string;
  readonly summary: string | null;
  readonly producer: HelarcArtifactProducer;
  readonly sourceRefs: readonly [HelarcArtifactRecordRef, ...HelarcArtifactRecordRef[]];
  readonly effectRefs: readonly HelarcArtifactRecordRef[];
  readonly content: HelarcArtifactContent;
  readonly completeness: HelarcArtifactCompleteness;
  readonly sensitivity: HelarcArtifactSensitivity;
  readonly freshness: HelarcArtifactFreshness;
  readonly integrity: HelarcArtifactIntegrity;
  readonly lifecycle: HelarcArtifactLifecycle;
  readonly persistence: HelarcArtifactPersistence;
  readonly limitations: readonly string[];
  readonly createdAt: string;
}

export interface HelarcArtifact extends CreateHelarcArtifactInput {}
