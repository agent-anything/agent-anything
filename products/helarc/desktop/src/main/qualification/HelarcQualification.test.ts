import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "@agent-anything/provider-integrations/ollama";
import { OpenAICompatibleProvider } from "@agent-anything/provider-integrations/openai-compatible";
import type { FetchLike } from "@agent-anything/provider-integrations/http";
import { createDefaultHelarcInstructionSettings, createHelarcProviderProfile } from "@agent-anything/helarc/configuration";
import {
  createHelarcQualificationProfile, runHelarcQualificationTrial,
  qualificationDigest,
  type HelarcQualificationProfileInput,
} from "@agent-anything/helarc/qualification-execution";
import { createHelarcModelQualificationCatalog, type HelarcModelQualificationCatalog } from "@agent-anything/helarc/model-qualification";
import { admitHelarcModelUse } from "@agent-anything/helarc/composition";
import { HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS } from "@agent-anything/helarc-local-environment/filesystem";
import { HELARC_LOCAL_SHELL_ACTION_ADAPTER_ID, HELARC_LOCAL_TASK_STOP_ACTION_ADAPTER_ID } from "@agent-anything/helarc-local-environment/command";
import { HelarcQualificationService } from "./HelarcQualificationService.js";
import { HelarcQualificationStore } from "./HelarcQualificationStore.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("Settings qualification closure", { timeout: 30_000 }, () => {
  it("qualifies explicit non-thinking requests without extra instructions and rejects reuse after mode changes", async () => {
    const f = await fixture("pass", "openai-compatible", { type: "disabled" });
    const initial = await f.service.snapshot();
    const target = createHelarcQualificationProfile(f.configuration()).qualification.target;
    await f.service.start(initial.targetId!); await f.service.drain();
    const completed = (await f.service.snapshot()).campaigns[0]!;
    expect(completed.results.every(r => r.outcome === "qualified")).toBe(true);
    expect(f.calls).toHaveLength(39);
    expect(f.calls.every(b => b.thinking?.type === "disabled")).toBe(true);
    expect(f.calls.every(b => !b.messages.some(m => m.role === "system"))).toBe(true);
    expect(await f.service.publish(completed.id, initial.targetId!, true)).toEqual({ ok: true });
    f.setThinking(undefined);
    const changed = createHelarcQualificationProfile(f.configuration(), f.catalog()).qualification;
    expect(changed.target.generationConfigurationDigest).not.toBe(target.generationConfigurationDigest);
    expect(changed.target.id).not.toBe(target.id);
    expect(changed.disposition.status).toBe("blocked");
    expect((await f.service.publish(completed.id, changed.target.id, true)).ok).toBe(false);
    expect((await f.service.snapshot()).campaigns[0]!.currentTarget).toBe(false);
  });

  it.each(["ollama", "openai-compatible"] as const)("uses the real %s encoder/decoder, retains all Trials, publishes and reuses exact-target decisions after restart", async kind => {
    const f = await fixture("pass", kind);
    const initial = await f.service.snapshot();
    expect(initial.disposition).toBe("blocked");
    expect(f.calls).toHaveLength(0);
    expect(await f.service.start(initial.targetId!)).toEqual({ ok: true });
    expect((await f.service.start(initial.targetId!)).ok).toBe(false);
    await f.service.drain();
    const completed = (await f.service.snapshot()).campaigns[0]!;
    expect(completed.status).toBe("completed");
    expect(completed.completedTrials).toBe(21);
    expect(completed.results.map(r => r.outcome)).toEqual(Array(6).fill("qualified"));
    expect(f.calls).toHaveLength(39);
    expect(f.calls.every(b => !b.messages.some(m => m.role === "system"))).toBe(true);
    expect(f.calls.every(b => b.tools.length >= 12)).toBe(true);
    expect(f.catalog().decisions).toHaveLength(0);
    expect((await f.service.publish(completed.id, initial.targetId!, false)).ok).toBe(false);
    expect(await f.service.publish(completed.id, initial.targetId!, true)).toEqual({ ok: true });
    expect(f.catalog().decisions).toHaveLength(6);
    expect(() => admitHelarcModelUse(createHelarcQualificationProfile(f.configuration(), f.catalog()).qualification)).not.toThrow();
    expect(await f.service.publish(completed.id, initial.targetId!, true)).toEqual({ ok: true });
    expect(f.catalog().decisions).toHaveLength(6);
    const saved = await new HelarcQualificationStore(f.path).read();
    expect(JSON.stringify(saved)).not.toContain("test-secret-not-retained");
    expect(saved.decisions).toHaveLength(6);
    expect(saved.campaigns[0]!.trials.map(t => t.id).length).toBe(new Set(saved.campaigns[0]!.trials.map(t => t.id)).size);
    const evidence = await f.service.evidence(completed.id, completed.trials[0]!.id);
    expect(evidence.ok && evidence.text).toContain("observed_expected_behavior");
    const count = f.calls.length;
    await f.service.initialize();
    expect(f.calls).toHaveLength(count);
    expect((await f.service.snapshot()).disposition).toBe("qualified");
  });

  it("changes applicability after instruction edits and rejects stale start/publication", async () => {
    const f = await fixture();
    const initial = await f.service.snapshot();
    await f.service.start(initial.targetId!); await f.service.drain();
    const completed = (await f.service.snapshot()).campaigns[0]!;
    f.changeInstructions();
    expect((await f.service.start(initial.targetId!)).ok).toBe(false);
    expect((await f.service.publish(completed.id, initial.targetId!, true)).ok).toBe(false);
    expect((await f.service.snapshot()).campaigns[0]!.currentTarget).toBe(false);
    expect(f.catalog().decisions).toHaveLength(0);
  });

  it("does not confuse Provider failure or cancellation with a negative model decision", async () => {
    const f = await fixture("transport_failure");
    const initial = await f.service.snapshot();
    await f.service.start(initial.targetId!); await f.service.drain();
    const campaign = (await f.service.snapshot()).campaigns[0]!;
    expect(campaign.results.every(r => r.outcome === "inconclusive")).toBe(true);
    expect(await f.service.publish(campaign.id, initial.targetId!, true)).toMatchObject({ ok: false, error: expect.stringContaining("did not pass") });
    await expect(f.store.publish(campaign.id, initial.targetId!)).rejects.toThrow("qualification_not_passed");
    expect(f.catalog().decisions).toHaveLength(0);
    expect((await f.store.read()).campaigns[0]!.publishedAt).toBeNull();
    expect((await f.service.snapshot()).disposition).toBe("blocked");
    const blocked = await fixture("wait");
    await blocked.service.start((await blocked.service.snapshot()).targetId!);
    const active = (await blocked.service.snapshot()).activeCampaignId!;
    expect(blocked.service.cancel(active)).toEqual({ ok: true });
    await blocked.service.drain();
    const cancelled = (await blocked.service.snapshot()).campaigns[0]!;
    expect(cancelled.status).toBe("cancelled");
    expect((await blocked.service.publish(cancelled.id, initial.targetId!, true)).ok).toBe(false);
    expect(blocked.calls.length).toBeLessThanOrEqual(1);
  });

  it.each(["wrong_response", "partial_failure"] as const)("retains %s evidence but rejects publication without changing admission", async mode => {
    const f = await fixture(mode);
    const initial = await f.service.snapshot();
    await f.service.start(initial.targetId!); await f.service.drain();
    const campaign = (await f.service.snapshot()).campaigns[0]!;
    expect(campaign.results.filter(r => r.outcome === "not_qualified")).toHaveLength(mode === "wrong_response" ? 6 : 1);
    expect(campaign.results.filter(r => r.outcome === "qualified")).toHaveLength(mode === "wrong_response" ? 0 : 5);
    const retained = await readFile(f.path, "utf8");
    expect(await f.service.publish(campaign.id, initial.targetId!, true)).toMatchObject({ ok: false, error: expect.stringContaining("did not pass") });
    await expect(f.store.publish(campaign.id, initial.targetId!)).rejects.toThrow("qualification_not_passed");
    expect(await readFile(f.path, "utf8")).toBe(retained);
    expect(f.catalog().decisions).toHaveLength(0);
    expect((await f.service.evidence(campaign.id, campaign.trials[0]!.id)).ok).toBe(true);
    const config = f.configuration();
    const experimental = createHelarcQualificationProfile({ ...config,
      providerProfile: { ...config.providerProfile, qualificationPolicy: "allow_experimental" } }, f.catalog());
    expect(experimental.qualification.disposition.status).toBe("experimental");
  });

  it("bounds a request and never continues after timeout", async () => {
    const f = await fixture("wait");
    const input = f.configuration();
    const result = await runHelarcQualificationTrial({ provider: input.provider,
      profile: createHelarcQualificationProfile(input), caseId: "read-result", repetition: 1,
      signal: new AbortController().signal, requestTimeoutMs: 5 });
    expect(result).toMatchObject({ outcome: "inconclusive", reason: "request_timeout" });
    expect(f.calls).toHaveLength(1);
  });

  it.each(["pass", "literal_newline"] as const)("grades exact LF content without repairing arguments: %s", async mode => {
    const f = await fixture(mode);
    const input = f.configuration();
    const result = await runHelarcQualificationTrial({ provider: input.provider, profile: createHelarcQualificationProfile(input),
      caseId: "write-result", repetition: 1, signal: new AbortController().signal });
    expect(result.scenario.prompt).toContain("one LF newline character (U+000A)");
    expect(result.scenario.expectedInput.content).toBe("qualification sample\n");
    expect(result).toMatchObject(mode === "pass"
      ? { outcome: "passed", stage: "final_response", failureCategory: null }
      : { outcome: "failed", stage: "operation_request", failureCategory: "case_requirement", reason: "incorrect_tool_arguments" });
    expect(result.messages.some(m => m.role === "tool")).toBe(mode === "pass");
  });

  it.each(["pass", "wrong_arguments", "retry_denied"] as const)("distinguishes reaching a denial from mishandling it: %s", async mode => {
    const f = await fixture(mode);
    const input = f.configuration();
    const result = await runHelarcQualificationTrial({ provider: input.provider, profile: createHelarcQualificationProfile(input),
      caseId: "write-denied", repetition: 1, signal: new AbortController().signal });
    expect(result.scenario.expectedInput.content).toBe("qualification sample");
    expect(result.scenario.prompt).toContain("no trailing newline");
    expect(result.messages.some(m => m.role === "tool")).toBe(mode !== "wrong_arguments");
    expect(result).toMatchObject(mode === "pass"
      ? { outcome: "passed", stage: "final_response", failureCategory: null }
      : mode === "wrong_arguments"
        ? { outcome: "failed", stage: "operation_request", failureCategory: "protocol", reason: "invalid_tool_input" }
        : { outcome: "failed", stage: "final_response", failureCategory: "case_requirement", reason: "expected_final_result" });
    expect(f.calls).toHaveLength(mode === "wrong_arguments" ? 1 : 2);
  });

  it.each(["extra_plan", "invalid_plan"] as const)("separates Case requirements from malformed final input: %s", async mode => {
    const f = await fixture(mode);
    const input = f.configuration();
    const result = await runHelarcQualificationTrial({ provider: input.provider, profile: createHelarcQualificationProfile(input),
      caseId: "question-answer", repetition: 1, signal: new AbortController().signal });
    const last = result.messages.at(-1)!;
    const call = last.role === "assistant" ? last.content.find(b => b.kind === "model_tool_call") : undefined;
    expect(call?.kind === "model_tool_call" && call.call.input.response).toBe(result.scenario.expectedResponse);
    expect(result).toMatchObject({ outcome: "failed", stage: "final_response",
      failureCategory: mode === "extra_plan" ? "case_requirement" : "protocol",
      reason: mode === "extra_plan" ? "unexpected_plan" : "invalid_final_result" });
  });

  it("distinguishes an available but wrong Tool from an unknown callable", async () => {
    const f = await fixture("wrong_known_tool");
    const input = f.configuration();
    const result = await runHelarcQualificationTrial({ provider: input.provider, profile: createHelarcQualificationProfile(input),
      caseId: "write-result", repetition: 1, signal: new AbortController().signal });
    expect(result).toMatchObject({ outcome: "failed", stage: "operation_request",
      failureCategory: "case_requirement", reason: "requested_operation_not_called" });
  });

  it("retains and projects calibrated failure categories and rejects forged stage claims", async () => {
    const f = await fixture("extra_plan");
    const target = (await f.service.snapshot()).targetId!;
    await f.service.start(target); await f.service.drain();
    const completed = (await f.service.snapshot()).campaigns[0]!;
    expect(completed.trials.find(t => t.title === "Ask and consume answer")).toMatchObject({
      stage: "final_response", resultDelivery: "submitted", failureCategory: "case_requirement", reason: "unexpected_plan",
    });
    expect((await f.service.publish(completed.id, target, true)).ok).toBe(false);
    const document = JSON.parse(await readFile(f.path, "utf8"));
    expect(document.version).toBe(2);
    expect(document.campaigns[0].suiteRevision).toBe("helarc.native-call-baseline.v2");
    expect(document.campaigns[0].target.qualificationProtocolRevision).toBe("helarc.model-qualification.v3");
    document.campaigns[0].trials[0].stage = "operation_request";
    const { digest: _digest, ...trial } = document.campaigns[0].trials[0];
    document.campaigns[0].trials[0].digest = qualificationDigest(trial);
    await writeFile(f.path, JSON.stringify(document));
    await expect(new HelarcQualificationStore(f.path).read()).rejects.toThrow("qualification_store_corrupt");
  });

  it.each(["transport_failure", "result_transport_failure"] as const)("records result submission separately from Provider success: %s", async mode => {
    const f = await fixture(mode);
    const input = f.configuration();
    const result = await runHelarcQualificationTrial({ provider: input.provider, profile: createHelarcQualificationProfile(input),
      caseId: "write-denied", repetition: 1, signal: new AbortController().signal });
    expect(result).toMatchObject({ outcome: "inconclusive", failureCategory: "infrastructure" });
    expect(result.fixtureResultRequestId).toBe(mode === "transport_failure" ? null : result.requests[1]!.id);
    expect(result.stage).toBe(mode === "transport_failure" ? "operation_request" : "final_response");
  });

  it("detects corrupt evidence, preserves it, and recovers interrupted campaigns without automatic requests", async () => {
    const f = await fixture();
    const initial = await f.service.snapshot();
    await f.service.start(initial.targetId!); await f.service.drain();
    const document = JSON.parse(await readFile(f.path, "utf8"));
    document.campaigns[0].status = "running"; document.campaigns[0].finishedAt = null;
    await writeFile(f.path, JSON.stringify(document));
    const store = new HelarcQualificationStore(f.path);
    await store.recover();
    expect((await store.read()).campaigns[0]!.status).toBe("interrupted");
    document.campaigns[0].trials[0].outcome = "failed";
    const corrupt = JSON.stringify(document);
    await writeFile(f.path, corrupt);
    await expect(new HelarcQualificationStore(f.path).read()).rejects.toThrow("qualification_store_corrupt");
    expect(await readFile(f.path, "utf8")).toBe(corrupt);
  });

  it("preserves prior decisions after failed verification and supersedes them only after publishing a passing campaign", async () => {
    const f = await fixture();
    const target = (await f.service.snapshot()).targetId!;
    await f.service.start(target); await f.service.drain();
    await f.service.publish((await f.service.snapshot()).campaigns[0]!.id, target, true);
    const previous = f.catalog().decisions;
    f.setMode("wrong_response");
    await f.service.start(target); await f.service.drain();
    expect((await f.service.publish((await f.service.snapshot()).campaigns[0]!.id, target, true)).ok).toBe(false);
    expect(f.catalog().decisions).toEqual(previous);
    expect((await f.service.snapshot()).disposition).toBe("qualified");
    f.setMode("pass");
    await f.service.start(target); await f.service.drain();
    expect(f.catalog().decisions).toHaveLength(6);
    await f.service.publish((await f.service.snapshot()).campaigns[0]!.id, target, true);
    expect(f.catalog().decisions).toHaveLength(12);
    for (const decision of f.catalog().decisions.slice(previous.length)) {
      expect(decision.supersedes).toEqual(previous.find(d => d.scope === decision.scope)!.ref);
    }
    expect((await f.service.snapshot()).disposition).toBe("qualified");
    expect((await new HelarcQualificationStore(f.path).read()).decisions).toHaveLength(12);
  });

  it("does not activate a decision if publication persistence fails, and closes an active request", async () => {
    const f = await fixture();
    const target = (await f.service.snapshot()).targetId!;
    await f.service.start(target); await f.service.drain();
    const publication = vi.spyOn(f.store, "publish").mockRejectedValueOnce(new Error("disk full"));
    expect((await f.service.publish((await f.service.snapshot()).campaigns[0]!.id, target, true)).ok).toBe(false);
    expect(f.catalog().decisions).toHaveLength(0);
    publication.mockRestore();
    f.setMode("wait");
    await f.service.start(target);
    await f.service.close();
    expect((await f.service.snapshot()).campaigns[0]!.status).toBe("cancelled");
    expect((await f.service.start(target)).ok).toBe(false);
  });

  it.each(["wrong_name", "wrong_arguments", "truncated"] as const)("retains %s evidence without qualifying", async mode => {
    const f = await fixture(mode);
    const config = f.configuration();
    const result = await runHelarcQualificationTrial({ provider: config.provider, profile: createHelarcQualificationProfile(config),
      caseId: "read-result", repetition: 1, signal: new AbortController().signal });
    expect(result.outcome).toBe(mode === "truncated" ? "inconclusive" : "failed");
    expect(result.failureCategory).toBe(mode === "truncated" ? "infrastructure" : "protocol");
    expect(result.messages).toHaveLength(2);
    expect(f.calls).toHaveLength(1);
  });

  it("does not dispatch if the application closes while campaign creation is being persisted", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const add = f.store.add.bind(f.store);
    vi.spyOn(f.store, "add").mockImplementation(async campaign => { await gate; await add(campaign); });
    const start = f.service.start((await f.service.snapshot()).targetId!);
    const close = f.service.close();
    release();
    await start; await close;
    expect(f.calls).toHaveLength(0);
    expect((await f.service.snapshot()).campaigns[0]!.status).toBe("cancelled");
  });
});

type Body = { messages: { role: string; content: string }[]; tools: { function: { name: string } }[]; thinking?: { type: string } };
type Mode = "pass" | "transport_failure" | "wrong_response" | "partial_failure" | "wait" | "wrong_name" | "wrong_arguments" | "truncated"
  | "literal_newline" | "retry_denied" | "extra_plan" | "invalid_plan" | "wrong_known_tool" | "result_transport_failure";
async function fixture(mode: Mode = "pass", kind: "ollama" | "openai-compatible" = "ollama", thinking?: { type: "disabled" }) {
  const directory = await mkdtemp(join(tmpdir(), "helarc-qualification-test-")); directories.push(directory);
  const path = join(directory, "qualification.json");
  const calls: Body[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as Body; calls.push(body);
    if (mode === "transport_failure" || (mode === "result_transport_failure" && body.messages.at(-1)?.role === "tool")) {
      return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
    }
    if (mode === "wait") return new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(new Error("cancelled"));
      else init.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    const first = body.messages.find(m => m.role === "user")!.content;
    const last = body.messages.at(-1)!;
    let name = "final_result";
    let args: Record<string, unknown>;
    if (last.role === "tool") {
      const data = JSON.parse(last.content).content;
      args = { response: mode === "wrong_response" || (mode === "partial_failure" && first.includes("Read the file")) ? "incorrect" :
        (data.status === "denied" ? "not_written:" : data.answers ? `${data.answers[0].selected_labels[0]}:` : "") + data.receipt };
      if (mode === "retry_denied" && data.status === "denied") {
        name = body.tools.find(t => t.function.name.startsWith("Write_"))!.function.name;
        args = { file_path: "qualification-note.txt", content: "qualification sample" };
      }
    } else if (first.includes("Return exactly")) {
      args = { response: mode === "wrong_response" ? "incorrect" : JSON.parse(first.match(/Return exactly ("[^"]+")/)![1]!) };
    } else {
      const tool = first.includes("Read the file") ? "Read" : first.includes("Write exactly") ? "Write"
        : first.includes("native Shell") ? "PowerShell" : first.includes("Delegate once") ? "Agent" : "AskUserQuestion";
      name = body.tools.find(t => t.function.name.startsWith(`${tool}_`))!.function.name;
      args = tool === "Read" ? { file_path: "qualification-note.txt" }
        : tool === "Write" ? { file_path: "qualification-note.txt", content: mode === "literal_newline" ? "qualification sample\\n"
          : first.includes("no trailing newline") ? "qualification sample" : "qualification sample\n" }
        : tool === "PowerShell" ? { command: "Write-Output 'qualification sample'" }
        : tool === "Agent" ? { prompt: "Return the fixture receipt for this delegated task." }
        : { questions: [{ id: "choice", prompt: "Choose red or blue", allow_multiple: false,
          options: [{ label: "red", description: "Red" }, { label: "blue", description: "Blue" }] }] };
    }
    if (mode === "wrong_name") name = "Read_wrong";
    if (mode === "wrong_known_tool") {
      name = body.tools.find(t => t.function.name.startsWith("Read_"))!.function.name;
      args = { file_path: "qualification-note.txt" };
    }
    if (mode === "wrong_arguments") args = { file_path: 42 };
    if (name === "final_result" && (mode === "extra_plan" || mode === "invalid_plan")) {
      args.plan = [{ step: "Extra Plan", status: mode === "extra_plan" ? "completed" : "not-a-status" }];
    }
    return { ok: true, status: 200, json: async () => kind === "ollama" ? ({ message: { role: "assistant", content: "",
      tool_calls: [{ function: { name, arguments: args } }] }, done: true,
      done_reason: mode === "truncated" ? "length" : "stop", prompt_eval_count: 10, eval_count: 5 })
      : ({ id: `response-${calls.length}`, choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: `call-${calls.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) };
  };
  const providerConfig = { baseUrl: "https://qualification.invalid", model: "test-model", timeoutMs: 10_000,
    nativeToolInteraction: { supported: true }, requestBodyTransportLimit: { maximumBytes: 512 * 1024, source: "host_configured" as const, revision: "test" } };
  const makeProvider = (setting: typeof thinking) => kind === "ollama" ? new OllamaProvider({ ...providerConfig,
    runtime: { contextWindowTokens: 163840, maximumOutputTokens: 2048 } }, fetch)
    : new OpenAICompatibleProvider({ ...providerConfig, apiKey: "test-secret-not-retained", maximumOutputTokens: 2048,
      ...(setting === undefined ? {} : { thinking: setting }) }, fetch);
  let provider = makeProvider(thinking);
  const p = createHelarcProviderProfile({ id: "test", displayName: "Test", providerKind: kind, baseUrl: "https://qualification.invalid",
    model: "test-model", timeoutMs: 10_000, credentialStatus: "empty_allowed", isActive: true, qualificationPolicy: "require_qualified",
    ollamaRuntime: kind === "ollama" ? { contextWindowTokens: 163840, maximumOutputTokens: 2048 } : null });
  if (!p.ok) throw new Error(p.error.code);
  let settings = createDefaultHelarcInstructionSettings();
  let catalog: HelarcModelQualificationCatalog = createHelarcModelQualificationCatalog({ decisions: [] });
  const configuration = (): HelarcQualificationProfileInput => ({
    provider, providerProfile: p.profile, instructionSettings: settings,
    fileActionAdapterIds: HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS,
    shellActionAdapterId: HELARC_LOCAL_SHELL_ACTION_ADAPTER_ID, taskStopActionAdapterId: HELARC_LOCAL_TASK_STOP_ACTION_ADAPTER_ID,
    shellRuntime: { toolName: "PowerShell", executable: "pwsh", dialect: "powershell-7" },
    planLimits: { maxSteps: 24, maxStepLength: 500, maxExplanationLength: 2000 },
  });
  const store = new HelarcQualificationStore(path);
  const service = new HelarcQualificationService({ store, configuration, publishCatalog: value => { catalog = value; } });
  await service.initialize();
  return { service, store, calls, path, configuration, catalog: () => catalog, setMode(value: Mode) { mode = value; },
    setThinking(value: typeof thinking) { provider = makeProvider(value); },
    changeInstructions() { settings = { ...settings, protocol: settings.protocol.map((s, i) => i ? s : { ...s, enabled: true, content: "Use the native protocol." }) }; } };
}
