import { describe, expect, it } from "vitest";
import * as api from "./index.js";
import * as approval from "./approval/index.js";
import * as authority from "./authority/index.js";
import * as profile from "./profile/index.js";

describe("Permission public API", () => {
  it("exposes the reviewed focused and aggregate value surfaces", () => {
    expect(Object.keys(profile).sort()).toEqual([
      "BUILT_IN_PERMISSION_PROFILE_IDS",
      "PermissionProfileResolutionError",
      "canonicalizePermissionAbsolutePath",
      "canonicalizePermissionDomain",
      "canonicalizePermissionDomains",
      "canonicalizePermissionFileSystemTarget",
      "canonicalizePermissionPathFromCwd",
      "matchesPermissionDomainPattern",
      "matchesPermissionFileSystemTarget",
      "projectControllerPermissionProfile",
      "projectPermissionProfile",
      "resolvePermissionProfile",
      "resolvePermissionWorkspaceRoots",
    ]);
    expect(Object.keys(approval).sort()).toEqual([
      "ApprovalContractError",
      "allowsActionApproval",
      "canonicalizeAdditionalPermissions",
      "createApprovalRequest",
      "projectApprovalReviewRequest",
      "snapshotApprovalDecisionSubmission",
      "snapshotApprovalInterruption",
      "snapshotApprovalPayload",
      "snapshotApprovalReviewContext",
      "snapshotApprovalReviewFailure",
      "snapshotApprovalReviewInput",
      "snapshotApprovalReviewerDescriptor",
      "validateApprovalDecision",
      "validateGrantedPermissions",
    ]);
    expect(Object.keys(authority).sort()).toEqual([
      "createActionApprovalCoverage",
      "isActionApprovalCoverageApplicable",
      "isSessionAuthorityApplicable",
      "validateSessionAuthorityRecord",
    ]);
    expect(Object.keys(api).sort()).toEqual([
      ...new Set([
        ...Object.keys(profile),
        ...Object.keys(approval),
        ...Object.keys(authority),
      ]),
    ].sort());
  });
});
