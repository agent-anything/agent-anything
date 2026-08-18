import {
  DefaultValidationExecutionFactory,
  type ValidationExecutionFactory,
  type ValidationGeneratedRecordKind,
} from "@agent-anything/validation/execution";

export function createTestValidationExecutionFactory(input: {
  readonly now: () => string;
  readonly createId?: (kind: ValidationGeneratedRecordKind) => string;
}): ValidationExecutionFactory {
  if (typeof input.now !== "function") {
    throw new TypeError("Test Validation execution requires a clock.");
  }
  let sequence = 0;
  return new DefaultValidationExecutionFactory({
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
