import {
  DefaultVerificationExecutionFactory,
  type VerificationExecutionFactory,
  type VerificationGeneratedRecordKind,
} from "@agent-anything/verification/execution";

export function createTestVerificationExecutionFactory(input: {
  readonly now: () => string;
  readonly createId?: (kind: VerificationGeneratedRecordKind) => string;
}): VerificationExecutionFactory {
  if (typeof input.now !== "function") {
    throw new TypeError("Test Verification execution requires a clock.");
  }
  let sequence = 0;
  return new DefaultVerificationExecutionFactory({
    clock: { now: input.now },
    identities: {
      nextId: (kind) => input.createId?.(kind) ?? `${kind}-${++sequence}`,
    },
    subjectAdapters: { resolve: () => null },
    subjectFreshness: { resolve: () => null },
    pureChecks: { resolve: () => null },
    operationChecks: { resolve: () => null },
    interpreters: { resolve: () => null },
    assessmentMethods: { resolve: () => null },
  });
}
