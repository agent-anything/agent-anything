import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  createHelarcProductEffectivenessSuite,
  HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
  HELARC_PRODUCT_EFFECTIVENESS_SUITE_REVISION,
} from "./HelarcProductEffectivenessSuite.js";

const execFileAsync = promisify(execFile);

describe("Helarc Product-effectiveness Suite", () => {
  it("fixes six weighted Evaluation-only Case families and three repetitions", () => {
    const profile = createHelarcProductEffectivenessSuite();

    expect(profile.revision).toBe(HELARC_PRODUCT_EFFECTIVENESS_SUITE_REVISION);
    expect(profile.cases.map((item) => item.id)).toEqual([
      "bounded-background-work",
      "clarification",
      "constrained-repair",
      "failed-command-recovery",
      "multi-file-change",
      "repository-investigation",
    ]);
    expect(profile.cases.reduce((total, item) => total + item.weight, 0)).toBeCloseTo(1);
    expect(profile.suite.selectionRules).toMatchObject({
      kind: "all",
      repetitions: HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
    });
    expect(profile.cases.every((item) =>
      item.expectedClaims.length > 0 && item.fixtureFiles.length > 0)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("keeps executable expectations in Evaluation data rather than Product behavior", () => {
    const profile = createHelarcProductEffectivenessSuite();

    expect(profile.cases.find((item) => item.id === "clarification")).toMatchObject({
      interactionAnswers: { greeting: "hello-evaluation" },
    });
    expect(profile.cases.find((item) => item.id === "bounded-background-work")
      ?.expectedClaims.map((item) => item.kind)).toContain("no_live_process");
    expect(profile.suite.metadata).toMatchObject({ productionWorkflowData: false });
  });

  it("keeps supplied checks executable after the declared minimal corrections", async () => {
    const profile = createHelarcProductEffectivenessSuite();
    const correctedFiles: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      "constrained-repair": {
        "src/clamp.mjs": "export function clamp(value, min, max) {\n  if (value < min) return min;\n  if (value > max) return max;\n  return value;\n}\n",
      },
      "multi-file-change": {
        "src/math.mjs": "export const add = (left, right) => left + right;\nexport const isEven = (value) => value % 2 === 0;\n",
        "src/index.mjs": "export { add, isEven } from './math.mjs';\n",
      },
      "failed-command-recovery": {
        "src/value.mjs": "export const value = 3;\n",
      },
    };

    for (const [caseId, corrections] of Object.entries(correctedFiles)) {
      const caseProfile = profile.cases.find((item) => item.id === caseId)!;
      const checkPath = caseProfile.expectedClaims.find((item) =>
        item.kind === "command_succeeds"
      )!.target!;
      const root = await mkdtemp(join(tmpdir(), "agent-anything-suite-check-"));
      try {
        for (const file of caseProfile.fixtureFiles) {
          const target = join(root, ...file.path.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, corrections[file.path] ?? file.content, "utf8");
        }
        await expect(execFileAsync(process.execPath, [join(root, ...checkPath.split("/"))], {
          cwd: root,
          windowsHide: true,
        })).resolves.toBeDefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
