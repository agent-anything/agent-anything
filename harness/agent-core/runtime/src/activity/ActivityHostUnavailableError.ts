/** A local execution interruption, not a task result or a remote-attempt outcome. */
export class ActivityHostUnavailableError extends Error {
  constructor(readonly reason:"closing"|"closed"|"failed",options?:ErrorOptions) {
    super(`Activity Host is ${reason}; original execution progress remains retained.`,options);
    this.name="ActivityHostUnavailableError";
  }
}
