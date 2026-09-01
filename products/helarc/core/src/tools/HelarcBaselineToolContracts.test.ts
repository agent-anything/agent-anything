import { describe, expect, it } from "vitest";

import {
  createHelarcBaselineToolContracts,
  findHelarcBaselineToolContract,
  HELARC_BASELINE_TOOL_CONTRACTS,
} from "./HelarcBaselineToolContracts.js";

describe("Helarc baseline Tool Contracts", () => {
  it("exposes one fixed ten-Tool catalog with one Host-selected Shell", () => {
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
      "SendMessage",
    ]);
    expect(createHelarcBaselineToolContracts("Bash").map((item) => item.name)).toContain("Bash");
    expect(createHelarcBaselineToolContracts("Bash").map((item) => item.name)).not.toContain("PowerShell");
    expect(HELARC_BASELINE_TOOL_CONTRACTS).toHaveLength(11);
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
      target: "agent.child",
      canonicalEffect: null,
    });
    expect(findHelarcBaselineToolContract("Agent").inputSchema).toMatchObject({
      properties: {
        dependency_result: {
          required: ["kind", "id", "revision"],
          properties: { kind: { const: "delegation_result" } },
        },
        replaced_result: {
          required: ["kind", "id", "revision"],
          properties: { kind: { const: "delegation_result" } },
        },
      },
    });
    expect(findHelarcBaselineToolContract("Agent").outputSchema).toMatchObject({
      required: expect.arrayContaining(["result_ref", "child_run_id", "status"]),
      properties: {
        result_ref: {
          required: ["kind", "id", "revision"],
          properties: { kind: { const: "delegation_result" } },
        },
      },
    });
    expect(findHelarcBaselineToolContract("Agent").outputSchema)
      .not.toHaveProperty("properties.delegation_result_id");
    expect(findHelarcBaselineToolContract("SendMessage").binding).toEqual({
      kind: "descendant_message",
      target: "agent.child",
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
