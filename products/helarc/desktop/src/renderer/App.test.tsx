import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HelarcMainSnapshot } from "../shared/HelarcDesktopApi.js";
import { createHelarcRunTreeTestSnapshot } from "../shared/testing/HelarcRunTreeTestSnapshot.js";
import { App } from "./App.js";
import { SettingsPanel, SettingsPage } from "./SettingsPage.js";
import {
  ApprovalPromptPanel,
  ClarificationPromptPanel,
} from "./interactions/InteractionPanels.js";

describe("Helarc workbench shell", () => {
  it("renders the primary workbench surfaces", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Helarc");
    expect(html).toContain("Choose project");
    expect(html).toContain("No work yet");
    expect(html).not.toContain("Requests 0");
    expect(html).toContain("Conversation");
    expect(html).toContain("Projects");
    expect(html).toContain("Settings");
    expect(html).not.toContain("Templates");
  });

  it("renders the fresh local Ollama Provider defaults", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        snapshot={unconfiguredSnapshot()}
        onSaved={() => undefined}
      />,
    );

    expect(html).toContain(
      '<option value="ollama" selected="">Ollama</option>',
    );
    expect(html).toContain('value="Ollama Provider"');
    expect(html).toContain('value="http://localhost:11435"');
    expect(html).toContain('value="163840"');
    expect(html).toContain('value="gemma4:e4b"');
    expect(html).toContain('value="300000000"');
    expect(html).toContain(
      '<option value="allow_experimental" selected="">Allow experimental</option>',
    );
  });

  it("renders Settings as a standalone page with a close action", () => {
    const html = renderToStaticMarkup(
      <SettingsPage
        snapshot={unconfiguredSnapshot()}
        onSaved={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Close settings"');
    expect(html).toContain('aria-label="Provider settings"');
    expect(html).toContain('role="tab"');
    expect(html).not.toContain('class="workbench"');
    expect(html).not.toContain('class="task-composer"');
  });

  it("renders offered approval decision actions", () => {
    const html = renderToStaticMarkup(
      <ApprovalPromptPanel
        approval={pendingApproval("pending")}
        submissionError={null}
        isBusy={false}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Additional permissions");
    expect(html).toContain("Create a governed marker file.");
    expect(html).toContain("1 write target(s)");
    expect(html).toContain("Cancel");
    expect(html).toContain("Decline");
    expect(html).toContain("Grant for run");
  });

  it("disables approval controls after submission is accepted", () => {
    const html = renderToStaticMarkup(
      <ApprovalPromptPanel
        approval={pendingApproval("submitted_for_resolution")}
        submissionError={null}
        isBusy={false}
        onSubmit={() => undefined}
      />,
    );

    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("Submitted for resolution");
  });

  it("renders bounded clarification questions and answer controls", () => {
    const html = renderToStaticMarkup(
      <ClarificationPromptPanel
        clarification={{
          family: "clarification",
          runId: "harness-run-1",
          phase: "pending",
          request: {
            id: "clarification-1",
            protocol: { owner: "helarc", kind: "clarification", revision: "1" },
            requestVersion: 1,
            subject: {
              owner: "helarc",
              kind: "clarification_tool_call",
              id: "tool-call-1",
              revision: "1",
            },
          },
          disclosureClass: "internal",
          expiresAt: null,
          blockingScope: "run",
          presentation: {
            questions: [
              {
                id: "scope",
                prompt: "Which scope should be updated?",
                options: [
                  {
                    label: "Runtime",
                    description: "Update the runtime package.",
                  },
                  {
                    label: "Product",
                    description: "Update the product package.",
                  },
                ],
                allowMultiple: false,
              },
            ],
          },
        }}
        submissionError={null}
        isBusy={false}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Which scope should be updated?");
    expect(html).toContain("Runtime");
    expect(html).toContain("Product");
    expect(html).toContain("Update the runtime package.");
    expect(html).toContain("Submit");
  });
});

function pendingApproval(
  phase: "pending" | "submitted_for_resolution",
): NonNullable<Parameters<typeof ApprovalPromptPanel>[0]["approval"]> {
  return {
    family: "approval",
    runId: "harness-run-1",
    phase,
    request: {
      id: "approval-1",
      protocol: { owner: "permission", kind: "approval", revision: "1" },
      requestVersion: 1,
      subject: {
        owner: "permission",
        kind: "approval",
        id: "action-1",
        revision: "fingerprint-1",
      },
    },
    disclosureClass: "sensitive",
    expiresAt: "2026-07-05T01:01:00.000Z",
    blockingScope: "run",
    presentation: {
      id: "approval-1",
      runId: "run-1",
      category: "permissions",
      reason: "Create a governed marker file.",
      payload: {
        permissions: { fileSystem: { write: ["D:\\workspace\\marker.txt"] } },
      },
      decisionOptions: [
        {
          id: "grant-run",
          kind: "grantPermissions",
          label: "Grant for run",
          description: "Grant the requested permissions for this run.",
        },
        {
          id: "decline",
          kind: "decline",
          label: "Decline",
          description: null,
        },
        {
          id: "cancel",
          kind: "cancel",
          label: "Cancel",
          description: null,
        },
      ],
    },
  };
}

function unconfiguredSnapshot(): HelarcMainSnapshot {
  return {
    status: "idle",
    workspace: null,
    workspaceProfiles: [],
    projects: [],
    selectedProjectId: null,
    provider: {
      configured: false,
      nativeToolInteraction: { supported: false },
      activeProfile: null,
      profiles: [],
      error: {
        code: "provider_config_missing",
        message: "Provider configuration is incomplete.",
      },
    },
    acceptedTask: null,
    activeThread: null,
    threadSummaries: [],
    run: null,
    error: null,
  };
}
