import type {
  IdentityProvider,
  ResolveIdentityInput,
} from "@agent-anything/governance/identity";
import type { IdentityRef } from "@agent-anything/foundation";

export type FakeIdentityProviderHandler = (
  input: ResolveIdentityInput,
) => IdentityRef | Promise<IdentityRef>;

export class FakeIdentityProvider implements IdentityProvider {
  readonly requests: ResolveIdentityInput[] = [];

  constructor(
    private readonly handlerOrIdentity: FakeIdentityProviderHandler | IdentityRef,
  ) {}

  async resolve(input: ResolveIdentityInput): Promise<IdentityRef> {
    this.requests.push(input);

    if (typeof this.handlerOrIdentity === "function") {
      return this.handlerOrIdentity(input);
    }

    return this.handlerOrIdentity;
  }
}
