import { describe, expect, it } from "vitest";
import { allowsActionApproval } from "./evaluateApprovalPolicy.js";

describe("Approval Policy", () => {
  it("controls Product-neutral remote Tool review with remoteToolCalls", () => {
    const input = {
      category: "remoteToolCall" as const,
      cause: "missing_authority" as const,
    };

    expect(allowsActionApproval({
      ...input,
      policy: { granular: granularPolicy(true) },
    })).toBe(true);
    expect(allowsActionApproval({
      ...input,
      policy: { granular: granularPolicy(false) },
    })).toBe(false);
  });
});

function granularPolicy(remoteToolCalls: boolean) {
  return {
    sandboxApproval: false,
    rules: false,
    remoteToolCalls,
    requestPermissions: false,
    skillApproval: false,
  };
}
