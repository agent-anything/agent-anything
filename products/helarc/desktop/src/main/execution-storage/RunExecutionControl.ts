/** Current authoritative control, without returning history or executable services. */
export interface RunExecutionControl {
  readonly runId: string;
  readonly commitId: string;
  readonly revision: number;
  readonly cancelled: boolean;
  readonly terminal: boolean;
}
