import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, PermissionPromptPanel } from "./App.js";

describe("Helarc workbench shell", () => {
  it("renders the primary workbench surfaces", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Helarc");
    expect(html).toContain("No workspace selected");
    expect(html).toContain("No active session");
    expect(html).toContain("No pending review");
    expect(html).toContain("Workbench");
    expect(html).toContain("History");
    expect(html).toContain("Settings");
    expect(html).toContain("Templates");
  });

  it("renders permission prompt decision actions", () => {
    const html = renderToStaticMarkup(
      <PermissionPromptPanel
        prompt={{
          requestId: "permission-1",
          taskId: "task-1",
          toolName: "codeAgent.runCommand",
          reason: "Create a governed marker file.",
          command: "node",
          args: ["-e", "..."],
          cwd: ".",
          rootName: "workspace",
        }}
        isBusy={false}
        onCancel={() => undefined}
        onResolve={() => undefined}
      />,
    );

    expect(html).toContain("codeAgent.runCommand");
    expect(html).toContain("Create a governed marker file.");
    expect(html).toContain("node -e ...");
    expect(html).toContain("Cancel");
    expect(html).toContain("Deny");
    expect(html).toContain("Approve");
  });
});
