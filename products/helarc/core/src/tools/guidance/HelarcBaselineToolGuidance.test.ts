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
import {commandInputSchema, type HelarcCommandInputContract} from "../HelarcCommandInputContract.js";
import {HELARC_COMPENSATION_GUIDANCE, withHelarcCompensationInput} from "../HelarcCompensationInput.js";
import type {ToolRegistrationInput} from "@agent-anything/tools/registration";

describe("Helarc baseline Tool Guidance", () => {
  it.each(["Bash", "PowerShell"] as const)("assembles %s constraints and extension guidance once", name => {
    const schema = commandInputSchema({constraints: {timeout: {minimumMs: 1, maximumMs: 98765, defaultMs: 4567},
      wait: {minimumPositiveMs: 25, maximumMs: 8765, defaultForegroundMs: 3210, backgroundMs: 0},
      command: {maximumUtf8Bytes: 12345}, description: {maximumUtf16CodeUnits: 567}, capacity: {maximumActive: 3}}} as HelarcCommandInputContract);
    const registration = withHelarcCompensationInput({descriptor: {ref: toolRef(name), inputSchema: schema,
      schemaRevisions: {input: "1"}}} as ToolRegistrationInput);
    const source = createHelarcBaselineToolGuidanceSource(name, registration.descriptor.ref, shellRuntime(name), registration.descriptor.inputSchema);
    expect(source.inputFieldDescriptions["/properties/compensation_of"]).toBe(HELARC_COMPENSATION_GUIDANCE);
    const annotated = annotateHelarcToolInputSchema({schema: registration.descriptor.inputSchema, fieldDescriptions: source.inputFieldDescriptions});
    for (const field of ["wait_ms", "timeout_ms", "run_in_background"]) {
      expect(source.inputFieldDescriptions[`/properties/${field}`]).toBe((schema.properties as any)[field].description);
    }
    expect(source.inputFieldDescriptions["/properties/wait_ms"]).toContain("3210");
    expect(source.inputFieldDescriptions["/properties/command"]).toContain("12345");
    expect(JSON.stringify(source)).not.toContain("10000");
    expect(annotated.canonicalShapeDigest).not.toBe(annotated.annotatedShapeDigest);
  });
  it("completely describes every baseline Tool and every accepted input field", () => {
    expect(HELARC_BASELINE_TOOL_CONTRACTS).toHaveLength(16);
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

  it("states search coverage and pagination before a call without optional instructions", () => {
    const output = guidanceSource("ContextMaterialSearch");
    expect(output.modelDescription).toContain("multiple internal chunks");
    expect(output.modelDescription).toContain("at most 16 matches");
    expect(output.modelDescription).toContain("execution budget");
    expect(output.modelDescription).toContain("do not prove absence");
    expect(output.inputFieldDescriptions["/properties/references"]).toContain("explicit scope");
    expect(guidanceSource("CommandObserve").modelDescription).toContain("without starting, stopping or reading its output");
  });

  it("keeps clarification answers separate from permission and execution limits", () => {
    const question = guidanceSource("AskUserQuestion");
    expect(question.modelDescription).toContain("clarification only");
    expect(question.modelDescription).toContain("answers do not grant permission or change execution limits");
    expect(question.inputFieldDescriptions["/properties/questions"]).toContain("clarification questions");
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
