export interface ActionExecutionFailure {
  readonly owner: "action_execution" | "governance" | "permission" | "sandbox" | "executor" | string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function createActionExecutionFailure(
  input: ActionExecutionFailure,
): ActionExecutionFailure {
  return Object.freeze({
    owner: input.owner,
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    metadata: Object.freeze({ ...input.metadata }),
  });
}
