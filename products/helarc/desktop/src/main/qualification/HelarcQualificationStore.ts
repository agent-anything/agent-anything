import { randomUUID } from "node:crypto";
import { snapshotModelMessages, snapshotModelCallableDefinitions } from "@agent-anything/model-interaction";
import {
  HELARC_QUALIFICATION_CASES, HELARC_QUALIFICATION_REPETITIONS, HELARC_QUALIFICATION_SUITE_REVISION,
  HELARC_QUALIFICATION_LIMITATIONS, qualificationDigest, summarizeQualificationScopes,
  checkQualificationCall, checkQualificationFinal, createHelarcQualificationCase,
  type HelarcQualificationTrial, type HelarcQualificationProfile,
} from "@agent-anything/helarc/qualification-execution";
import {
  createHelarcModelQualificationCatalog, createHelarcModelQualificationDecision,
  createHelarcModelQualificationTarget, resolveHelarcModelQualificationApplicability,
  type HelarcModelQualificationDecision, type HelarcModelQualificationTarget,
} from "@agent-anything/helarc/model-qualification";
import type { ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
import { SerializedAtomicFile } from "../persistence/SerializedAtomicFile.js";

export interface QualificationCampaign {
  readonly id: string;
  readonly target: HelarcModelQualificationTarget;
  readonly suiteRevision: string;
  readonly material: Pick<HelarcQualificationProfile, "callables" | "tools" | "shellRuntime" | "planLimits"> & {
    readonly instructions: readonly ModelInputSectionCandidate[];
  };
  readonly materialDigest: string;
  readonly startedAt: string;
  readonly status: "running" | "completed" | "cancelled" | "interrupted";
  readonly finishedAt: string | null;
  readonly trials: readonly HelarcQualificationTrial[];
  readonly publishedAt: string | null;
}
interface QualificationDocument {
  readonly version: 2;
  readonly campaigns: readonly QualificationCampaign[];
  readonly decisions: readonly HelarcModelQualificationDecision[];
}
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_CAMPAIGNS = 40;

export class HelarcQualificationStore {
  private readonly file: SerializedAtomicFile;
  private cached: QualificationDocument | null = null;
  constructor(path: string) { this.file = new SerializedAtomicFile(path); }

  async read(): Promise<QualificationDocument> {
    if (this.cached) return this.cached;
    return this.file.transact(async file => this.cached = parseDocument(await file.readText()));
  }
  async recover(): Promise<void> {
    await this.change(document => ({ ...document, campaigns: document.campaigns.map(c => c.status === "running"
      ? { ...c, status: "interrupted", finishedAt: new Date().toISOString() } : c) }));
  }
  async add(campaign: QualificationCampaign): Promise<void> {
    await this.change(document => {
      if (document.campaigns.length >= MAX_CAMPAIGNS) throw new Error("qualification_storage_full");
      if (document.campaigns.some(c => c.id === campaign.id || c.status === "running")) throw new Error("qualification_already_running");
      return { ...document, campaigns: [...document.campaigns, campaign] };
    });
  }
  async append(id: string, trial: HelarcQualificationTrial): Promise<void> {
    await this.change(document => {
      if (!document.campaigns.some(c => c.id === id)) throw new Error("qualification_not_found");
      return { ...document, campaigns: document.campaigns.map(c => {
      if (c.id !== id) return c;
      if (c.status !== "running" || c.publishedAt) throw new Error("qualification_campaign_closed");
      return { ...c, trials: [...c.trials, trial] };
      }) };
    });
  }
  async finish(id: string, status: "completed" | "cancelled" | "interrupted"): Promise<void> {
    await this.change(document => ({ ...document, campaigns: document.campaigns.map(c => c.id === id && c.status === "running"
      ? { ...c, status, finishedAt: new Date().toISOString() } : c) }));
  }
  async publish(id: string, targetId: string): Promise<ReturnType<typeof createHelarcModelQualificationCatalog>> {
    let result: ReturnType<typeof createHelarcModelQualificationCatalog> | undefined;
    await this.change(document => {
      const campaign = document.campaigns.find(c => c.id === id);
      if (!campaign || campaign.status !== "completed") throw new Error("qualification_not_completed");
      if (campaign.target.id !== targetId) throw new Error("qualification_target_changed");
      const scopes = summarizeQualificationScopes(campaign.trials);
      if (scopes.some(scope => scope.outcome !== "qualified")) throw new Error("qualification_not_passed");
      const catalog = createHelarcModelQualificationCatalog({ decisions: document.decisions });
      if (campaign.publishedAt) { result = catalog; return document; }
      const decidedAt = new Date().toISOString();
      const decisions = scopes.map(scope => createHelarcModelQualificationDecision({
        id: `qualification-decision-${randomUUID()}`,
        target: campaign.target, scope: scope.scope, outcome: scope.outcome,
        evidenceRefs: campaign.trials.filter(t => t.scenario.scope === scope.scope).map(t => ({
          owner: "helarc", kind: "qualification_trial", id: t.id, revision: t.digest,
        })),
        limitations: HELARC_QUALIFICATION_LIMITATIONS, decidedAt, decidedBy: "local-user-reviewed-baseline",
        supersedes: resolveHelarcModelQualificationApplicability({ catalog, target: campaign.target, scope: scope.scope }).decision?.ref ?? null,
      }));
      result = createHelarcModelQualificationCatalog({ decisions: [...document.decisions, ...decisions] });
      return { ...document, decisions: result.decisions,
        campaigns: document.campaigns.map(c => c.id === id ? { ...c, publishedAt: decidedAt } : c) };
    });
    return result!;
  }

  private change(update: (document: QualificationDocument) => QualificationDocument): Promise<void> {
    return this.file.transact(async file => {
      const next = update(parseDocument(await file.readText()));
      const text = JSON.stringify(next);
      parseDocument(text);
      await file.replaceText(text);
      this.cached = parseDocument(text);
    });
  }
}

function parseDocument(text: string | null): QualificationDocument {
  if (text === null) return { version: 2, campaigns: [], decisions: [] };
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("qualification_storage_full");
  try {
    const document = JSON.parse(text) as QualificationDocument;
    if (document.version !== 2 || !Array.isArray(document.campaigns) || document.campaigns.length > MAX_CAMPAIGNS || !Array.isArray(document.decisions)) throw new Error();
    const ids = new Set<string>();
    const trials = new Map<string, { campaign: QualificationCampaign; trial: HelarcQualificationTrial }>();
    for (const c of document.campaigns) {
      if (typeof c.id !== "string" || !c.id || ids.has(c.id) || c.suiteRevision !== HELARC_QUALIFICATION_SUITE_REVISION ||
        !["running", "completed", "cancelled", "interrupted"].includes(c.status) ||
        !date(c.startedAt) || (c.status === "running" ? c.finishedAt !== null : !date(c.finishedAt)) ||
        (c.publishedAt !== null && (!date(c.publishedAt) || c.status !== "completed"))) throw new Error();
      ids.add(c.id);
      const { id: targetId, ...target } = c.target;
      if (createHelarcModelQualificationTarget(target).id !== targetId || c.materialDigest !== qualificationDigest(c.material) ||
        Buffer.byteLength(JSON.stringify(c.material), "utf8") > 2 * 1024 * 1024) throw new Error();
      snapshotModelCallableDefinitions(c.material.callables.definitions);
      if (!c.material.planLimits || [c.material.planLimits.maxSteps, c.material.planLimits.maxStepLength,
        c.material.planLimits.maxExplanationLength].some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error();
      if (!Array.isArray(c.trials) || c.trials.length > HELARC_QUALIFICATION_CASES.length * HELARC_QUALIFICATION_REPETITIONS) throw new Error();
      const coverage = new Set<string>();
      for (const trial of c.trials) {
        validateTrial(trial, c.material);
        const key = `${trial.caseId}:${trial.repetition}`;
        if (coverage.has(key) || trials.has(trial.id)) throw new Error();
        coverage.add(key); trials.set(trial.id, { campaign: c, trial });
      }
      if (c.status === "completed" && c.trials.length !== HELARC_QUALIFICATION_CASES.length * HELARC_QUALIFICATION_REPETITIONS) throw new Error();
    }
    if (document.campaigns.filter(c => c.status === "running").length > 1) throw new Error();
    const catalog = createHelarcModelQualificationCatalog({ decisions: document.decisions });
    for (const decision of catalog.decisions) {
      const evidence = decision.evidenceRefs.map(ref => {
        const found = trials.get(ref.id);
        if (!found || ref.owner !== "helarc" || ref.kind !== "qualification_trial" || ref.revision !== found.trial.digest ||
          found.campaign.target.id !== decision.target.id || found.campaign.publishedAt !== decision.decidedAt ||
          found.trial.scenario.scope !== decision.scope) throw new Error();
        return found;
      });
      const campaign = evidence[0]!.campaign;
      if (new Set(decision.evidenceRefs.map(ref => ref.id)).size !== evidence.length ||
        evidence.some(e => e.campaign.id !== campaign.id) || evidence.length !== campaign.trials.filter(t => t.scenario.scope === decision.scope).length ||
        summarizeQualificationScopes(campaign.trials).find(s => s.scope === decision.scope)?.outcome !== decision.outcome) throw new Error();
    }
    for (const c of document.campaigns.filter(c => c.publishedAt !== null)) {
      if (catalog.decisions.filter(d => d.target.id === c.target.id && d.decidedAt === c.publishedAt).length !== 6) throw new Error();
    }
    return document;
  } catch { throw new Error("qualification_store_corrupt"); }
}

function validateTrial(trial: HelarcQualificationTrial, material: QualificationCampaign["material"]): void {
  const { digest, ...data } = trial;
  const entry = HELARC_QUALIFICATION_CASES.find(c => c.id === trial.caseId);
  if (!entry || typeof trial.id !== "string" || !trial.id ||
    typeof trial.scenario.marker !== "string" || !trial.scenario.marker || trial.scenario.marker.length > 100 ||
    qualificationDigest(trial.scenario) !== qualificationDigest(createHelarcQualificationCase(material, entry.id, trial.scenario.marker)) ||
    !Number.isSafeInteger(trial.repetition) || trial.repetition < 1 || trial.repetition > HELARC_QUALIFICATION_REPETITIONS ||
    !date(trial.startedAt) || !date(trial.finishedAt) || qualificationDigest(data) !== digest ||
    !["passed", "failed", "inconclusive"].includes(trial.outcome) || typeof trial.reason !== "string" || trial.reason.length > 200 ||
    !Array.isArray(trial.requests) || trial.requests.length > 3 ||
    trial.requests.some(r => typeof r.id !== "string" || !r.id || !Number.isFinite(r.durationMs) || r.durationMs < 0) ||
    Buffer.byteLength(JSON.stringify(trial), "utf8") > 256_000) throw new Error();
  snapshotModelMessages(trial.messages);
  if (trial.messages[0]?.role !== "user" || JSON.stringify(trial.messages[0].content) !== JSON.stringify([{ kind: "text", text: trial.scenario.prompt }])) throw new Error();
  const toolResults = trial.messages.filter(m => m.role === "tool");
  if (toolResults.length > 0) {
    const first = trial.messages[1];
    const calls = first?.role === "assistant" ? first.content.flatMap(b => b.kind === "model_tool_call" ? [b.call] : []) : [];
    const result = trial.messages[2];
    if (trial.scenario.callableName === null || toolResults.length !== 1 || calls.length !== 1 ||
      checkQualificationCall(material, trial.scenario, calls[0]!) || result?.role !== "tool" || result.content.length !== 1 ||
      result.content[0]!.result.modelCallRef.id !== calls[0]!.modelCallRef.id ||
      result.content[0]!.result.name !== calls[0]!.name ||
      result.content[0]!.result.settlement !== (trial.scenario.denied ? "denied" : "succeeded") ||
      JSON.stringify(result.content[0]!.result.content) !== JSON.stringify(trial.scenario.fixture)) throw new Error();
  }
  const delivered = trial.scenario.callableName === null || toolResults.length > 0;
  if (trial.fixtureResultRequestId !== null && (typeof trial.fixtureResultRequestId !== "string" || toolResults.length !== 1 ||
    trial.requests[1]?.id !== trial.fixtureResultRequestId)) throw new Error();
  if (toolResults.length > 0 && trial.outcome !== "inconclusive" && trial.fixtureResultRequestId === null) throw new Error();
  if (trial.stage !== (delivered ? "final_response" : "operation_request") ||
    (trial.outcome === "passed" ? trial.failureCategory !== null : trial.outcome === "inconclusive"
      ? trial.failureCategory !== "infrastructure" : !["protocol", "case_requirement"].includes(trial.failureCategory!))) throw new Error();
  if (trial.outcome === "failed") {
    const last = trial.messages.at(-1);
    if (last?.role !== "assistant") throw new Error();
    const calls = last.content.flatMap(b => b.kind === "model_tool_call" ? [b.call] : []);
    const failure = calls.length !== 1 ? { category: "case_requirement", reason: "expected_one_requested_call" }
      : delivered ? checkQualificationFinal(material, calls[0]!, trial.scenario.expectedResponse)
      : checkQualificationCall(material, trial.scenario, calls[0]!);
    if (!failure || failure.category !== trial.failureCategory || failure.reason !== trial.reason) throw new Error();
  }
  if (trial.outcome !== "passed") return;
  if (trial.reason !== "observed_expected_behavior") throw new Error();
  const assistants = trial.messages.filter(m => m.role === "assistant");
  if (trial.requests.length !== assistants.length) throw new Error();
  const final = assistants.at(-1)!;
  const finalCalls = final?.content.flatMap(b => b.kind === "model_tool_call" ? [b.call] : []) ?? [];
  if (finalCalls.length !== 1 || checkQualificationFinal(material, finalCalls[0]!, trial.scenario.expectedResponse)) throw new Error();
  if (trial.scenario.callableName === null) { if (trial.messages.length !== 2) throw new Error(); return; }
  if (trial.messages.length !== 4 || assistants.length !== 2) throw new Error();
  if (toolResults.length !== 1) throw new Error();
}
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
