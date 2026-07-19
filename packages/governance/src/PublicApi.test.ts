import { describe, expect, it } from "vitest";
import * as amendment from "./amendment/index.js";
import * as api from "./index.js";
import * as identity from "./identity/index.js";
import * as managedPermission from "./managed-permission/index.js";
import * as policy from "./policy/index.js";
import * as workspace from "./workspace/index.js";

describe("Governance public API", () => {
  it("exposes the reviewed focused and aggregate value surfaces", () => {
    expect(Object.keys(policy).sort()).toEqual([
      "createAllowAllActionPolicyPort",
      "evaluateExecPolicyRules",
      "evaluateNetworkPolicyRules",
      "snapshotExecPolicyRule",
      "snapshotNetworkPolicyRule",
    ]);
    expect(Object.keys(workspace).sort()).toEqual(["createDefaultWorkspaceResolver"]);
    expect(Object.keys(identity).sort()).toEqual(["createAnonymousIdentityProvider"]);
    expect(Object.keys(managedPermission)).toEqual([]);
    expect(Object.keys(amendment).sort()).toEqual(["normalizePolicyAmendment"]);
    expect(Object.keys(api).sort()).toEqual([
      ...new Set([
        ...Object.keys(policy),
        ...Object.keys(workspace),
        ...Object.keys(identity),
        ...Object.keys(amendment),
      ]),
    ].sort());
  });
});
