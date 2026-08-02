import { describe, expect, it } from "vitest";
import { evaluateExecPolicyRules, evaluateNetworkPolicyRules } from "./ActionRule.js";

describe("Action Rule evaluation", () => {
  it("collapses matching rules with forbidden before prompt before allow", () => {
    const outcome = evaluateExecPolicyRules({
      command: ["/usr/bin/git", "status"],
      cwd: "/work",
      environmentId: "local",
      rules: [
        rule("allow", "allow"),
        rule("prompt", "prompt"),
        rule("deny", "forbidden"),
      ],
      amendments: [],
    });

    expect(outcome).toEqual({
      decision: "forbidden",
      matchedRuleIds: ["allow", "deny", "prompt"],
    });
  });

  it("matches network rules and persistent amendments by canonical target", () => {
    expect(evaluateNetworkPolicyRules({
      host: "api.example.com",
      port: 443,
      protocol: "https",
      environmentId: "local",
      rules: [{
        id: "network-prompt",
        hostPattern: "*.example.com",
        ports: [443],
        protocols: ["https"],
        decision: "prompt",
        source: "test",
        justification: null,
      }],
      amendments: [{
        amendmentId: "network-allow",
        environmentId: "local",
        hostPattern: "api.example.com",
        ports: [443],
        protocols: ["https"],
        effect: "allow",
        sourceFingerprint: "sha256:test",
      }],
    })).toEqual({
      decision: "prompt",
      matchedRuleIds: ["network-allow", "network-prompt"],
    });
  });
});

function rule(id: string, decision: "allow" | "prompt" | "forbidden") {
  return {
    id,
    commandPattern: ["/usr/bin/git"] as [string, ...string[]],
    cwd: "/work",
    decision,
    source: "test",
    justification: null,
  };
}
