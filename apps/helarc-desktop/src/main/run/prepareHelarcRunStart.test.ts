import { createBuiltInHelarcTaskTemplates } from "@agent-anything/helarc";
import { describe, expect, it } from "vitest";
import { prepareHelarcRunStart } from "./prepareHelarcRunStart.js";

describe("prepareHelarcRunStart", () => {
  it("prepares manual task text into run and platform task contracts", () => {
    const result = prepareHelarcRunStart({
      ...input(),
      taskText: " Inspect workspace ",
    });

    expect(result).toMatchObject({
      ok: true,
      prepared: {
        run: {
          runId: "run-1",
          taskText: "Inspect workspace",
          workspaceProfileId: "workspace-1",
          providerProfileId: "provider-1",
          taskTemplateId: null,
          permissionPreset: "ask",
        },
        task: {
          id: "task-1",
          input: {
            prompt: "Inspect workspace",
          },
          workspaceScope: {
            defaultRootName: "workspace",
          },
          metadata: {
            runId: "run-1",
            providerProfileId: "provider-1",
            taskTemplateId: null,
          },
        },
        workspace: {
          profileId: "workspace-1",
          displayName: "agent-anything",
          path: "D:\\projects\\agent-anything",
        },
        provider: {
          profileId: "provider-1",
          providerKind: "openai-compatible",
          displayName: "Provider A",
          endpointLabel: "provider.local",
          model: "model-a",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("authorization");
  });

  it("derives task text from a selected template when manual text is empty", () => {
    const result = prepareHelarcRunStart({
      ...input(),
      taskText: " ",
      taskTemplateId: "inspect-code",
      taskTemplates: createBuiltInHelarcTaskTemplates(),
    });

    expect(result).toMatchObject({
      ok: true,
      prepared: {
        run: {
          taskTemplateId: "inspect-code",
        },
        task: {
          input: {
            prompt: expect.stringContaining("Inspect the relevant code"),
          },
        },
      },
    });
    if (result.ok) {
      expect(result.prepared.run.taskText).toBe(result.prepared.task.input.prompt);
      expect(result.prepared.run.taskText).toContain("Constraints:");
    }
  });

  it("keeps edited task text while preserving the selected template id", () => {
    const result = prepareHelarcRunStart({
      ...input(),
      taskText: "Inspect only the README.",
      taskTemplateId: "inspect-code",
      taskTemplates: createBuiltInHelarcTaskTemplates(),
    });

    expect(result).toMatchObject({
      ok: true,
      prepared: {
        run: {
          taskText: "Inspect only the README.",
          taskTemplateId: "inspect-code",
        },
        task: {
          input: {
            prompt: "Inspect only the README.",
          },
        },
      },
    });
  });

  it("rejects stale workspace, provider, and template references", () => {
    expect(prepareHelarcRunStart({
      ...input(),
      workspaceProfileId: "missing-workspace",
    })).toMatchObject({
      ok: false,
      error: { code: "workspace_profile_not_found" },
    });

    expect(prepareHelarcRunStart({
      ...input(),
      providerProfileId: "missing-provider",
    })).toMatchObject({
      ok: false,
      error: { code: "provider_profile_not_found" },
    });

    expect(prepareHelarcRunStart({
      ...input(),
      taskText: "Inspect workspace.",
      taskTemplateId: "missing-template",
      taskTemplates: createBuiltInHelarcTaskTemplates(),
    })).toMatchObject({
      ok: false,
      error: { code: "task_template_not_found" },
    });
  });

  it("rejects empty task text when no template can provide it", () => {
    expect(prepareHelarcRunStart({
      ...input(),
      taskText: " ",
    })).toMatchObject({
      ok: false,
      error: { code: "run_task_text_required" },
    });
  });
});

function input() {
  return {
    runId: "run-1",
    taskId: "task-1",
    taskText: "Inspect workspace",
    workspaceProfileId: "workspace-1",
    providerProfileId: "provider-1",
    workspaceProfiles: [
      {
        id: "workspace-1",
        displayName: "agent-anything",
        path: "D:\\projects\\agent-anything",
        lastOpenedAt: "2026-07-04T00:00:00.000Z",
        trustState: "trusted" as const,
      },
    ],
    providerProfiles: [
      {
        id: "provider-1",
        providerKind: "openai-compatible" as const,
        displayName: "Provider A",
        endpointLabel: "provider.local",
        baseUrl: "https://provider.local/v1",
        baseUrlOrigin: "https://provider.local",
        model: "model-a",
        timeoutMs: 1000,
        credentialStatus: "present" as const,
        isActive: true,
      },
    ],
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}
