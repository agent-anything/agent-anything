import type {ContextUseScope} from "@agent-anything/context/selection";
import type {ContextRecipientInputReadiness} from "./ContextPreparationPolicy.js";

/** Cross-owner reception identity; its professional path owns the private input construction. */
export interface ContextInputReceptionBinding {
  readonly revision:"1"|"2";
  readonly pathId:string;
  readonly workId:string;
  readonly scope:ContextUseScope;
  readonly boundary:string;
  readonly requirementsDigest:string;
  readonly members:readonly {readonly pathId:string;readonly workId:string;readonly requestDigest:string}[];
  /** Revision 2 binds a receiving arrangement without claiming a completed producer. */
  readonly sourceInput?:ContextRecipientInputReadiness;
}
