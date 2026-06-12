import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTask, Evidence, Report, RuntimeResult } from "@agent-anything/platform";
import type { NetDoctorInput } from "../input/index.js";
import { LocalNetDoctorStorage } from "./LocalNetDoctorStorage.js";

describe("LocalNetDoctorStorage", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores task, evidence, report, runtime result, and task history", async () => {
    const root = await createTempDir();
    const storage = new LocalNetDoctorStorage(root, "task_001");

    await storage.storeTask(createTask());
    const evidenceArtifact = await storage.storeEvidence(createEvidence());
    const reportArtifact = await storage.storeReport(createReport());
    await storage.storeRuntimeResult(createRuntimeResult({
      output: {
        conclusion: "Storage test completed.",
      },
      evidenceRefs: ["evidence_001"],
      artifactRefs: [evidenceArtifact.id, reportArtifact.id],
    }));

    expect(await expectJson(join(root, "tasks", "task_001", "task.json"))).toMatchObject({
      id: "task_001",
    });
    expect(
      await expectJson(join(root, "tasks", "task_001", "evidence", "evidence_001.json")),
    ).toMatchObject({
      id: "evidence_001",
    });
    expect(await expectJson(join(root, "tasks", "task_001", "evidence.json"))).toMatchObject([
      {
        id: "evidence_001",
      },
    ]);
    expect(await expectJson(join(root, "tasks", "task_001", "report.json"))).toMatchObject({
      id: "report_001",
    });
    expect(
      await expectJson(join(root, "tasks", "task_001", "runtime-result.json")),
    ).toMatchObject({
      status: "succeeded",
    });
    expect(await expectJson(join(root, "tasks", "task-history.json"))).toMatchObject([
      {
        taskId: "task_001",
        target: "example.com",
        status: "succeeded",
        output: {
          conclusion: "Storage test completed.",
        },
        evidenceRefs: ["evidence_001"],
        artifactRefs: [evidenceArtifact.id, reportArtifact.id],
      },
    ]);
  });

  it("returns stored evidence for report rendering", async () => {
    const root = await createTempDir();
    const storage = new LocalNetDoctorStorage(root, "task_001");
    const evidence = createEvidence();

    await storage.storeEvidence(evidence);

    expect(storage.getEvidence("evidence_001")).toEqual(evidence);
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "net-doctor-storage-"));
    tempDirs.push(dir);
    return dir;
  }
});

async function expectJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function createTask(): AgentTask<NetDoctorInput & { toolCalls: unknown[] }> {
  return {
    id: "task_001",
    kind: "net-doctor.diagnose",
    input: {
      target: {
        raw: "example.com",
        host: "example.com",
        port: null,
        protocol: null,
        normalized: "example.com",
      },
      symptom: "Cannot connect",
      toolCalls: [],
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    metadata: {
      product: "net-doctor",
    },
  };
}

function createEvidence(): Evidence {
  return {
    id: "evidence_001",
    source: {
      kind: "toolResult",
      toolCallId: "tool_call_001",
      toolName: "netDoctor.dnsLookup",
      metadata: {
        taskId: "task_001",
      },
    },
    summary: "example.com resolved to 1 address.",
    content: {
      host: "example.com",
      addresses: [{ address: "93.184.216.34", family: 4 }],
    },
    sensitivity: "public",
    metadata: {
      evidenceKind: "dnsLookup",
    },
  };
}

function createReport(): Report {
  return {
    id: "report_001",
    taskId: "task_001",
    title: "Report for net-doctor.diagnose",
    sections: [],
    evidenceRefs: ["evidence_001"],
    createdAt: "2026-06-06T00:00:01.000Z",
    metadata: {
      generator: "test",
    },
  };
}

function createRuntimeResult(
  overrides: Partial<RuntimeResult> = {},
): RuntimeResult {
  return {
    taskId: "task_001",
    status: "succeeded",
    output: null,
    outputSpec: {
      format: "json",
      metadata: {},
    },
    evidenceRefs: [],
    artifactRefs: [],
    errors: [],
    metadata: {},
    ...overrides,
  };
}
