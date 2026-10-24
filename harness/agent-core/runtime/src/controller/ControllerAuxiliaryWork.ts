import type {ControllerCallContext} from "./Controller.js";

export interface ControllerAuxiliaryRegistration {
  readonly id: string;
  readonly binding: string;
  readonly deadlineAt: string;
}
export interface ControllerAuxiliaryRecord extends ControllerAuxiliaryRegistration {
  readonly authority: string;
  readonly status: "registered" | "completed" | "failed" | "cancelled";
  readonly failure: string | null;
}
/** No decision, input-consumption or effect-dispatch port is supplied to auxiliary work. */
export interface ControllerAuxiliaryWorkPort {
  current(): ControllerAuxiliaryRecord | null;
  read(id: string): ControllerAuxiliaryRecord | null;
  start(registration: ControllerAuxiliaryRegistration, execute: (context: ControllerCallContext) => Promise<void>): Promise<boolean>;
  wait(id: string): Promise<void>;
}
