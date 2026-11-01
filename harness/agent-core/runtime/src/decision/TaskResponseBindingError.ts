/** Host interpretation dependencies are missing or inconsistent, not malformed model output. */
export class TaskResponseBindingError extends TypeError {
  constructor(readonly code:string,options?:ErrorOptions) {
    super(code,options);this.name="TaskResponseBindingError";
  }
}
