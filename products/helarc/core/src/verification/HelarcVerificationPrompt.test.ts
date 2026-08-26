import type { ControllerInput } from "@agent-anything/agent-runtime/controller";
import type { ContextProjection } from "@agent-anything/context/projection";
import { describe, expect, it } from "vitest";
import { buildHelarcVerificationText } from "./HelarcVerificationPrompt.js";

describe("Helarc Verification prompt rendering", () => {
  it("renders admitted paths against exact current Tool Exposure without granting authority", () => {
    const unavailable = parseRendered(buildHelarcVerificationText(input(["Read"])));
    const available = parseRendered(buildHelarcVerificationText(input(["PowerShell", "Read"])));

    expect(unavailable.operationalPaths).toEqual([
      {
        family: "command_backed",
        definition: { id: "helarc-command-check", revision: "1" },
        kind: "tool",
        toolName: "PowerShell",
        availability: "not_exposed",
      },
      {
        family: "exact_target_state",
        definition: { id: "helarc-exact-target-state", revision: "1" },
        kind: "automatic",
        toolName: null,
        availability: "automatic",
      },
    ]);
    expect(available.operationalPaths[0]).toMatchObject({ availability: "available" });
    expect(JSON.stringify(available)).not.toContain("approved");
    expect(JSON.stringify(available)).not.toContain("permission");
  });
});

function input(toolNames: readonly string[]): Parameters<typeof buildHelarcVerificationText>[0] {
  return {
    context: contextProjection(),
    verification: {
      snapshot: { runId: "run-1", revision: 7 },
      gate: { id: "gate-1", revision: "1" },
    },
    toolExposure: {
      catalog: { tools: toolNames.map((name) => ({ name })) },
    } as unknown as ControllerInput["toolExposure"],
  };
}

function contextProjection(): ContextProjection {
  return {
    id: "projection-1",
    requestId: "request-1",
    activeContext: { id: "context-1", runId: "run-1", version: 2 },
    estimator: { id: "utf8", revision: "1", unit: "bytes", accuracy: "exact" },
    blocks: [{
      id: "block-1",
      item: { id: "item-1" },
      contribution: { id: "verification-context-run-1", revision: "ledger-7" },
      instructionRole: "data",
      payload: {
        kind: "structured",
        value: {
          kind: "verification_feedback",
          snapshot: { runId: "run-1", revision: 7 },
          requirements: [{
            requirement: { id: "requirement-1", revision: "1" },
            state: "violated",
            admittedChecks: [
              { family: "command_backed", definition: { id: "helarc-command-check", revision: "1" } },
              { family: "exact_target_state", definition: { id: "helarc-exact-target-state", revision: "1" } },
            ],
          }],
          gate: null,
        },
      },
      accounting: { unit: "bytes", amount: 1 },
      transformation: null,
    }],
    accounting: { unit: "bytes", amount: 1 },
    manifestId: "manifest-1",
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

function parseRendered(text: string): {
  readonly operationalPaths: readonly Readonly<Record<string, unknown>>[];
} {
  return JSON.parse(text.slice("Current verification:\n".length)) as {
    readonly operationalPaths: readonly Readonly<Record<string, unknown>>[];
  };
}
