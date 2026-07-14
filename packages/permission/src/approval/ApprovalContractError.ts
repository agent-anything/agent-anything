export type ApprovalContractErrorCode =
  | "approval_request_invalid_identity"
  | "approval_request_invalid_subject"
  | "approval_request_invalid_payload"
  | "approval_request_invalid_option"
  | "approval_request_duplicate_option"
  | "approval_request_invalid_proposal"
  | "approval_request_duplicate_proposal"
  | "approval_request_invalid_metadata";

export class ApprovalContractError extends Error {
  readonly code: ApprovalContractErrorCode;

  constructor(code: ApprovalContractErrorCode, message: string) {
    super(message);
    this.name = "ApprovalContractError";
    this.code = code;
  }
}
