import {
  snapshotModelInteractionProtocol, snapshotModelInteractionScope, snapshotNativeModelSource, snapshotProtocolRevisionRef,
  sameProtocolRef, type ModelInteractionProtocolRef, type ModelInteractionScope, type NativeModelSourceRef, type ProtocolRevisionRef,
} from "@agent-anything/model-interaction/protocol";
import { equal, key, requireSequence, requireText, requireTime, snapshot } from "./AccountingValue.js";
import { nonnegativeDecimal } from "./ExactDecimal.js";
import { mergeNativeQuantities, projectNativeUsage, type NativeChargeComponent, type NativeQuantity, type NativeUsageProfile } from "./NativeUsage.js";
import { calculateNativeCost, type NativeCostCalculation } from "./NativeCost.js";

export interface NativeWorkSubmission {
  readonly id: string;
  readonly protocol: ModelInteractionProtocolRef;
  readonly scope: ModelInteractionScope;
  readonly endpoint: string | null;
  readonly account: string;
  readonly operation: "generation" | "compact" | "count" | "read" | "cancel" | "file" | "storage";
  readonly submittedAt: string | null;
  readonly model: string | null;
  readonly requestedTier: string | null;
  readonly reportedTier: string | null;
  readonly region: string | null;
  readonly modality: string | null;
  readonly reconciliationOwner: string;
  readonly beneficiaries: readonly string[];
  readonly stage: string | null;
}
export interface NativeUsageObservation {
  readonly id: string;
  readonly submissionId: string;
  readonly source: NativeModelSourceRef;
  readonly receivedAt: string | null;
  readonly channel: "create" | "stream" | "get" | "recovery";
  /** This is usage finality only, not a native response or task lifecycle. */
  readonly finality: "partial" | "terminal";
  /** Comparable only within this authority and revision domain; never arrival order. */
  readonly authority: string;
  readonly revisionDomain: string;
  readonly cumulativeRevision: number | null;
  readonly profile: NativeUsageProfile;
  readonly usage: unknown;
  /** Later native facts do not rewrite immutable submission metadata. */
  readonly work?:{readonly startedAt:string|null;readonly completedAt:string|null;readonly reportedTier:string|null};
}
export interface NativeUsageContribution {
  readonly revision: string;
  readonly state: "pending" | "observed" | "missing" | "conflicting";
  readonly finality: "partial" | "terminal" | null;
  readonly observationIds: readonly string[];
  readonly fields: Readonly<Record<string, NativeQuantity>>;
  readonly units: Readonly<Record<string, "tokens" | "nanoseconds">>;
  readonly components: readonly NativeChargeComponent[];
  readonly inputField: string | null;
  readonly outputField: string | null;
  readonly cacheReadField: string | null;
  readonly cacheWriteField: string | null;
  readonly profileKey: string | null;
  readonly issues: readonly string[];
}
export interface NativeRemoteWork {
  readonly kind: string;
  readonly id: string;
}
export interface NativeWork {
  readonly id: string;
  readonly submissionIds: readonly string[];
  readonly origin: NativeWorkSubmission;
  readonly remote: NativeRemoteWork | null;
  readonly observationCommands: readonly string[];
  readonly contribution: NativeUsageContribution;
  readonly reconciliationOwner: string;
  readonly localReleased: boolean;
  readonly exposure: "unresolved" | "reconciled" | "owner_disposed";
  readonly settlement: { readonly id: string; readonly contributionRevision: string; readonly basis: ProtocolRevisionRef } | null;
  readonly costCalculations: readonly NativeCostCalculation[];
}
export interface NativeReservation {
  readonly id: string;
  readonly submissionId: string;
  readonly resource: string;
  readonly amount: string;
  readonly unit: string;
  readonly guarantee: "estimate" | "enforceable_bound";
  readonly admissionBasis: ProtocolRevisionRef;
  readonly status: "held" | "reconciled" | "owner_disposed";
  readonly disposition: ProtocolRevisionRef | null;
}
export type NativeAccountingCommand = { readonly id: string } & (
  | { readonly kind: "register"; readonly submission: NativeWorkSubmission }
  | { readonly kind: "bind_remote"; readonly submissionId: string; readonly remote: NativeRemoteWork; readonly evidence: NativeModelSourceRef }
  | { readonly kind: "observe"; readonly observation: NativeUsageObservation }
  | { readonly kind: "record_cost"; readonly submissionId: string; readonly calculation: NativeCostCalculation }
  | { readonly kind: "reserve"; readonly reservation: Omit<NativeReservation, "status" | "disposition"> }
  | { readonly kind: "release_local"; readonly submissionId: string; readonly basis: ProtocolRevisionRef }
  | { readonly kind: "handoff"; readonly submissionId: string; readonly expectedOwner: string; readonly nextOwner: string; readonly basis: ProtocolRevisionRef }
  | { readonly kind: "settle"; readonly submissionId: string; readonly owner: string; readonly contributionRevision: string;
      readonly reservationIds: readonly string[]; readonly basis: ProtocolRevisionRef }
  | { readonly kind: "dispose"; readonly submissionId: string; readonly owner: string; readonly reservationIds: readonly string[]; readonly basis: ProtocolRevisionRef }
);
export interface NativeAccountingState {
  readonly schemaVersion: 1;
  readonly ruleRevision: "native-accounting/1";
  readonly revision: number;
  readonly works: Readonly<Record<string, NativeWork>>;
  readonly submissions: Readonly<Record<string, string>>;
  readonly registrations: Readonly<Record<string, string>>;
  readonly remoteWork: Readonly<Record<string, string>>;
  readonly observations: Readonly<Record<string, string>>;
  readonly reservations: Readonly<Record<string, NativeReservation>>;
  /** Small accounting facts only. The journal still owns original response custody. */
  readonly commands: Readonly<Record<string, { readonly sequence: number; readonly command: NativeAccountingCommand }>>;
}

export function createNativeAccountingState(): NativeAccountingState {
  return snapshot({ schemaVersion: 1, ruleRevision: "native-accounting/1", revision: 0,
    works: {}, submissions: {}, registrations: {}, remoteWork: {}, observations: {}, reservations: {}, commands: {} });
}
function emptyContribution(): NativeUsageContribution {
  return snapshot({ revision: key("pending"), state: "pending", finality: null, observationIds: [], fields: {}, units: {}, components: [],
    inputField: null, outputField: null, cacheReadField: null, cacheWriteField: null, profileKey: null, issues: [] });
}
export function nativeWorkForSubmission(state: NativeAccountingState, submissionId: string): NativeWork {
  const work = state.works[state.submissions[key(submissionId)]!];
  if (!work) throw new TypeError("accounting_submission_missing");
  return work;
}
function validateSource(source: NativeModelSourceRef, work: NativeWork): void {
  snapshotNativeModelSource(source);
  if (!sameProtocolRef(source.protocol, work.origin.protocol) || !equal(source.scope, work.origin.scope))
    throw new TypeError("accounting_source_binding_mismatch");
  if (work.remote && (!source.nativeIdentity || !equal(source.nativeIdentity, work.remote)))
    throw new TypeError("accounting_remote_source_mismatch");
}
function reconcile(state: NativeAccountingState, ids: readonly string[]): NativeUsageContribution {
  const all = ids.map(id => {
    const command = state.commands[id]!.command;
    if (command.kind !== "observe") throw new TypeError("accounting_observation_index_invalid");
    return command.observation;
  });
  // Terminal facts dominate partial snapshots. Within a supported cumulative domain,
  // only its highest revision contributes; unrelated authorities are never ranked.
  const terminal = all.filter(observation => observation.finality === "terminal");
  const candidates = terminal.length ? terminal : all;
  const latest = new Map<string, number>();
  for (const observation of candidates) if (observation.cumulativeRevision !== null) {
    const domain = key([observation.authority, observation.revisionDomain]);
    latest.set(domain, Math.max(latest.get(domain) ?? 0, observation.cumulativeRevision));
  }
  const selected = candidates.filter(observation => observation.finality === "terminal" || observation.cumulativeRevision === null ||
    observation.cumulativeRevision === latest.get(key([observation.authority, observation.revisionDomain])));
  const interpreted = new Map(candidates.map(observation => [observation.id,
    projectNativeUsage({ protocol: observation.source.protocol, profile: observation.profile, usage: observation.usage })]));
  const projections = selected.map(observation => interpreted.get(observation.id)!);
  const first = projections[0]!;
  const profileConflict = projections.some(projection => !equal(projection.profile, first.profile));
  const fields: Record<string, NativeQuantity> = {}, units = first.units;
  for (const path of Object.keys(first.fields)) fields[path] = mergeNativeQuantities(projections.map(projection => projection.fields[path]!));
  const components = first.components.map(component => ({ ...component,
    quantity: mergeNativeQuantities(projections.map(projection => projection.components.find(value => value.id === component.id)?.quantity ??
      { state: "missing", reason: "component_mapping_conflict" })) }));
  const issues = [...new Set(projections.flatMap(projection => projection.issues))];
  if (profileConflict) issues.push("interpretation_profile_conflict");
  // Within one cumulative revision domain, a later partial snapshot cannot retract
  // established counters. Retain the contradiction even when the latest looks valid.
  if (!terminal.length) {
    const counters = new Map<string, { revision: number; value: number }>();
    for (const observation of [...candidates].filter(value => value.cumulativeRevision !== null).sort((a, b) => a.cumulativeRevision! - b.cumulativeRevision!)) {
      const projection = interpreted.get(observation.id)!;
      for (const path of [projection.inputField, projection.outputField, projection.cacheReadField, projection.cacheWriteField].filter((path): path is string => path !== null)) {
        const after = projection.fields[path], identity = key([observation.authority, observation.revisionDomain, path]), before = counters.get(identity);
        if (after?.state !== "known") continue;
        const sameRevisionConflict = before && observation.cumulativeRevision === before.revision && after.value !== before.value;
        if (before && (sameRevisionConflict || observation.cumulativeRevision! > before.revision && after.value < before.value)) {
          const issue = `${sameRevisionConflict ? "cumulative_revision_conflict" : "cumulative_regression"}:${path}`;
          if (!issues.includes(issue)) issues.push(issue);
          fields[path] = mergeNativeQuantities([{ state: "known", value: before.value }, after]);
          for (const component of components) if (component.formula.includes(path)) component.quantity = { state: "invalid", reason: issue };
        }
        if (!before || after.value > before.value) counters.set(identity, { revision: observation.cumulativeRevision!, value: after.value });
      }
    }
  }
  const conflicting = profileConflict || Object.values(fields).some(value => value.state === "conflicting" || value.state === "invalid") || issues.length > 0;
  const coreKnown = fields[first.inputField]?.state === "known" && fields[first.outputField]?.state === "known";
  const value = { state: conflicting ? "conflicting" as const : coreKnown ? "observed" as const : "missing" as const,
    finality: terminal.length ? "terminal" as const : "partial" as const,
    fields, units, components, inputField: first.inputField, outputField: first.outputField, cacheReadField: first.cacheReadField,
    cacheWriteField: first.cacheWriteField, profileKey: key(first.profile), issues };
  // Duplicate GET/stream evidence does not change the semantic settlement revision.
  return snapshot({ ...value, revision: key(value), observationIds: selected.map(value => value.id).sort() });
}

/** Persist this returned state atomically with its source facts and resource disposition.
 * No function here dispatches work, accepts task output, polls, or releases host resources. */
export function applyNativeAccountingCommand(state: NativeAccountingState, input: NativeAccountingCommand): NativeAccountingState {
  const command = snapshot(input), commandKey = key(command.id);
  requireText(command.id);
  const prior = state.commands[commandKey];
  if (prior) {
    if (!equal(prior.command, command)) throw new TypeError("accounting_command_identity_conflict");
    return state;
  }
  let works = { ...state.works }, submissions = { ...state.submissions }, registrations = { ...state.registrations }, remoteWork = { ...state.remoteWork },
    observations = { ...state.observations }, reservations = { ...state.reservations };
  const commands = { ...state.commands, [commandKey]: Object.freeze({ sequence: state.revision + 1, command }) };
  const working = (): NativeAccountingState => ({ ...state, works, submissions, registrations, remoteWork, observations, reservations, commands });
  const get = (id: string): NativeWork => nativeWorkForSubmission(working(), id);
  const put = (work: NativeWork): void => { works[work.id] = snapshot(work); };
  switch (command.kind) {
    case "register": {
      const submission = command.submission;
      for (const text of [submission.id, submission.account, submission.reconciliationOwner]) requireText(text);
      if(submission.endpoint!==null)requireText(submission.endpoint);
      snapshotModelInteractionProtocol(submission.protocol); snapshotModelInteractionScope(submission.scope);
      if(submission.submittedAt!==null)requireTime(submission.submittedAt);
      if (!["generation", "compact", "count", "read", "cancel", "file", "storage"].includes(submission.operation)) throw new TypeError("accounting_operation_invalid");
      for (const text of [submission.model, submission.requestedTier, submission.reportedTier, submission.region, submission.modality, submission.stage])
        if (text !== null) requireText(text);
      for (const beneficiary of submission.beneficiaries) requireText(beneficiary);
      if (new Set(submission.beneficiaries).size !== submission.beneficiaries.length) throw new TypeError("accounting_beneficiary_duplicate");
      if (submissions[key(submission.id)]) {
        const original = state.commands[registrations[key(submission.id)]!]!.command;
        if (original.kind !== "register" || !equal(original.submission, submission)) throw new TypeError("accounting_submission_identity_conflict");
        break;
      }
      const id = key(["submission", submission.id]);
      submissions[key(submission.id)] = id; registrations[key(submission.id)] = commandKey;
      put({ id, submissionIds: [submission.id], origin: submission, remote: null, observationCommands: [], contribution: emptyContribution(),
        reconciliationOwner: submission.reconciliationOwner, localReleased: false, exposure: "unresolved", settlement: null, costCalculations: [] });
      break;
    }
    case "bind_remote": {
      const work = get(command.submissionId);
      if(work.origin.endpoint===null)throw new TypeError("accounting_remote_endpoint_unknown");
      // A GET's target response is not the identity of that GET's own overhead.
      // Other operation families keep distinct submissions until a native work-ID
      // contract for that family is implemented, never dedup by the target object.
      if (!["generation", "compact"].includes(work.origin.operation)) throw new TypeError("accounting_remote_work_identity_unsupported");
      requireText(command.remote.id); requireText(command.remote.kind); validateSource(command.evidence, work);
      if (!equal(command.evidence.nativeIdentity, command.remote)) throw new TypeError("accounting_remote_identity_evidence_required");
      if (work.remote && !equal(work.remote, command.remote)) throw new TypeError("accounting_remote_identity_conflict");
      for (const id of work.observationCommands) {
        const observation = state.commands[id]!.command;
        if (observation.kind === "observe" && observation.observation.source.nativeIdentity !== null &&
            !equal(observation.observation.source.nativeIdentity, command.remote)) throw new TypeError("accounting_observed_remote_identity_conflict");
      }
      const remoteKey = key([work.origin.protocol, work.origin.endpoint, work.origin.account, work.origin.operation, command.remote]);
      const existing = remoteWork[remoteKey] ? works[remoteWork[remoteKey]!] : null;
      if (existing && existing.id !== work.id) {
        if (!equal(existing.origin.scope, work.origin.scope) || existing.reconciliationOwner !== work.reconciliationOwner ||
            existing.settlement && work.settlement)
          throw new TypeError("accounting_merge_requires_owner_reconciliation");
        if (["model", "reportedTier", "region", "modality"].some(field =>
          !equal(existing.origin[field as keyof NativeWorkSubmission], work.origin[field as keyof NativeWorkSubmission])))
          throw new TypeError("accounting_merge_binding_conflict");
        const ids = [...existing.observationCommands, ...work.observationCommands];
        const contribution = ids.length ? reconcile(working(), ids) : emptyContribution();
        const settlement = existing.settlement ?? work.settlement;
        const combinedIds = [...existing.submissionIds, ...work.submissionIds].sort();
        const held = Object.values(reservations).some(reservation => reservation.status === "held" && combinedIds.includes(reservation.submissionId));
        const merged = { ...existing, submissionIds: [...existing.submissionIds, ...work.submissionIds].sort(),
          observationCommands: ids, contribution, settlement,
          exposure: settlement?.contributionRevision === contribution.revision && !held ? "reconciled" as const : "unresolved" as const,
          costCalculations: [...existing.costCalculations, ...work.costCalculations],
          localReleased: existing.localReleased && work.localReleased };
        for (const id of work.submissionIds) submissions[key(id)] = existing.id;
        delete works[work.id]; put(merged);
      } else { remoteWork[remoteKey] = work.id; put({ ...work, remote: command.remote }); }
      break;
    }
    case "observe": {
      const observation = command.observation, work = get(observation.submissionId);
      for (const text of [observation.id, observation.authority, observation.revisionDomain]) requireText(text);
      if(observation.receivedAt!==null)requireTime(observation.receivedAt);
      if(observation.work){
        const work=observation.work;
        if(work.startedAt!==null)requireTime(work.startedAt);
        if(work.completedAt!==null)requireTime(work.completedAt);
        if(work.reportedTier!==null)requireText(work.reportedTier);
        if(work.startedAt!==null&&work.completedAt!==null&&Date.parse(work.completedAt)<Date.parse(work.startedAt))
          throw new TypeError("accounting_observation_work_time_invalid");
      }
      validateSource(observation.source, work);
      if (!["create", "stream", "get", "recovery"].includes(observation.channel) || !["partial", "terminal"].includes(observation.finality))
        throw new TypeError("accounting_observation_invalid");
      if (observation.cumulativeRevision !== null) requireSequence(observation.cumulativeRevision);
      const priorObservation = observations[key(observation.id)];
      if (priorObservation) {
        const original = state.commands[priorObservation]!.command;
        if (original.kind !== "observe" || !equal(original.observation, observation)) throw new TypeError("accounting_observation_identity_conflict");
        break;
      }
      projectNativeUsage({ protocol: work.origin.protocol, profile: observation.profile, usage: observation.usage });
      observations[key(observation.id)] = commandKey;
      const ids = [...work.observationCommands, commandKey], contribution = reconcile(working(), ids);
      put({ ...work, observationCommands: ids, contribution,
        exposure: work.settlement && work.settlement.contributionRevision !== contribution.revision ? "unresolved" : work.exposure });
      break;
    }
    case "record_cost": {
      const work = get(command.submissionId), calculation = command.calculation;
      const previous = work.costCalculations.find(value => equal(value.calculation, calculation.calculation));
      if (previous) {
        if (!equal(previous, calculation)) throw new TypeError("accounting_calculation_identity_conflict");
        break;
      }
      const expected = calculateNativeCost({ work, calculation: calculation.calculation, context: calculation.context,
        decisionAt: calculation.decisionAt, rates: calculation.rateBases, additional: calculation.additional, chargeCoverage: calculation.chargeCoverage });
      if (!equal(expected, calculation)) throw new TypeError("accounting_calculation_basis_mismatch");
      put({ ...work, costCalculations: [...work.costCalculations, calculation] });
      break;
    }
    case "reserve": {
      const reservation = command.reservation, work = get(reservation.submissionId);
      for (const text of [reservation.id, reservation.resource, reservation.unit]) requireText(text);
      nonnegativeDecimal(reservation.amount); snapshotProtocolRevisionRef(reservation.admissionBasis);
      const previous = reservations[key(reservation.id)];
      if (previous) {
        const { status: _status, disposition: _disposition, ...original } = previous;
        if (!equal(original, reservation)) throw new TypeError("accounting_reservation_identity_conflict");
        break;
      }
      if (!["estimate", "enforceable_bound"].includes(reservation.guarantee) || work.settlement || work.exposure !== "unresolved")
        throw new TypeError("accounting_reservation_invalid");
      reservations[key(reservation.id)] = snapshot({ ...reservation, status: "held", disposition: null });
      break;
    }
    case "release_local": {
      const work = get(command.submissionId); snapshotProtocolRevisionRef(command.basis);
      put({ ...work, localReleased: true }); break;
    }
    case "handoff": {
      const work = get(command.submissionId); snapshotProtocolRevisionRef(command.basis); requireText(command.nextOwner);
      if (command.expectedOwner !== work.reconciliationOwner) throw new TypeError("accounting_owner_conflict");
      put({ ...work, reconciliationOwner: command.nextOwner }); break;
    }
    case "settle": case "dispose": {
      const work = get(command.submissionId); snapshotProtocolRevisionRef(command.basis);
      if (command.owner !== work.reconciliationOwner) throw new TypeError("accounting_owner_conflict");
      if (command.kind === "settle" && (command.contributionRevision !== work.contribution.revision || work.contribution.finality !== "terminal" ||
          work.contribution.state !== "observed" || work.contribution.components.some(component => !["known", "not_applicable"].includes(component.quantity.state))))
        throw new TypeError("accounting_settlement_evidence_incomplete");
      if (command.kind === "settle" && work.settlement?.contributionRevision === command.contributionRevision)
        throw new TypeError("accounting_settlement_already_committed");
      if (new Set(command.reservationIds).size !== command.reservationIds.length) throw new TypeError("accounting_reservation_duplicate");
      const held = Object.values(reservations).filter(reservation => reservation.status === "held" && work.submissionIds.includes(reservation.submissionId));
      if (held.length !== command.reservationIds.length || held.some(reservation => !command.reservationIds.includes(reservation.id)))
        throw new TypeError("accounting_reservation_disposition_incomplete");
      for (const id of command.reservationIds) {
        const reservation = reservations[key(id)];
        if (!reservation || get(reservation.submissionId).id !== work.id || reservation.status !== "held")
          throw new TypeError("accounting_reservation_disposition_conflict");
        reservations[key(id)] = snapshot({ ...reservation, status: command.kind === "settle" ? "reconciled" : "owner_disposed", disposition: command.basis });
      }
      put({ ...work, exposure: command.kind === "settle" ? "reconciled" : "owner_disposed",
        settlement: command.kind === "settle" ? { id: command.id, contributionRevision: command.contributionRevision, basis: command.basis } : work.settlement });
      break;
    }
    default: throw new TypeError("accounting_command_invalid");
  }
  return Object.freeze({ ...state, revision: state.revision + 1, works: Object.freeze(works), submissions: Object.freeze(submissions), registrations: Object.freeze(registrations),
    remoteWork: Object.freeze(remoteWork), observations: Object.freeze(observations), reservations: Object.freeze(reservations), commands: Object.freeze(commands) });
}

/** Cold restore validates facts and rebuilds indexes, not just a stored digest. */
export function restoreNativeAccountingState(value: unknown): NativeAccountingState {
  const saved = snapshot(value) as NativeAccountingState;
  if (!saved || saved.schemaVersion !== 1 || saved.ruleRevision !== "native-accounting/1" || !saved.commands)
    throw new TypeError("accounting_state_version_invalid");
  let rebuilt = createNativeAccountingState();
  for (const receipt of Object.values(saved.commands).sort((a, b) => a.sequence - b.sequence)) {
    if (receipt.sequence !== rebuilt.revision + 1) throw new TypeError("accounting_command_sequence_invalid");
    rebuilt = applyNativeAccountingCommand(rebuilt, receipt.command);
  }
  if (!equal(saved, rebuilt)) throw new TypeError("accounting_state_integrity_invalid");
  return rebuilt;
}
