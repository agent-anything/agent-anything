import type {
  ContextObservation,
  ContextProjection,
  ContextProjectionLimits,
  ContextProjectorInput,
  ContextProjectorPort,
} from "@agent-anything/context/context";

const TEST_CONTEXT_PROJECTION_LIMITS: ContextProjectionLimits = Object.freeze({
  maxMessages: 1_000,
  maxMessageLength: 1_000_000,
  maxObservations: 1_000,
  maxObservationBytes: 1_000_000,
  maxEvidenceRefs: 1_000,
  maxMetadataEntries: 1_000,
});

export function createTestIdentityContextProjector<
  TObservation extends ContextObservation = ContextObservation,
>(): ContextProjectorPort<TObservation, TObservation> {
  return Object.freeze({
    project: ({
      context,
    }: ContextProjectorInput<TObservation>): ContextProjection<TObservation> =>
      Object.freeze({
        messages: Object.freeze([...context.messages]),
        observations: Object.freeze([...context.observations]),
        evidenceRefs: Object.freeze([...context.evidenceRefs]),
        metadata: Object.freeze({ ...context.metadata }),
      }),
  });
}

export function createTestContextProjection<
  TObservation extends ContextObservation = ContextObservation,
>() {
  return Object.freeze({
    projector: createTestIdentityContextProjector<TObservation>(),
    purpose: "workflow" as const,
    limits: TEST_CONTEXT_PROJECTION_LIMITS,
  });
}
