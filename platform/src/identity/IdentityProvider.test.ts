import { describe, expect, it } from "vitest";
import { FakeIdentityProvider } from "../testing/index.js";
import { createAnonymousIdentityProvider } from "./IdentityProvider.js";

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
