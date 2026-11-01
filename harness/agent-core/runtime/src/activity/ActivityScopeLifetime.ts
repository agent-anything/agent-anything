import type {ActivityFactSource} from "./ActivityReconsideration.js";

/** The execution owner publishes the end; observing it never cancels another owner's work. */
export interface ActivityScopeLifetime {
  readonly source:ActivityFactSource;
  readonly closedFactId:string;
}
