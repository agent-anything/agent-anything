import { randomUUID } from "node:crypto";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createNativeToolTurnInteraction, snapshotModelMessage, snapshotProviderRequest,
  type Provider, type ProviderRequest, type ModelMessage } from "@agent-anything/model-interaction";
import { composeModelInput, type ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
import { assessModelContext } from "@agent-anything/model-interaction/context";
import type { HelarcQualificationProfile } from "./HelarcQualificationProfile.js";
import { HELARC_QUALIFICATION_SUITE_REVISION, HELARC_QUALIFICATION_REQUEST_TIMEOUT_MS,
  HELARC_QUALIFICATION_MAX_REQUESTS_PER_TRIAL, checkQualificationCall, checkQualificationFinal,
  createHelarcQualificationCase, qualificationDigest,
  type HelarcQualificationCaseId, type HelarcQualificationTrial, type HelarcQualificationTrialOutcome,
  type HelarcQualificationFailureCategory,
} from "./HelarcQualificationProtocol.js";

export function qualificationInstructionSections(profile: HelarcQualificationProfile): readonly ModelInputSectionCandidate[] {
  return [
    ...profile.agent.instructions.blocks.map(block => ({
      id: `agent:${block.id}`, source: block.source, kind: "agent_instruction", role: "instruction" as const,
      necessity: "mandatory" as const, content: { kind: "text" as const, text: block.content },
    })),
    ...profile.protocol.protocolInstructions.filter(s => s.enabled && s.content.trim()).map(s => ({
      id: `protocol:${s.id}`, source: { owner: "helarc", kind: "product_protocol", id: s.id, revision: qualificationDigest(s.content) },
      kind: "product_protocol", role: "instruction" as const, necessity: "mandatory" as const,
      content: { kind: "text" as const, text: s.content },
    })),
  ];
}

export function buildQualificationRequest(input: {
  provider: Provider; profile: HelarcQualificationProfile; messages: readonly ModelMessage[];
  requestId: string; trialId: string; now: string;
}): ProviderRequest {
  const { provider, profile } = input;
  const source = (kind: string, id: string, revision = HELARC_QUALIFICATION_SUITE_REVISION) => ({ owner: "helarc", kind, id, revision });
  const instructionSections = qualificationInstructionSections(profile);
  const instructions = profile.agent.instructions;
  const composition = composeModelInput({
    id: input.requestId, providerId: provider.descriptor.id, model: provider.modelContext.target.model,
    interaction: createNativeToolTurnInteraction(profile.callables.definitions),
    sections: [...instructionSections, ...input.messages.map((message, i) => ({
      id: `${input.trialId}:message:${i}`, source: source("qualification_trial", input.trialId),
      kind: "qualification_history", role: message.role, necessity: "mandatory" as const,
      content: { kind: "model_message" as const, message },
    }))],
    lineage: {
      instructionBinding: source("qualification_instructions", input.trialId),
      agent: source("agent", profile.agent.id, profile.agent.revision),
      instructions: source("agent_instructions", instructions.ref.id, instructions.ref.revision),
      instructionRelease: source("instruction_release", instructions.release.id, instructions.release.revision),
      instructionResolver: source("instruction_resolver", instructions.resolverRevision),
      instructionContent: source("instruction_content", instructions.ref.id, `sha256:${instructions.contentDigest.value}`),
      instructionModel: { providerId: provider.descriptor.id, model: provider.modelContext.target.model },
      instructionBlocks: instructionSections.filter(s => s.kind === "agent_instruction").map(s => s.source),
      activeContext: null, contextProjection: null, projectionManifest: null,
      toolSelection: source("tool_selection", profile.qualification.target.toolSelectionRevision),
      toolExposureContent: null, toolExposureBasis: null, toolExposureProof: null,
      toolGuidance: source("tool_guidance", profile.protocol.toolGuidance.id, profile.protocol.toolGuidance.contentDigest),
      controllerControlGuidance: source("control_guidance", profile.protocol.controlGuidance.id, profile.protocol.controlGuidance.revision),
      callableDefinitions: source("callable_definitions", profile.callables.definitionsDigest),
      modelQualification: null, interactionHistory: source("qualification_trial", input.trialId),
      protocol: source("qualification_protocol", HELARC_QUALIFICATION_SUITE_REVISION),
      policy: source("qualification_policy", HELARC_QUALIFICATION_SUITE_REVISION),
    },
    composedAt: input.now,
  });
  const headroom = { unit: "tokens" as const, amount: 256, policy: { id: "helarc.qualification-headroom", revision: "1" } };
  const assessment = assessModelContext({
    compositionId: composition.id, capacity: provider.modelContext.capacity,
    measurement: provider.modelContext.measure(composition, input.now),
    requestedOutput: provider.modelContext.requestedOutput, headroom,
    assessedAt: input.now, revision: HELARC_QUALIFICATION_SUITE_REVISION,
  });
  if (assessment.disposition === "proven_overflow") throw new Error("qualification_context_overflow");
  return snapshotProviderRequest({
    requestId: composition.id, purpose: "helarc.model-qualification",
    correlation: { controllerRequestId: composition.id, branchId: input.trialId },
    instructions: composition.instructions, messages: composition.messages, interaction: composition.interaction,
    composition, modelContext: { requestedOutput: provider.modelContext.requestedOutput, headroom, assessment },
    continuation: null, metadata: { qualificationTrialId: input.trialId, qualificationSuite: HELARC_QUALIFICATION_SUITE_REVISION },
  });
}

export async function runHelarcQualificationTrial(input: {
  provider: Provider; profile: HelarcQualificationProfile; caseId: HelarcQualificationCaseId;
  repetition: number; signal: AbortSignal; id?: string; marker?: string;
  requestTimeoutMs?: number;
}): Promise<HelarcQualificationTrial> {
  const id = input.id ?? `qualification-trial-${randomUUID()}`;
  const scenario = createHelarcQualificationCase(input.profile, input.caseId, input.marker ?? randomUUID());
  const startedAt = new Date().toISOString();
  const messages: ModelMessage[] = [{ role: "user", content: [{ kind: "text", text: scenario.prompt }] }];
  const requests: { id: string; durationMs: number; usage: unknown }[] = [];
  let fixtureReady = scenario.callableName === null;
  let fixtureResultRequestId: string | null = null;
  const finish = (outcome: HelarcQualificationTrialOutcome, reason: string,
    category: HelarcQualificationFailureCategory = "case_requirement"): HelarcQualificationTrial => {
    const result = { id, caseId: input.caseId, repetition: input.repetition, startedAt,
      finishedAt: new Date().toISOString(), outcome, reason,
      stage: fixtureReady ? "final_response" as const : "operation_request" as const,
      failureCategory: outcome === "passed" ? null : outcome === "inconclusive" ? "infrastructure" as const : category,
      fixtureResultRequestId, scenario, messages, requests };
    return { ...result, digest: qualificationDigest(result) };
  };
  for (let turn = 1; turn <= HELARC_QUALIFICATION_MAX_REQUESTS_PER_TRIAL; turn++) {
    if (input.signal.aborted) return finish("inconclusive", "cancelled");
    const requestId = `${id}:request:${turn}`;
    const deadline = new AbortController();
    const timeoutMs = input.requestTimeoutMs ?? HELARC_QUALIFICATION_REQUEST_TIMEOUT_MS;
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    const context: InvocationInterruptionContext = {
      signal,
      get interruption() {
        return input.signal.aborted
          ? { kind: "run_cancellation" as const, cancellation: { runId: id, requestId: `${id}:cancel` } }
          : deadline.signal.aborted ? { kind: "operation_deadline" as const, deadline: { operationId: requestId, deadlineAt } } : null;
      },
    };
    const start = Date.now();
    const requestRecord = { id: requestId, durationMs: 0, usage: null as unknown };
    requests.push(requestRecord);
    try {
      const request = buildQualificationRequest({ ...input, requestId, trialId: id, messages, now: new Date().toISOString() });
      if (fixtureReady && scenario.callableName !== null) fixtureResultRequestId = requestId;
      const result = await input.provider.send(request, context);
      requestRecord.durationMs = Date.now() - start;
      if (input.signal.aborted) return finish("inconclusive", "cancelled");
      if (deadline.signal.aborted) return finish("inconclusive", "request_timeout");
      if (result.kind !== "succeeded") {
        const code = "failure" in result && /^[a-zA-Z0-9_.-]{1,100}$/.test(result.failure.code) ? result.failure.code : result.kind;
        return finish("inconclusive", `provider:${code}`);
      }
      if (result.response.kind !== "native_tool_turn") return finish("inconclusive", "native_response_unavailable");
      requestRecord.usage = result.response.turn.usage;
      const assistant = snapshotModelMessage(result.response.turn.assistant);
      if (Buffer.byteLength(JSON.stringify(assistant), "utf8") > 65_536) return finish("inconclusive", "evidence_limit");
      messages.push(assistant);
      if (result.response.turn.finish.kind !== "normal") return finish("inconclusive", `finish:${result.response.turn.finish.kind}`);
      if (assistant.role !== "assistant") return finish("inconclusive", "native_response_unavailable");
      const calls = assistant.content.flatMap(b => b.kind === "model_tool_call" ? [b.call] : []);
      if (calls.length !== 1) return finish("failed", "expected_one_requested_call");
      const call = calls[0]!;
      if (fixtureReady) {
        const error = checkQualificationFinal(input.profile, call, scenario.expectedResponse);
        return finish(error ? "failed" : "passed", error?.reason ?? "observed_expected_behavior", error?.category);
      }
      const error = checkQualificationCall(input.profile, scenario, call);
      if (error) return finish("failed", error.reason, error.category);
      messages.push({ role: "tool", content: [{ kind: "model_tool_result", result: {
        modelCallRef: call.modelCallRef, providerCallRef: call.providerCallRef, name: call.name,
        settlement: scenario.denied ? "denied" : "succeeded", content: scenario.fixture,
        sourceRefs: [{ owner: "helarc", kind: "qualification_fixture", id, revision: HELARC_QUALIFICATION_SUITE_REVISION }],
      } }] });
      fixtureReady = true;
    } catch (error) {
      requestRecord.durationMs = Date.now() - start;
      return finish("inconclusive", input.signal.aborted ? "cancelled" : deadline.signal.aborted ? "request_timeout"
        : error instanceof Error && error.message === "qualification_context_overflow" ? "context_overflow" : "qualification_request_failed");
    } finally { clearTimeout(timer); }
  }
  return finish("inconclusive", "request_limit");
}
