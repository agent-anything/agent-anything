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
});

function guidanceSource(name: HelarcBaselineToolName) {
  return createHelarcBaselineToolGuidanceSource(name, Object.freeze({
    tool: Object.freeze({ namespace: "helarc.test", name: name.toLowerCase() }),
    revision: "1",
  }));
}
