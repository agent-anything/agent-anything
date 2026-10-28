export interface SharedAcceptancePart {
  readonly owner: string;
  readonly kind: string;
  readonly proposal: unknown;
}
export interface SharedAcceptanceProposal {
  readonly id: string;
  readonly scope: string;
  readonly actor: string;
  readonly parts: readonly SharedAcceptancePart[];
}
export interface SharedAcceptanceReceipt {
  readonly id: string;
  readonly digest: string;
  readonly sequence: number;
  readonly scope: string;
  readonly outcome: "accepted" | "rejected";
  readonly rejection: {readonly owner: string; readonly code: string} | null;
}
export interface SharedAcceptancePort {
  accept(proposal: SharedAcceptanceProposal): Promise<SharedAcceptanceReceipt>;
  query(id: string): Promise<SharedAcceptanceReceipt | null>;
}
