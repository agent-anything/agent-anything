import {modelInputValueDigest} from "@agent-anything/model-interaction/input";

export interface ActivityPurposeRef {readonly id: string; readonly revision: string;}
export interface ActivityPurposeContract {
  readonly ref: ActivityPurposeRef;
  readonly inputOwner: string;
  readonly executionOwner: string;
  readonly interpretationOwner: string;
  readonly acceptanceOwner: string;
  readonly recoveryOwner: string;
  readonly stageKinds: readonly string[];
  readonly capabilities: readonly string[];
  readonly continuationKinds: readonly string[];
}
export interface ActivityPurposeBinding {
  readonly contract: ActivityPurposeContract;
  readonly digest: string;
}

/** Only trusted host registration supplies handlers; persisted bindings contain no closures. */
export class ActivityPurposeRegistry<THandler> {
  private readonly entries = new Map<string, {binding: ActivityPurposeBinding; handler: THandler}>();

  register(contract: ActivityPurposeContract, handler: THandler): ActivityPurposeBinding {
    validateActivityPurpose(contract);
    const key = purposeKey(contract.ref);
    if (this.entries.has(key)) throw new TypeError("activity_purpose_already_registered");
    const binding = {contract: structuredClone(contract), digest: modelInputValueDigest(contract)};
    this.entries.set(key, {binding, handler});
    return structuredClone(binding);
  }

  resolve(binding: ActivityPurposeBinding): THandler {
    validateActivityPurpose(binding.contract);
    const entry = this.entries.get(purposeKey(binding.contract.ref));
    if (!entry || entry.binding.digest !== binding.digest || modelInputValueDigest(binding.contract) !== binding.digest) {
      throw new TypeError("activity_purpose_binding_unavailable");
    }
    return entry.handler;
  }
}

export function validateActivityPurpose(value: ActivityPurposeContract): void {
  activityToken(value.ref?.id); activityToken(value.ref?.revision);
  for (const owner of [value.inputOwner, value.executionOwner, value.interpretationOwner, value.acceptanceOwner, value.recoveryOwner]) activityToken(owner);
  for (const list of [value.stageKinds, value.capabilities, value.continuationKinds]) {
    if (!Array.isArray(list) || list.length > 128 || new Set(list).size !== list.length) throw new TypeError("activity_purpose_invalid");
    list.forEach(activityToken);
  }
  if (!value.stageKinds.length) throw new TypeError("activity_purpose_invalid");
}

export function activityToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 2048) throw new TypeError("activity_identity_invalid");
}
export function activityCount(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new TypeError("activity_bound_invalid");
}
function purposeKey(ref: ActivityPurposeRef): string {return JSON.stringify([ref.id, ref.revision]);}
