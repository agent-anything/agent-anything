import { describe, expect, it } from "vitest";
import { createHelarcCommandStateSection, type HelarcCommandStateSnapshot } from "./HelarcCommandState.js";

function snapshot(id = "process-1"): HelarcCommandStateSnapshot {
  return { ref: {runId: "run-1", executionId: id}, revision: 1, phase: "running",
    startedAt: "2026-09-30T00:00:00Z", finishedAt: null, deadlineAt: "2026-09-30T00:00:30Z",
    outcome: null, rootExit: null, termination: null, containment: {disposition: "active", confirmedAt: null},
    output: {capture: "open", persistence: "pending", retainedBytes: 0, omittedBytes: 0} };
}

describe("Helarc command state model input", () => {
  it("keeps immutable attributed data separate from historical Tool Results and instructions", () => {
    const current = snapshot();
    const before = createHelarcCommandStateSection("run-1", [current])!;
    const settled = {...current, revision: 9, phase: "settled", outcome: "timed_out",
      rootExit: {code: 0, signal: null, observedAt: "2026-09-30T00:00:05Z"},
      termination: {reason: "execution_timeout", requestedAt: "2026-09-30T00:00:30Z", method: "forced"}};
    const after = createHelarcCommandStateSection("run-1", [settled])!;
    expect(before).toMatchObject({role: "user", kind: "run_material", necessity: "mandatory"});
    expect(JSON.stringify(before)).not.toContain("timed_out");
    expect(JSON.stringify(after)).toContain("timed_out");
    expect(after.source.revision).not.toBe(before.source.revision);
    expect(createHelarcCommandStateSection("run-1", [settled])).toEqual(after);
    expect(Object.isFrozen(after.content)).toBe(true);
    expect(JSON.stringify(createHelarcCommandStateSection("run-1", [{...current, environment: "secret"} as typeof current])))
      .not.toContain("secret");
  });

  it("prioritizes unsettled executions and declares bounded retained-only coverage", () => {
    const section = createHelarcCommandStateSection("run-1", [
      ...Array.from({length: 35}, (_, i) => ({...snapshot(`old-${i}`), phase: "settled"})), snapshot("active"),
    ])!;
    if (section.content.kind !== "text") throw new Error("Expected text");
    const value = JSON.parse(section.content.text.slice(section.content.text.indexOf("\n") + 1));
    expect(value).toMatchObject({coverage: "retained_executions_only", omittedExecutions: 4});
    expect(value.executions).toHaveLength(32);
    expect(value.executions[0].task_id).toBe("active");
    expect(createHelarcCommandStateSection("run-1", [])).toBeNull();
    expect(() => createHelarcCommandStateSection("other-run", [snapshot()])).toThrow("requested Run");
  });
});
