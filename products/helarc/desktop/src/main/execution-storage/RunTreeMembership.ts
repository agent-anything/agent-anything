/** Observation cursor only; never an execution or recovery authorization. */
export interface RunTreeMembershipCursor {
  readonly rootRunId: string;
  readonly through: number;
  readonly after: number;
}

export interface RunTreeMembershipPage {
  readonly runIds: readonly string[];
  readonly next: RunTreeMembershipCursor | null;
}
