import { describe, expect, it } from "vitest";
import {
  HELARC_BASELINE_TOOL_CONTRACTS,
  type HelarcBaselineToolName,
} from "../HelarcBaselineToolContracts.js";
import {
  annotateHelarcToolInputSchema,
  collectHelarcToolInputFieldPointers,
} from "./HelarcToolGuidanceSchema.js";
import { createHelarcBaselineToolGuidanceSource } from "./HelarcBaselineToolGuidance.js";

describe("Helarc baseline Tool Guidance", () => {
  it("completely describes every baseline Tool and every accepted input field", () => {
    expect(HELARC_BASELINE_TOOL_CONTRACTS).toHaveLength(11);
    for (const contract of HELARC_BASELINE_TOOL_CONTRACTS) {
      const source = guidanceSource(contract.name);
      expect(source.modelDescription.length).toBeGreaterThan(180);
      expect(Object.keys(source.inputFieldDescriptions).sort()).toEqual(
        collectHelarcToolInputFieldPointers(contract.inputSchema),
      );
      const annotated = annotateHelarcToolInputSchema({
        schema: contract.inputSchema,
        fieldDescriptions: source.inputFieldDescriptions,
      });
      expect(annotated.canonicalShapeDigest).not.toBe(annotated.annotatedShapeDigest);
      expect(JSON.stringify(annotated.schema)).toContain("description");
    }
  });

  it("keeps Bash and PowerShell complete and independently revisioned", () => {
    const bash = guidanceSource("Bash");
    const powershell = guidanceSource("PowerShell");

    expect(bash.tool).not.toEqual(powershell.tool);
    expect(bash.modelDescription).toContain("Bash");
    expect(powershell.modelDescription).toContain("PowerShell");
    expect(Object.keys(bash.inputFieldDescriptions))
      .toEqual(Object.keys(powershell.inputFieldDescriptions));
    expect(bash.ref.revision).not.toBe(powershell.ref.revision);
  });

  it("specializes PowerShell guidance for the selected executable dialect", () => {
    const windowsPowerShell = createHelarcBaselineToolGuidanceSource(
      "PowerShell",
      toolRef("PowerShell"),
      {
        toolName: "PowerShell",
        executable: "powershell",
        dialect: "windows-powershell",
      },
    );
    const powerShell7 = createHelarcBaselineToolGuidanceSource(
      "PowerShell",
      toolRef("PowerShell"),
      {
        toolName: "PowerShell",
        executable: "pwsh",
        dialect: "powershell-7",
      },
    );

    expect(windowsPowerShell.modelDescription).toContain("Windows PowerShell `powershell`");
    expect(windowsPowerShell.modelDescription).toContain("Do not use `&&` or `||`");
    expect(windowsPowerShell.modelDescription).toContain("Do not substitute `;`");
    expect(powerShell7.modelDescription).toContain("PowerShell 7 syntax");
    expect(powerShell7.modelDescription).toContain("operators `&&` and `||` are supported");
    expect(windowsPowerShell.ref.revision).not.toBe(powerShell7.ref.revision);
  });

  it("describes self-contained delegation and opaque continuation identity", () => {
    const agent = guidanceSource("Agent");
    const sendMessage = guidanceSource("SendMessage");

    expect(agent.modelDescription).toContain("self-contained objective");
    expect(agent.modelDescription).toContain("agent_id");
    expect(agent.inputFieldDescriptions["/properties/prompt"])
      .toContain("Self-contained delegated objective");
    expect(sendMessage.inputFieldDescriptions["/properties/agent_id"])
      .toContain("Opaque continuation identity");
  });

  it("rejects a Shell runtime profile attached to another Tool", () => {
    expect(() => createHelarcBaselineToolGuidanceSource(
      "Read",
      toolRef("Read"),
      { toolName: "Bash", executable: "bash", dialect: "bash" },
    )).toThrow("Helarc Shell runtime cannot describe a different Tool.");
  });
});

function guidanceSource(name: HelarcBaselineToolName) {
  return createHelarcBaselineToolGuidanceSource(name, toolRef(name), shellRuntime(name));
}

function toolRef(name: HelarcBaselineToolName) {
  return Object.freeze({
    tool: Object.freeze({ namespace: "helarc.test", name: name.toLowerCase() }),
    revision: "1",
  });
}

function shellRuntime(name: HelarcBaselineToolName) {
  if (name === "Bash") {
    return { toolName: "Bash" as const, executable: "bash" as const, dialect: "bash" as const };
  }
  if (name === "PowerShell") {
    return {
      toolName: "PowerShell" as const,
      executable: "powershell" as const,
      dialect: "windows-powershell" as const,
    };
  }
  return null;
}
