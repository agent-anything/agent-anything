import type {OperationBindingRevisionRef,OperationRevisionRef} from "@agent-anything/operation-catalog/identity";
export const HELARC_SHELL_OPERATION: OperationRevisionRef = Object.freeze({
  operation: Object.freeze({ namespace: "helarc", name: "shell-execute" }), revision: "3",
});
export const HELARC_SHELL_BINDING: OperationBindingRevisionRef = Object.freeze({ operation: HELARC_SHELL_OPERATION, revision: "3" });
export const HELARC_PROCESS_START_OPERATION = Object.freeze({operation:{namespace:"helarc",name:"process-start"},revision:"1"});
export const HELARC_PROCESS_START_BINDING = Object.freeze({operation:HELARC_PROCESS_START_OPERATION,revision:"1"});
export const HELARC_INITIAL_OBSERVATION_OPERATION = Object.freeze({operation:{namespace:"helarc",name:"process-initial-observation"},revision:"1"});
export const HELARC_INITIAL_OBSERVATION_BINDING = Object.freeze({operation:HELARC_INITIAL_OBSERVATION_OPERATION,revision:"1"});
export const HELARC_TASK_OUTPUT_OPERATION = Object.freeze({operation:{namespace:"helarc",name:"task-output"},revision:"1"});
export const HELARC_TASK_OUTPUT_BINDING = Object.freeze({operation:HELARC_TASK_OUTPUT_OPERATION,revision:"1"});
export const HELARC_INITIAL_OBSERVATION_HANDLER = "helarc.process.initial-observation";
export const HELARC_TASK_OUTPUT_HANDLER = "helarc.process.output";
export const HELARC_SHELL_COMPOSITE = "helarc.shell.start-and-observe.v1";
export const HELARC_TASK_STOP_OPERATION: OperationRevisionRef = Object.freeze({
  operation: Object.freeze({ namespace: "helarc", name: "task-stop" }), revision: "2",
});
export const HELARC_TASK_STOP_BINDING: OperationBindingRevisionRef = Object.freeze({ operation: HELARC_TASK_STOP_OPERATION, revision: "2" });
