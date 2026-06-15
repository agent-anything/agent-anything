import type {
  PolicyCheckInput,
  PolicyDecision,
  PolicyPort,
} from "@agent-anything/governance";

export type FakePolicyPortHandler = (
  input: PolicyCheckInput,
) => PolicyDecision | Promise<PolicyDecision>;

export class FakePolicyPort implements PolicyPort {
  readonly checks: PolicyCheckInput[] = [];

  constructor(
    private readonly handler: FakePolicyPortHandler = allowPolicy,
  ) {}

  async evaluate(input: PolicyCheckInput): Promise<PolicyDecision> {
    this.checks.push(input);
    return this.handler(input);
  }
}

function allowPolicy(input: PolicyCheckInput): PolicyDecision {
  return {
    checkId: input.id,
    status: "allowed",
    decidedAt: "2026-06-12T00:00:00.000Z",
  };
}
