import type {
  PermissionDecision,
  PermissionRequestInput,
  PermissionService,
} from "@agent-anything/permission";

export type FakePermissionServiceHandler = (
  input: PermissionRequestInput,
) => PermissionDecision | Promise<PermissionDecision>;

export class FakePermissionService implements PermissionService {
  readonly requests: PermissionRequestInput[] = [];

  constructor(
    private readonly handler: FakePermissionServiceHandler = grantPermission,
  ) {}

  async request(input: PermissionRequestInput): Promise<PermissionDecision> {
    this.requests.push(input);
    return this.handler(input);
  }
}

function grantPermission(input: PermissionRequestInput): PermissionDecision {
  return {
    requestId: input.id,
    status: "granted",
    reason: "Granted by fake permission service.",
    decidedAt: "2026-06-12T00:00:00.000Z",
  };
}
