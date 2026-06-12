import {
  FakeProvider,
  InMemoryStorage,
  type ProviderResponse,
} from "@agent-anything/platform";
import { describe, expect, it } from "vitest";
import { createNetDoctorTask } from "../../input/index.js";
import { createNetDoctorAgentRuntime } from "../runtime/index.js";
import { createDefaultNetDoctorRuntimeConfig } from "./createDefaultNetDoctorRuntimeConfig.js";
import { resolveNetDoctorRuntimeConfig } from "./resolveNetDoctorRuntimeConfig.js";

describe("resolveNetDoctorRuntimeConfig", () => {
  it("uses defaults when no overrides are provided", () => {
    const config = resolveNetDoctorRuntimeConfig();

    expect(config).toEqual(createDefaultNetDoctorRuntimeConfig());
  });

  it("applies valid overrides", () => {
    const config = resolveNetDoctorRuntimeConfig({
      providerId: "openai",
      model: "gpt-test",
      providerTimeoutMs: 45000,
      maxIterations: 8,
      maxToolCalls: 6,
      maxDurationMs: 60000,
      maxConsecutiveFailures: 2,
      permissionMode: "deny",
      metadata: {
        source: "test",
      },
      providerMetadata: {
        region: "local",
      },
    });

    expect(config).toMatchObject({
      providerId: "openai",
      model: "gpt-test",
      providerTimeoutMs: 45000,
      limits: {
        maxIterations: 8,
        maxToolCalls: 6,
        maxDurationMs: 60000,
        maxConsecutiveFailures: 2,
      },
      permissionMode: "deny",
      metadata: {
        product: "net-doctor",
        runtime: "phase2-agent",
        source: "test",
      },
      providerMetadata: {
        region: "local",
      },
    });
  });

  it("rejects invalid provider settings", () => {
    expect(() => resolveNetDoctorRuntimeConfig({
      providerId: " ",
    })).toThrow("providerId must not be empty.");

    expect(() => resolveNetDoctorRuntimeConfig({
      model: "",
    })).toThrow("model must not be empty.");

    expect(() => resolveNetDoctorRuntimeConfig({
      providerTimeoutMs: 0,
    })).toThrow("providerTimeoutMs must be greater than 0.");
  });

  it("rejects invalid runtime limits", () => {
    expect(() => resolveNetDoctorRuntimeConfig({
      maxIterations: -1,
    })).toThrow("maxIterations must be greater than or equal to 0.");

    expect(() => resolveNetDoctorRuntimeConfig({
      maxToolCalls: -1,
    })).toThrow("maxToolCalls must be greater than or equal to 0.");
  });

  it("passes resolved config into NetDoctor runtime metadata and limits", async () => {
    const config = resolveNetDoctorRuntimeConfig({
      providerId: "fake-provider",
      model: "fake-model",
      providerTimeoutMs: 12345,
      maxIterations: 1,
      metadata: {
        host: "test-host",
      },
    });
    const runtime = createNetDoctorAgentRuntime({
      provider: new FakeProvider({
        responses: [
          createProviderResponse({
            kind: "final",
            finalOutput: {
              conclusion: "Done.",
            },
          }),
        ],
      }),
      storage: new InMemoryStorage(),
      config,
    });

    const result = await runtime.run(createNetDoctorTask({
      target: "example.com",
      taskId: "task_config",
      createdAt: "2026-06-09T00:00:00.000Z",
    }));

    expect(result).toMatchObject({
      status: "succeeded",
      metadata: {
        providerId: "fake-provider",
        model: "fake-model",
        providerTimeoutMs: 12345,
        host: "test-host",
      },
    });
  });
});

function createProviderResponse(output: unknown): ProviderResponse {
  return {
    status: "succeeded",
    output,
    usage: null,
    error: null,
    metadata: {},
  };
}
