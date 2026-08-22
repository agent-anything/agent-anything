import type {
  EvaluationObjective,
  EvaluationRecordRef,
} from "@agent-anything/evaluation/definition";

import {
  createHelarcProductEffectivenessObjective,
} from "./HelarcProductEffectivenessProtocol.js";
import {
  createHelarcProductEffectivenessSuite,
  HELARC_PRODUCT_EFFECTIVENESS_TIME,
  type HelarcProductEffectivenessSuiteProfile,
} from "./HelarcProductEffectivenessSuite.js";

export interface HelarcProductEffectivenessDefinition {
  readonly objective: EvaluationObjective;
  readonly suite: HelarcProductEffectivenessSuiteProfile;
  readonly refs: {
    readonly campaign: EvaluationRecordRef;
    readonly environmentProtocol: EvaluationRecordRef;
    readonly outcomeCriterion: EvaluationRecordRef;
    readonly qualityGate: EvaluationRecordRef;
    readonly safetyGates: readonly EvaluationRecordRef[];
  };
}

export function createHelarcProductEffectivenessDefinition(): HelarcProductEffectivenessDefinition {
  const refs = Object.freeze({
    campaign: ref("helarc.product-effectiveness.campaign"),
    environmentProtocol: ref("helarc.product-effectiveness.environment-protocol"),
    outcomeCriterion: ref("helarc.product-effectiveness.criterion.outcome"),
    qualityGate: ref("helarc.product-effectiveness.gate.outcome-ratio"),
    safetyGates: Object.freeze([
      ref("helarc.product-effectiveness.gate.unauthorized-effect"),
      ref("helarc.product-effectiveness.gate.scope-escape"),
      ref("helarc.product-effectiveness.gate.sensitive-data-disclosure"),
      ref("helarc.product-effectiveness.gate.fabricated-completion"),
      ref("helarc.product-effectiveness.gate.invalid-settlement"),
    ]),
  });
  const objective = createHelarcProductEffectivenessObjective({
    ref: ref("helarc.product-effectiveness.objective"),
    outcomeCriterionRef: refs.outcomeCriterion,
    qualityGateRef: refs.qualityGate,
    safetyGateRefs: refs.safetyGates,
    createdAt: HELARC_PRODUCT_EFFECTIVENESS_TIME,
  });
  return Object.freeze({
    objective,
    suite: createHelarcProductEffectivenessSuite(),
    refs,
  });
}

function ref(id: string): EvaluationRecordRef {
  return Object.freeze({ id, revision: "v1" });
}
