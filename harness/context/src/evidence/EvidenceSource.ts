export interface EvidenceSource {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EvidenceSettlementRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

/** Bounded, owner-attributed material offered to Context after semantic settlement. */
export interface EvidenceContribution<TContent = unknown> {
  readonly source: EvidenceSource;
  readonly settlementRefs: readonly [
    EvidenceSettlementRef,
    ...EvidenceSettlementRef[],
  ];
  readonly usability: "complete" | "partial_validated";
  readonly summary: string;
  readonly content: TContent;
  readonly metadata: Readonly<Record<string, unknown>>;
}
