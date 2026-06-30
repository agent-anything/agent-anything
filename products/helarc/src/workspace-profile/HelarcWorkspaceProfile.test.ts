import { describe, expect, it } from "vitest";
import {
  createHelarcWorkspaceProfile,
  selectHelarcWorkspaceProfile,
} from "./HelarcWorkspaceProfile.js";

describe("HelarcWorkspaceProfile", () => {
  it("creates a trusted workspace profile", () => {
    const result = createHelarcWorkspaceProfile({
      id: " workspace-a ",
      displayName: " Agent Anything ",
      path: " D:\\projects\\agent-anything ",
      lastOpenedAt: "2026-06-30T07:00:00.000Z",
      trustState: "trusted",
    });

    expect(result).toEqual({
      ok: true,
      profile: {
        id: "workspace-a",
        displayName: "Agent Anything",
        path: "D:\\projects\\agent-anything",
        lastOpenedAt: "2026-06-30T07:00:00.000Z",
        trustState: "trusted",
      },
    });
  });

  it("rejects incomplete workspace profile metadata", () => {
    expect(createHelarcWorkspaceProfile({
      id: "",
      displayName: "Workspace",
      path: "D:\\projects\\agent-anything",
      lastOpenedAt: "2026-06-30T07:00:00.000Z",
      trustState: "trusted",
    })).toMatchObject({
      ok: false,
      error: { code: "workspace_profile_id_required" },
    });

    expect(createHelarcWorkspaceProfile({
      id: "workspace-a",
      displayName: "Workspace",
      path: "",
      lastOpenedAt: "2026-06-30T07:00:00.000Z",
      trustState: "trusted",
    })).toMatchObject({
      ok: false,
      error: { code: "workspace_profile_path_required" },
    });
  });

  it("rejects invalid timestamps and trust states", () => {
    expect(createHelarcWorkspaceProfile({
      id: "workspace-a",
      displayName: "Workspace",
      path: "D:\\projects\\agent-anything",
      lastOpenedAt: "not-a-date",
      trustState: "trusted",
    })).toMatchObject({
      ok: false,
      error: { code: "workspace_profile_last_opened_at_invalid" },
    });

    expect(createHelarcWorkspaceProfile({
      id: "workspace-a",
      displayName: "Workspace",
      path: "D:\\projects\\agent-anything",
      lastOpenedAt: "2026-06-30T07:00:00.000Z",
      trustState: "untrusted" as "trusted",
    })).toMatchObject({
      ok: false,
      error: { code: "workspace_profile_trust_state_invalid" },
    });
  });

  it("selects workspace profiles by id", () => {
    const result = selectHelarcWorkspaceProfile([
      profile("workspace-a"),
      profile("workspace-b"),
    ], " workspace-b ");

    expect(result).toMatchObject({
      ok: true,
      profile: { id: "workspace-b" },
    });

    expect(selectHelarcWorkspaceProfile([], "missing")).toMatchObject({
      ok: false,
      error: { code: "workspace_profile_not_found" },
    });
  });
});

function profile(id: string) {
  const result = createHelarcWorkspaceProfile({
    id,
    displayName: id,
    path: `D:\\projects\\${id}`,
    lastOpenedAt: "2026-06-30T07:00:00.000Z",
    trustState: "trusted",
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.profile;
}
