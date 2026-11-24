import { custodyToken, MaterialCustodyError, containsMaterialRange, type MaterialRange, type MaterialRecipient } from "./MaterialCustody.js";

export interface MaterialDispositionRef { readonly id: string; readonly revision: string; }
export interface MaterialDeliveryContract {
  readonly ref: MaterialDispositionRef;
  readonly owner: string;
  /** An owner-defined confirmation point, not necessarily a model-input receipt. */
  readonly confirmation: string;
}
export interface MaterialDeliveryObligation {
  readonly ref: MaterialDispositionRef;
  readonly contract: MaterialDeliveryContract;
  readonly recipient: MaterialRecipient;
  readonly range: MaterialRange;
  readonly holdId: string;
}
export type MaterialDeliveryDisposition = {
  readonly obligation: MaterialDispositionRef;
  readonly contract: MaterialDispositionRef;
} & (
  | { readonly kind: "fulfilled"; readonly receipt: MaterialDispositionRef }
  | { readonly kind: "non_delivery"; readonly authorization: MaterialDispositionRef; readonly inFlightResolution: MaterialDispositionRef }
  | { readonly kind: "transferred"; readonly acceptance: MaterialDispositionRef; readonly range: MaterialRange; readonly successor: MaterialDeliveryObligation }
);

/** Discharge evidence addresses one hold; it is never permission for physical deletion. */
export interface MaterialHoldDischarge {
  readonly holdId: string;
  readonly range: MaterialRange;
  readonly disposition: MaterialDispositionRef;
}
export interface MaterialDeliveryDispositionRequest {
  readonly ref: MaterialDispositionRef;
  readonly expectedObligation: MaterialDeliveryObligation;
  readonly expectedSelectionRevision: string;
  readonly disposition: MaterialDeliveryDisposition;
}
export interface MaterialDeliveryDispositionAcceptance {
  readonly request: MaterialDispositionRef;
  readonly accepted: MaterialDispositionRef;
  readonly disposition: MaterialDeliveryDisposition;
  readonly discharged: readonly MaterialHoldDischarge[];
}
export interface MaterialDeliveryDispositionPort {
  /** Reusing a request identity with changed content must fail, not replace the original acceptance. */
  accept(request: MaterialDeliveryDispositionRequest): Promise<MaterialDeliveryDispositionAcceptance>;
  /** Query by the original request identity, including when the acceptance acknowledgment was lost. */
  readAccepted(request: MaterialDispositionRef): Promise<MaterialDeliveryDispositionAcceptance | null>;
}

/** The contract owner supplies semantic evidence; storage checks identity and protected responsibility. */
export interface MaterialDeliveryEvidence {
  readonly ref:MaterialDispositionRef;
  readonly obligation:MaterialDispositionRef;
  readonly kind:"receipt"|"authorization"|"in_flight_resolution";
  readonly basis:MaterialDispositionRef;
}
export interface MaterialDeliveryGuard {
  readonly revision:string;
  readonly active:boolean;
}
export interface MaterialDeliveryState {
  readonly obligation:MaterialDeliveryObligation;
  readonly accepted:MaterialDispositionRef;
  readonly discharged:readonly MaterialRange[];
  readonly inboundHandoff:string|null;
  readonly handoffAcknowledged:boolean;
  readonly protection:{readonly revision:number;readonly selected:boolean;readonly inFlight:"none"|"pending"|"unknown";readonly basis:MaterialDispositionRef};
}
export interface MaterialDeliveryTransferReceipt {
  readonly id:string;
  readonly sourceStore:string;
  readonly source:MaterialDeliveryObligation;
  readonly receiverStore:string;
  readonly successor:MaterialDeliveryObligation;
  readonly accepted:MaterialDispositionRef;
}
export type MaterialDeliveryPart={readonly owner:"material_delivery"}&(
  | {readonly kind:"register";readonly proposal:{readonly obligation:MaterialDeliveryObligation;readonly handoff:Omit<MaterialDeliveryTransferReceipt,"accepted">|null}}
  | {readonly kind:"evidence";readonly proposal:MaterialDeliveryEvidence}
  | {readonly kind:"protect";readonly proposal:{readonly obligation:MaterialDispositionRef;readonly expectedRevision:number;readonly selected:boolean;readonly inFlight:"none"|"pending"|"unknown";readonly basis:MaterialDispositionRef}}
  | {readonly kind:"disposition";readonly proposal:MaterialDeliveryDispositionRequest}
  | {readonly kind:"import_transfer";readonly proposal:MaterialDeliveryTransferReceipt}
  | {readonly kind:"acknowledge_transfer";readonly proposal:{readonly id:string;readonly sourceAcceptance:MaterialDispositionRef}}
);
export type MaterialDeliveryQuery=
  | {readonly kind:"store_identity"}
  | {readonly kind:"pending_page";readonly owner:string;readonly after:string|null;readonly limit:number}
  | {readonly kind:"receipt_page";readonly obligation:MaterialDispositionRef;readonly after:string|null;readonly limit:number}
  | {readonly kind:"disposition_page";readonly obligation:MaterialDispositionRef;readonly after:string|null;readonly limit:number}
  | {readonly kind:"obligation";readonly ref:MaterialDispositionRef}
  | {readonly kind:"guard";readonly ref:MaterialDispositionRef}
  | {readonly kind:"accepted";readonly ref:MaterialDispositionRef}
  | {readonly kind:"transfer";readonly id:string};
export interface MaterialDeliveryPage<T> {readonly entries:readonly T[];readonly next:string|null;}
export type MaterialDeliveryValue=string|MaterialDeliveryState|MaterialDeliveryGuard|MaterialDeliveryDispositionAcceptance|MaterialDeliveryTransferReceipt|
  MaterialDeliveryPage<MaterialDeliveryState>|MaterialDeliveryPage<MaterialDeliveryEvidence>|MaterialDeliveryPage<MaterialDeliveryDispositionAcceptance>|null;
export interface MaterialDeliveryJournal {query(query:MaterialDeliveryQuery):Promise<MaterialDeliveryValue>;}

function ref(value: MaterialDispositionRef): MaterialDispositionRef {
  record(value, ["id", "revision"]); custodyToken(value.id); custodyToken(value.revision);
  return Object.freeze({ id: value.id, revision: value.revision });
}
function record(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length ||
      Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, d]) => !keys.includes(key) || !d.enumerable || !("value" in d)))
    throw new MaterialCustodyError("material_delivery_contract_invalid");
}
function equal(a: MaterialDispositionRef, b: MaterialDispositionRef): boolean { return a.id === b.id && a.revision === b.revision; }

export function snapshotMaterialDeliveryObligation(value: MaterialDeliveryObligation): MaterialDeliveryObligation {
  record(value, ["ref", "contract", "recipient", "range", "holdId"]);
  record(value.contract, ["ref", "owner", "confirmation"]);
  record(value.recipient, ["runId", "recipient", "purpose"]);
  record(value.range, ["materialId", "version", "start", "end", "coordinate"]);
  [value.contract.owner, value.contract.confirmation, value.holdId, value.recipient.runId, value.recipient.recipient,
    value.recipient.purpose, value.range.materialId, value.range.version].forEach(custodyToken);
  if (value.range.coordinate !== "bytes" || !Number.isSafeInteger(value.range.start) || !Number.isSafeInteger(value.range.end) || value.range.start < 0 || value.range.end < value.range.start)
    throw new MaterialCustodyError("material_delivery_range_invalid");
  return Object.freeze({ ref: ref(value.ref), contract: Object.freeze({ ...value.contract, ref: ref(value.contract.ref) }),
    recipient: Object.freeze({ ...value.recipient }), range: Object.freeze({ ...value.range }), holdId: value.holdId });
}

/** Structural checks only; the accepting owner must check authority, durability and in-flight work. */
export function snapshotMaterialDeliveryDisposition(obligation: MaterialDeliveryObligation, value: MaterialDeliveryDisposition): MaterialDeliveryDisposition {
  const original = snapshotMaterialDeliveryObligation(obligation);
  record(value, ["kind", "obligation", "contract", "receipt", "authorization", "inFlightResolution", "acceptance", "range", "successor"]);
  const basis = { obligation: ref(value.obligation), contract: ref(value.contract) };
  if (!equal(original.ref, basis.obligation) || !equal(original.contract.ref, basis.contract)) throw new MaterialCustodyError("material_delivery_basis_mismatch");
  switch (value.kind) {
    case "fulfilled":
      record(value, ["kind", "obligation", "contract", "receipt"]);
      return Object.freeze({ ...basis, kind: "fulfilled", receipt: ref(value.receipt) });
    case "non_delivery":
      record(value, ["kind", "obligation", "contract", "authorization", "inFlightResolution"]);
      return Object.freeze({ ...basis, kind: "non_delivery", authorization: ref(value.authorization), inFlightResolution: ref(value.inFlightResolution) });
    case "transferred": {
      record(value, ["kind", "obligation", "contract", "acceptance", "range", "successor"]);
      const successor = snapshotMaterialDeliveryObligation(value.successor);
      const range = snapshotMaterialDeliveryObligation({ ...original, range: value.range }).range;
      if (successor.ref.id === original.ref.id || successor.holdId === original.holdId ||
          !containsMaterialRange(original.range, range) || !containsMaterialRange(successor.range, range))
        throw new MaterialCustodyError("material_delivery_transfer_invalid");
      return Object.freeze({ ...basis, kind: "transferred", acceptance: ref(value.acceptance), range, successor });
    }
    default: throw new MaterialCustodyError("material_delivery_disposition_invalid");
  }
}
