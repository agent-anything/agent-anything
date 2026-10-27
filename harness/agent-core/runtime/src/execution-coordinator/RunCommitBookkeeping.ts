/** Technical commits have no business payload or state patch. Runtime owns admission. */
export type RunCommitBookkeeping = string | null | {
  readonly kind: "auxiliary";
  readonly invocationId: string;
};
