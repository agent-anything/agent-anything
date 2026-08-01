import type {
  ResolveWorkspaceInput,
  WorkspaceResolver,
} from "@agent-anything/governance/workspace";
import type { WorkspaceContext } from "@agent-anything/foundation";

export type FakeWorkspaceResolverHandler = (
  input: ResolveWorkspaceInput,
) => WorkspaceContext | Promise<WorkspaceContext>;

export class FakeWorkspaceResolver implements WorkspaceResolver {
  readonly requests: ResolveWorkspaceInput[] = [];

  constructor(
    private readonly handlerOrContext: FakeWorkspaceResolverHandler | WorkspaceContext,
  ) {}

  async resolve(input: ResolveWorkspaceInput): Promise<WorkspaceContext> {
    this.requests.push(input);

    if (typeof this.handlerOrContext === "function") {
      return this.handlerOrContext(input);
    }

    return this.handlerOrContext;
  }
}
