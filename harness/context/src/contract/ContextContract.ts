export type ContextJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ContextJsonValue[]
  | ContextJsonObject;

export interface ContextJsonObject {
  readonly [key: string]: ContextJsonValue;
}

export type ContextContractFailureCode =
  | "context_contract_invalid"
  | "context_payload_too_large"
  | "context_disclosure_invalid"
  | "context_transition_invalid"
  | "context_projection_contract_invalid";

export interface ContextContractFailure {
  readonly code: ContextContractFailureCode;
  readonly message: string;
  readonly path: string;
}

export class ContextContractError extends TypeError {
  readonly failure: ContextContractFailure;

  constructor(failure: ContextContractFailure) {
    super(failure.message);
    this.name = "ContextContractError";
    this.failure = Object.freeze({ ...failure });
  }
}
