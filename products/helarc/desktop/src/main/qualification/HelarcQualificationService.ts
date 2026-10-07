import { randomUUID } from "node:crypto";
import {
  HELARC_QUALIFICATION_CASES, HELARC_QUALIFICATION_REPETITIONS, HELARC_QUALIFICATION_LIMITATIONS,
  HELARC_QUALIFICATION_SUITE_REVISION, HELARC_QUALIFICATION_REQUEST_TIMEOUT_MS,
  HELARC_QUALIFICATION_MAX_REQUESTS_PER_TRIAL,
  createHelarcQualificationProfile,
  qualificationInstructionSections, qualificationDigest, runHelarcQualificationTrial, summarizeQualificationScopes,
  type HelarcQualificationProfileInput,
} from "@agent-anything/helarc/qualification-execution";
import { createHelarcModelQualificationCatalog, type HelarcModelQualificationCatalog } from "@agent-anything/helarc/model-qualification";
import type { HelarcQualificationSnapshot, HelarcQualificationCommandResult, HelarcQualificationEvidence } from "../../shared/HelarcQualification.js";
import { HelarcQualificationStore, type QualificationCampaign } from "./HelarcQualificationStore.js";

const TOTAL_TRIALS = HELARC_QUALIFICATION_CASES.length * HELARC_QUALIFICATION_REPETITIONS;
const PROTOCOL = Object.freeze({ revision: HELARC_QUALIFICATION_SUITE_REVISION,
  totalTrials: TOTAL_TRIALS, maximumRequests: TOTAL_TRIALS * HELARC_QUALIFICATION_MAX_REQUESTS_PER_TRIAL,
  requestTimeoutMs: HELARC_QUALIFICATION_REQUEST_TIMEOUT_MS, limitations: HELARC_QUALIFICATION_LIMITATIONS });

export class HelarcQualificationService {
  private active: { id: string; abort: AbortController; work: Promise<void>; currentCase: string | null } | null = null;
  private starting = false;
  private closed = false;
  private error: string | null = null;
  private closing: Promise<void> | null = null;

  constructor(private readonly input: {
    store: HelarcQualificationStore;
    configuration(): HelarcQualificationProfileInput | null;
    publishCatalog(catalog: HelarcModelQualificationCatalog): void;
    trial?: typeof runHelarcQualificationTrial;
  }) {}

  async initialize(): Promise<void> {
    await this.input.store.recover();
    this.input.publishCatalog(createHelarcModelQualificationCatalog({ decisions: (await this.input.store.read()).decisions }));
  }

  async snapshot(): Promise<HelarcQualificationSnapshot> {
    const document = await this.input.store.read();
    const config = this.input.configuration();
    const profile = config ? createHelarcQualificationProfile(config,
      createHelarcModelQualificationCatalog({ decisions: document.decisions })) : null;
    return {
      available: profile !== null && config!.provider.descriptor.capabilities.nativeToolInteraction.supported && !this.closed,
      error: this.error, targetId: profile?.qualification.target.id ?? null,
      model: profile?.qualification.target.modelId ?? null,
      disposition: profile?.qualification.disposition.status ?? null,
      scopes: profile?.qualification.safeProjection.scopes ?? [], activeCampaignId: this.active?.id ?? null, protocol: PROTOCOL,
      campaigns: [...document.campaigns].reverse().map(c => ({
        id: c.id, model: c.target.modelId, startedAt: c.startedAt, status: c.status,
        currentCase: this.active?.id === c.id ? this.active.currentCase : null,
        completedTrials: c.trials.length, totalTrials: TOTAL_TRIALS,
        currentTarget: c.target.id === profile?.qualification.target.id,
        publishedAt: c.publishedAt, results: summarizeQualificationScopes(c.trials),
        trials: c.trials.map(t => ({ id: t.id, title: t.scenario.title, repetition: t.repetition, outcome: t.outcome, reason: t.reason,
          stage: t.stage, failureCategory: t.failureCategory,
          resultDelivery: t.scenario.callableName === null ? "not_applicable" as const
            : t.fixtureResultRequestId !== null ? "submitted" as const : "not_submitted" as const })),
      })),
    };
  }

  async start(targetId: string): Promise<HelarcQualificationCommandResult> {
    if (this.closed) return failure("Qualification service is closed.");
    if (this.active || this.starting) return failure("A verification is already running.");
    this.starting = true;
    try {
      const config = this.input.configuration();
      if (!config) return failure("Save a complete Provider configuration first.");
      const profile = createHelarcQualificationProfile(config);
      if (profile.qualification.target.id !== targetId) return failure("The saved configuration changed. Review the current configuration first.");
      if (!config.provider.descriptor.capabilities.nativeToolInteraction.supported) return failure("The Provider does not support native Tool calls.");
      const material = { callables: profile.callables, tools: profile.tools, shellRuntime: profile.shellRuntime, planLimits: profile.planLimits,
        instructions: qualificationInstructionSections(profile) };
      const campaign: QualificationCampaign = {
        id: `qualification-${randomUUID()}`, target: profile.qualification.target,
        suiteRevision: HELARC_QUALIFICATION_SUITE_REVISION, material, materialDigest: qualificationDigest(material),
        startedAt: new Date().toISOString(), status: "running", finishedAt: null, trials: [], publishedAt: null,
      };
      await this.input.store.add(campaign);
      const abort = new AbortController();
      if (this.closed) abort.abort();
      const active = { id: campaign.id, abort, currentCase: null as string | null, work: Promise.resolve() };
      this.active = active; this.error = null;
      active.work = (async () => {
        try {
          for (const scenario of HELARC_QUALIFICATION_CASES) {
            for (let repetition = 1; repetition <= HELARC_QUALIFICATION_REPETITIONS; repetition++) {
              if (abort.signal.aborted) break;
              active.currentCase = `${scenario.title} (${repetition}/${HELARC_QUALIFICATION_REPETITIONS})`;
              const trial = await (this.input.trial ?? runHelarcQualificationTrial)({
                provider: config.provider, profile, caseId: scenario.id, repetition, signal: abort.signal,
              });
              await this.input.store.append(campaign.id, trial);
            }
            if (abort.signal.aborted) break;
          }
          await this.input.store.finish(campaign.id, abort.signal.aborted ? "cancelled" : "completed");
        } catch {
          this.error = "Verification could not be retained. No qualification decisions were published.";
          await this.input.store.finish(campaign.id, "interrupted").catch(() => {});
        } finally { if (this.active === active) this.active = null; }
      })();
      return { ok: true };
    } catch (error) {
      return failure(error instanceof Error && error.message === "qualification_storage_full"
        ? "Qualification storage is full. Existing evidence was preserved." : "Verification could not be started. Check local qualification storage.");
    } finally { this.starting = false; }
  }

  cancel(campaignId: string): HelarcQualificationCommandResult {
    if (this.active?.id !== campaignId) return failure("This verification is no longer running.");
    this.active.abort.abort();
    return { ok: true };
  }

  async publish(campaignId: string, targetId: string, reviewed: boolean): Promise<HelarcQualificationCommandResult> {
    if (!reviewed) return failure("Review the evidence and limitations before publishing.");
    if (this.active || this.starting || this.closed) return failure("Wait for the active verification to finish.");
    const config = this.input.configuration();
    if (!config || createHelarcQualificationProfile(config).qualification.target.id !== targetId) return failure("The saved configuration changed; this result cannot be published for it.");
    try {
      const catalog = await this.input.store.publish(campaignId, targetId);
      this.input.publishCatalog(catalog);
      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === "qualification_not_passed") {
        return failure("Verification did not pass. All required trials must pass before publishing; the evidence is retained.");
      }
      return failure("Publication failed. The campaign must be complete, passing, current, and have intact retained evidence.");
    }
  }

  async evidence(campaignId: string, trialId: string | null): Promise<HelarcQualificationEvidence> {
    const campaign = (await this.input.store.read()).campaigns.find(c => c.id === campaignId);
    if (!campaign) return { ok: false, error: "Verification not found." };
    const value = trialId === null ? { target: campaign.target, protocol: PROTOCOL, material: campaign.material }
      : campaign.trials.find(t => t.id === trialId);
    if (!value) return { ok: false, error: "Trial not found." };
    return { ok: true, text: JSON.stringify(value, null, 2) };
  }

  async drain(): Promise<void> { await this.active?.work; }
  close(): Promise<void> {
    this.closed = true;
    this.active?.abort.abort();
    this.closing ??= (async () => {
      while (this.starting) await new Promise(resolve => setTimeout(resolve, 10));
      this.active?.abort.abort();
      await this.drain();
    })();
    return this.closing;
  }
}
function failure(error: string): HelarcQualificationCommandResult { return { ok: false, error }; }
