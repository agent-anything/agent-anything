import { describe, expect, it } from "vitest";
import { createAnonymousIdentityProvider } from "./IdentityProvider.js";
import type { IdentityProvider, ResolveIdentityInput } from "./IdentityProvider.js";
import type { IdentityRef } from "./IdentityRef.js";

describe("IdentityProvider", () => {
  it("resolves anonymous identity by default", async () => {
    const provider = createAnonymousIdentityProvider();

    await expect(provider.resolve({
      taskId: "task_001",
      metadata: {},
    })).resolves.toMatchObject({
      id: "anonymous",
      kind: "anonymous",
      displayName: "Anonymous",
    });
  });

  it("records fake identity provider inputs", async () => {
    const provider = new FakeIdentityProvider({
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    });

    await provider.resolve({
      taskId: "task_001",
      metadata: {},
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      taskId: "task_001",
    });
  });

  it("can simulate identity provider failure", async () => {
    const provider = new FakeIdentityProvider(() => {
      throw new Error("Identity unavailable.");
    });

    await expect(provider.resolve({
      taskId: "task_001",
      metadata: {},
    })).rejects.toThrow("Identity unavailable.");
  });
});

class FakeIdentityProvider implements IdentityProvider {
  readonly requests: ResolveIdentityInput[] = [];

  constructor(
    private readonly result:
      | IdentityRef
      | ((input: ResolveIdentityInput) => IdentityRef | Promise<IdentityRef>),
  ) {}

  async resolve(input: ResolveIdentityInput): Promise<IdentityRef> {
    this.requests.push(input);

    if (typeof this.result === "function") {
      return await this.result(input);
    }

    return this.result;
  }
}
