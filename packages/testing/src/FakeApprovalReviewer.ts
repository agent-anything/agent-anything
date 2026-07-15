import {
  snapshotApprovalReviewerDescriptor,
  snapshotApprovalReviewInput,
  type ApprovalReviewerDescriptor,
  type ApprovalReviewerPort,
  type ApprovalReviewInput,
  type ApprovalReviewOutcome,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext } from "@agent-anything/shared";

export type FakeApprovalReviewerHandler = (
  input: ApprovalReviewInput,
  context: InvocationInterruptionContext,
) => ApprovalReviewOutcome | Promise<ApprovalReviewOutcome>;

export interface FakeApprovalReviewerInput {
  readonly descriptor: ApprovalReviewerDescriptor & {
    readonly kind: "auto_review";
  };
  readonly handler: FakeApprovalReviewerHandler;
}

export class FakeApprovalReviewer implements ApprovalReviewerPort {
  readonly descriptor: ApprovalReviewerDescriptor & {
    readonly kind: "auto_review";
  };
  private readonly handler: FakeApprovalReviewerHandler;

  constructor(input: FakeApprovalReviewerInput) {
    if (typeof input.handler !== "function") {
      throw new TypeError("FakeApprovalReviewer requires a handler.");
    }
    this.descriptor = snapshotApprovalReviewerDescriptor(
      input.descriptor,
      "auto_review",
    ) as ApprovalReviewerDescriptor & { readonly kind: "auto_review" };
    this.handler = input.handler;
  }

  review(
    input: ApprovalReviewInput,
    context: InvocationInterruptionContext,
  ): Promise<ApprovalReviewOutcome> {
    return Promise.resolve(this.handler(snapshotApprovalReviewInput(input), context));
  }
}
