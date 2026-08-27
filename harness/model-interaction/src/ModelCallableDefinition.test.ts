import { describe, expect, it } from "vitest";
import { snapshotModelCallableDefinitions } from "./ModelCallableDefinition.js";

describe("ModelCallableDefinition", () => {
  it("uses locale-independent code-unit order for deterministic catalogs", () => {
    const schema = Object.freeze({ type: "object" });

    const definitions = snapshotModelCallableDefinitions([
      { name: "update_plan", description: "Update the plan.", inputSchema: schema },
      { name: "Write_1234", description: "Write a file.", inputSchema: schema },
      { name: "Read_1234", description: "Read a file.", inputSchema: schema },
      { name: "stop", description: "Stop the run.", inputSchema: schema },
    ]);

    expect(definitions.map(({ name }) => name)).toEqual([
      "Read_1234",
      "Write_1234",
      "stop",
      "update_plan",
    ]);
  });
});
