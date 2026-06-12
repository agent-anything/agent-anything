import type {
  IdentityProvider,
  IdentityRef,
  ResolveIdentityInput,
} from "../identity/index.js";

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
