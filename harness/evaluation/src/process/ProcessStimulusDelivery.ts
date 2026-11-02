import type {EvaluationDataValue} from "../contract/EvaluationData.js";
import type {EvaluationRecordRef} from "../contract/EvaluationPrimitives.js";
import {sameProcessValue, selectProcessStimuli, type EvaluationProcessPlan, type ProcessConditionFact} from "./ProcessDefinition.js";

export interface ProcessStimulusReceipt {
  readonly trialRef: EvaluationRecordRef;
  readonly id: string;
  readonly stimulusId: string;
  readonly input: EvaluationDataValue;
  readonly basis: EvaluationRecordRef;
  readonly recipientReceipt: EvaluationRecordRef | null;
}
export interface ProcessStimulusDeliveryPorts {
  readonly load: (id: string) => Promise<ProcessStimulusReceipt | null>;
  readonly commit: (expected: ProcessStimulusReceipt | null, next: ProcessStimulusReceipt) => Promise<void>;
  readonly verify: (fact: ProcessConditionFact) => Promise<boolean>;
  /** Must accept the same delivery identity idempotently, including after a lost acknowledgement. */
  readonly accept: (delivery: ProcessStimulusReceipt) => Promise<EvaluationRecordRef>;
}

export class EvaluationProcessStimulusDelivery {
  constructor(readonly plan: EvaluationProcessPlan, readonly ports: ProcessStimulusDeliveryPorts) {}
  async deliver(facts: readonly ProcessConditionFact[]): Promise<readonly ProcessStimulusReceipt[]> {
    const verified: ProcessConditionFact[] = [];
    for (const fact of facts) if (await this.ports.verify(fact)) verified.push(fact);
    const delivered: ProcessStimulusReceipt[] = [];
    for (const selected of selectProcessStimuli(this.plan, verified, [])) {
      const id = `${this.plan.trial.ref.id}:stimulus:${selected.id}`;
      let saved = await this.ports.load(id);
      if (saved && (!sameProcessValue(saved.trialRef, this.plan.trial.ref) || saved.stimulusId !== selected.id || !sameProcessValue(saved.input, selected.input)))
        throw new Error("process_stimulus_binding_mismatch");
      if (!saved) {
        saved = {id, trialRef: this.plan.trial.ref, stimulusId: selected.id, input: selected.input, basis: selected.basis, recipientReceipt: null};
        await this.ports.commit(null, saved);
      }
      if (!saved.recipientReceipt) {
        const recipientReceipt = await this.ports.accept(saved);
        const next = {...saved, recipientReceipt};
        await this.ports.commit(saved, next); saved = next;
      }
      delivered.push(saved);
    }
    return delivered;
  }
}
