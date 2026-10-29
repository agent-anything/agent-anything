import {composeModelInput, type ModelInputSectionCandidate} from "./ModelInputComposition.js";
import {modelInputValueDigest} from "./ModelWorkingView.js";
import type {ModelInputComposition, ModelInputLineage} from "./ModelInput.js";
import type {ProviderInteraction} from "../ProviderInteraction.js";
import type {CapacityDimension} from "./InputCapacityEvidence.js";

export type InputDuty = "behavior" | "objective" | "capabilities" | "continuity" | "working_understanding" | "evidence" | "new_information";
export interface InputFinding {
  readonly id: string;
  readonly owner: string;
  readonly basis: string;
  readonly requirement: string;
  readonly outcome: "supported" | "unsupported" | "unknown";
  readonly dependencies: Readonly<Record<string, string>>;
  readonly uncertainty: "source" | "preservation_gap" | "residual" | null;
}
export interface InputOption {
  readonly id: string;
  readonly revision: string;
  readonly sections: readonly {readonly position: number; readonly section: ModelInputSectionCandidate}[];
  readonly duties: readonly InputDuty[];
  readonly findings: readonly InputFinding[];
  readonly requirements: readonly string[];
  readonly requires: readonly {readonly contributionId: string; readonly optionId: string}[];
  readonly excludes: readonly {readonly contributionId: string; readonly optionId: string}[];
  readonly preference: number;
  readonly estimatedCost: number | null;
  /** Absence is a justified option, never an allocator-created empty substitute. */
  readonly omissionBasis: string | null;
}
export interface InputContribution {
  readonly id: string;
  readonly owner: string;
  readonly sourceRevision: string;
  readonly deliveryIds: readonly string[];
  readonly currentOptionId: string;
  readonly options: readonly InputOption[];
  readonly localBudget: {readonly dimension:CapacityDimension;readonly grant: number | null; readonly ceiling: number | null};
}
export interface InputOrganizationDemand {
  readonly id: string;
  readonly runId: string;
  readonly recipient: string;
  readonly purpose: string;
  readonly targetRevision: string;
  readonly historyBoundary: string;
  readonly deliveryIds: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly contributions: readonly InputContribution[];
  readonly maximumCombinations: number;
  readonly maximumExternalMeasurements: number;
  readonly maximumReadBytes: number;
}
export type InputChoice = Readonly<Record<string, string>>;
export interface InputCompositionGap {
  readonly kind: "relation" | "preservation" | "scope";
  readonly contributionId: string;
  readonly basis: string;
}

export function validateInputDemand(demand: InputOrganizationDemand): void {
  for (const value of [demand.id, demand.runId, demand.recipient, demand.purpose, demand.targetRevision, demand.historyBoundary]) token(value);
  if (!Number.isSafeInteger(demand.maximumCombinations) || demand.maximumCombinations < 1 ||
      !Number.isSafeInteger(demand.maximumExternalMeasurements) || demand.maximumExternalMeasurements < 0 ||
      !Number.isSafeInteger(demand.maximumReadBytes) || demand.maximumReadBytes < 0) throw new TypeError("input_resource_bounds_invalid");
  const contributions = unique(demand.contributions, c => c.id);
  const deliveries = new Set<string>();
  for (const contribution of demand.contributions) {
    token(contribution.owner); token(contribution.sourceRevision);
    const options = unique(contribution.options, o => o.id);
    if (!options.has(contribution.currentOptionId) || !options.size) throw new TypeError("input_baseline_missing");
    for (const id of contribution.deliveryIds) {
      if (!demand.deliveryIds.includes(id) || deliveries.has(id)) throw new TypeError("input_delivery_scope_invalid");
      deliveries.add(id);
    }
    for (const value of [contribution.localBudget.grant, contribution.localBudget.ceiling]) cost(value);
    for (const option of contribution.options) {
      token(option.revision); cost(option.estimatedCost);
      if (!Number.isFinite(option.preference) || (!option.sections.length && !option.omissionBasis)) throw new TypeError("input_option_basis_missing");
      for (const occurrence of option.sections) if (!Number.isSafeInteger(occurrence.position) || occurrence.position < 0) throw new TypeError("input_position_invalid");
      for (const dependency of [...option.requires, ...option.excludes]) {
        if (!contributions.get(dependency.contributionId)?.options.some(o => o.id === dependency.optionId)) throw new TypeError("input_companion_missing");
      }
      unique(option.findings, f => f.id);
      for (const finding of option.findings) {token(finding.owner); token(finding.basis); token(finding.requirement);}
    }
  }
  if (deliveries.size !== demand.deliveryIds.length) throw new TypeError("input_delivery_coverage_missing");
}

export function inputChoiceGaps(demand: InputOrganizationDemand, choice: InputChoice): readonly InputCompositionGap[] {
  validateInputDemand(demand);
  const gaps: InputCompositionGap[] = [];
  if (Object.keys(choice).length !== demand.contributions.length) throw new TypeError("input_choice_scope_invalid");
  for (const contribution of demand.contributions) {
    const option = contribution.options.find(o => o.id === choice[contribution.id]);
    if (!option) throw new TypeError("input_option_unavailable");
    for (const dependency of option.requires) if (choice[dependency.contributionId] !== dependency.optionId) gaps.push({kind:"relation", contributionId:contribution.id, basis:`requires:${dependency.contributionId}:${dependency.optionId}`});
    for (const dependency of option.excludes) if (choice[dependency.contributionId] === dependency.optionId) gaps.push({kind:"relation", contributionId:contribution.id, basis:`excludes:${dependency.contributionId}:${dependency.optionId}`});
    for (const requirement of option.requirements) {
      const findings = option.findings.filter(f => f.requirement === requirement && Object.entries(f.dependencies).every(([key,value]) => demand.dependencies[key] === value));
      if (!findings.some(f => f.outcome === "supported") || findings.some(f => f.outcome === "unsupported" || f.uncertainty === "preservation_gap")) {
        gaps.push({kind:"preservation", contributionId:contribution.id, basis:requirement});
      }
    }
  }
  return gaps;
}

export function inputChoiceId(demand: InputOrganizationDemand, choice: InputChoice): string {
  return modelInputValueDigest({demandDigest:modelInputValueDigest(demand), choice});
}

export function composeInputChoice(demand: InputOrganizationDemand, choice: InputChoice, target: {
  providerId: string; model: string; interaction: ProviderInteraction; lineage: ModelInputLineage; composedAt: string;
}): ModelInputComposition {
  const gaps = inputChoiceGaps(demand, choice);
  if (gaps.length) throw new TypeError(`input_composition_unresolved:${gaps[0]!.kind}:${gaps[0]!.basis}`);
  const occurrences = demand.contributions.flatMap(c => c.options.find(o => o.id === choice[c.id])!.sections);
  unique(occurrences, o => String(o.position));
  unique(occurrences, o => o.section.id);
  // Position is a source/organization decision, not a capacity optimization.
  return composeModelInput({...target, id:inputChoiceId(demand, choice), sections:[...occurrences].sort((a,b) => a.position-b.position).map(o => o.section)});
}

function unique<T>(values: readonly T[], key: (value:T) => string): Map<string,T> {
  const map = new Map<string,T>();
  for (const value of values) {const id = key(value); token(id); if (map.has(id)) throw new TypeError("input_identity_duplicate"); map.set(id,value);}
  return map;
}
function token(value:string): void {if (typeof value !== "string" || !value.trim()) throw new TypeError("input_identity_invalid");}
function cost(value:number|null): void {if (value !== null && (!Number.isFinite(value) || value < 0)) throw new TypeError("input_cost_invalid");}
