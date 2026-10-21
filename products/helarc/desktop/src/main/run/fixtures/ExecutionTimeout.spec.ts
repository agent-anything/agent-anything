import {it, expect, beforeAll, afterAll, onTestFinished} from "vitest";
import {join} from "node:path";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {appendFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {createStaticHostIdentityResolver, createStaticHostWorkspaceResolver} from "@agent-anything/host/context";
import {createFakeProviderContext} from "@agent-anything/test-support";
import {createHelarcTask} from "@agent-anything/helarc/task";
import {createHelarcProviderProfile} from "@agent-anything/helarc/configuration";
import type {Provider} from "@agent-anything/model-interaction";
import {prepareHelarcHostRun} from "../HelarcHostRunComposition.js";
import {ExecutionFixtureScope} from "./ExecutionFixtureScope.js";
import {closeExecutionScope} from "./ManagedExecutionTest.js";
import {openExecutionStoreFixture} from "../../execution-storage/fixtures/ExecutionEnvironmentFixture.js";

// Explicit spec, excluded from the normal *.test.ts suite: intentional failure.
const directory = process.env.HELARC_TIMEOUT_FIXTURE_DIRECTORY!;
if (!directory) throw new Error("An isolated fixture directory is required");
const stalled = process.env.HELARC_TIMEOUT_FIXTURE_STALLED === "1";
const nextOnly = process.env.HELARC_TIMEOUT_FIXTURE_NEXT_ONLY === "1";
const heartbeat = join(directory, "heartbeat.txt");
const worker = pathToFileURL(join(process.cwd(), "dist/main/execution-storage/ExecutionStoreWorker.js"));
const scope = new ExecutionFixtureScope();
let ready!: () => void;
const entered = new Promise<void>(resolve => {ready = resolve;});
let body: Promise<void>;

async function executeFixture(): Promise<void> {
  const workspaceRoot = join(directory, "workspace"); await mkdir(workspaceRoot);
  const store = await scope.open(() => openExecutionStoreFixture(join(directory, "execution"), worker));
  const context = createFakeProviderContext("timeout-fixture", "fixture-model");
  let calls = 0;
  const provider: Provider = {
    ...context,
    descriptor: {id: "timeout-fixture", name: "Timeout fixture", metadata: {}, requestRetryScheduler: {kind: "harness"}, capabilities: {
      nativeToolInteraction: {supported: true, callableDefinitions: true, modelCalls: true, resultMessages: true, multipleCalls: true, callCorrelation: "provider_supplied"},
      structuredGeneration: {supported: true}, streaming: {supported: false}, continuation: {supported: false}, compaction: {supported: false},
      modelContext: {capacity: context.modelContext.capacity, requestedOutput: context.modelContext.requestedOutput, inputPreservation: context.modelContext.inputPreservation},
      usageMetering: {inputTokens: "unavailable", outputTokens: "unavailable", costUnits: "unavailable"},
    }},
    async send(_request, interruption) {
      calls++;
      await writeFile(join(directory, "provider-entered.json"), JSON.stringify({calls}));
      ready();
      if (!interruption.signal.aborted) await new Promise<void>(resolve => interruption.signal.addEventListener("abort", () => resolve(), {once: true}));
      if (interruption.interruption?.kind !== "run_cancellation") throw new Error("Expected fixture cancellation");
      return {kind: "cancelled", cancellation: interruption.interruption.cancellation};
    },
  };
  const task = createHelarcTask({taskId: "timeout-task", prompt: "Wait for fixture cancellation.", createdAt: "2026-10-19T00:00:00.000Z"});
  const profile = createHelarcProviderProfile({id: "timeout-profile", providerKind: "openai-compatible", displayName: "Fixture", baseUrl: "https://fixture.invalid/v1",
    model: "fixture-model", timeoutMs: 30000, credentialStatus: "empty_allowed", qualificationPolicy: "allow_experimental", isActive: true});
  if (!task.ok || !profile.ok) throw new Error("Invalid timeout fixture input");
  const prepared = await scope.prepare(() => prepareHelarcHostRun({
    provider, executionStore: store,
    task: task.task,
    sessionId: "timeout-session", productRunId: "timeout-product-run", inputItems: [], permissionPreset: "full_access",
    providerProfile: profile.profile,
    commandOutputDirectory: join(directory, "output"),
    workspaceResolver: createStaticHostWorkspaceResolver({primary: {id: "workspace", name: "workspace", rootRef: workspaceRoot, trustState: "trusted", source: "test", policyRefs: [], metadata: {}}, additional: []}),
    workspaceSelection: {kind: "references", primaryRef: "workspace", additionalRefs: []},
    identityResolver: createStaticHostIdentityResolver({id: "fixture-user", kind: "anonymous", displayName: "Fixture", metadata: {}}), identitySelection: {kind: "anonymous"},
  }));
  await writeFile(join(directory, "started.json"), JSON.stringify({rootRunId: prepared.rootRunId, generation: store.generation, processId: process.pid}));
  const timer = setInterval(() => appendFileSync(heartbeat, "x"), 20);
  try {
    const result = await prepared.start().result;
    if (stalled) await new Promise(() => {});
    expect(result.runResult.status).toBe("cancelled");
    await writeFile(join(directory, "cancelled.json"), JSON.stringify({status: result.runResult.status, calls}));
  } finally {clearInterval(timer);}
}

beforeAll(async () => {
  if (nextOnly) return;
  body = scope.run(executeFixture);
  await Promise.race([entered, body.then(() => {throw new Error("Fixture ended before Provider entry");})]);
}, 30_000);
afterAll(() => closeExecutionScope(scope), 0);

it("times out with a real Run and SQLite Worker", async () => {
  onTestFinished(() => closeExecutionScope(scope), 0);
  await body;
}, 50);

it("starts the next test only after the old Run and Worker have stopped", async () => {
  const before = await readFile(heartbeat, "utf8");
  const seed = JSON.parse(await readFile(join(directory, "started.json"), "utf8"));
  const store = await openExecutionStoreFixture(join(directory, "execution"), worker);
  try {
    expect(store.generation).toBeGreaterThan(seed.generation);
    const tree = await store.readRunTree(seed.rootRunId);
    const status = tree?.members[0]?.head.state.status;
    // Killing a process cannot promise that its cancellation settlement committed.
    if (stalled) expect(["cancelling", "cancelled"]).toContain(status);
    else expect(status).toBe("cancelled");
    const revision = tree!.commit.revision;
    await new Promise(resolve => setTimeout(resolve, 400));
    expect((await store.readRunTree(seed.rootRunId))?.commit.revision).toBe(revision);
    expect(await readFile(heartbeat, "utf8")).toBe(before);
    expect(JSON.parse(await readFile(join(directory, "provider-entered.json"), "utf8")).calls).toBe(1);
    await writeFile(join(directory, "following.json"), JSON.stringify({revision, status, quiescent: true, reopened: true}));
  } finally {await store.close();}
});
