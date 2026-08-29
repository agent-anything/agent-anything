import { describe, expect, it } from "vitest";

import {
  createHelarcBaselineToolContracts,
  findHelarcBaselineToolContract,
  HELARC_BASELINE_TOOL_CONTRACTS,
} from "./HelarcBaselineToolContracts.js";

describe("Helarc baseline Tool Contracts", () => {
  it("exposes one fixed nine-Tool catalog with one Host-selected Shell", () => {
    expect(createHelarcBaselineToolContracts("PowerShell").map((item) => item.name)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "PowerShell",
      "TaskStop",
      "AskUserQuestion",
      "Agent",
    ]);
    expect(createHelarcBaselineToolContracts("Bash").map((item) => item.name)).toContain("Bash");
    expect(createHelarcBaselineToolContracts("Bash").map((item) => item.name)).not.toContain("PowerShell");
    expect(HELARC_BASELINE_TOOL_CONTRACTS).toHaveLength(10);
  });

  it("freezes exact input fields and settlement families", () => {
    expect(findHelarcBaselineToolContract("Read").inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["file_path"],
    });
    expect(findHelarcBaselineToolContract("Edit").inputSchema).toMatchObject({
      required: ["file_path", "old_string", "new_string"],
    });
    expect(findHelarcBaselineToolContract("Write").binding).toEqual({
      kind: "operation",
      target: "helarc.file.write",
      canonicalEffect: "file_system.write",
    });
    expect(findHelarcBaselineToolContract("AskUserQuestion").binding).toEqual({
      kind: "interaction",
      target: "helarc.clarification",
      canonicalEffect: null,
    });
    expect(findHelarcBaselineToolContract("Agent").binding).toEqual({
      kind: "descendant_run",
      target: "agent.general-purpose",
      canonicalEffect: null,
    });
  });

  it("keeps background observation and termination on explicit Contracts", () => {
    expect(findHelarcBaselineToolContract("PowerShell").inputSchema).toMatchObject({
      required: ["command"],
      properties: {
        run_in_background: { type: "boolean" },
        verification_claim: { type: "string" },
      },
    });
    expect(findHelarcBaselineToolContract("TaskStop").binding).toMatchObject({
      canonicalEffect: "process.signal",
    });
    expect(findHelarcBaselineToolContract("Read").outputSchema).toHaveProperty(
      "properties.file_path",
    );
    expect(findHelarcBaselineToolContract("PowerShell").outputSchema).toHaveProperty(
      "oneOf.0.properties.stdout.properties.integrity.enum",
      ["exact", "inferred", "lossy", "unavailable"],
    );
  });
});
