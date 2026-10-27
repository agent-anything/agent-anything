import type {OperationBindingRevisionRef,OperationDefinitionRevisionRef} from "@agent-anything/operation-catalog/identity";
export const HELARC_SHELL_OPERATION: OperationDefinitionRevisionRef = Object.freeze({
  operation: Object.freeze({ namespace: "helarc", name: "shell-execute" }), revision: "4",
});
export const HELARC_SHELL_BINDING: OperationBindingRevisionRef = Object.freeze({ operation: HELARC_SHELL_OPERATION, revision: "4" });
export const HELARC_PROCESS_START_OPERATION = Object.freeze({operation:{namespace:"helarc",name:"process-start"},revision:"1"});
export const HELARC_PROCESS_START_BINDING = Object.freeze({operation:HELARC_PROCESS_START_OPERATION,revision:"1"});
export const HELARC_INITIAL_OBSERVATION_OPERATION = Object.freeze({operation:{namespace:"helarc",name:"process-initial-observation"},revision:"2"});
export const HELARC_INITIAL_OBSERVATION_BINDING = Object.freeze({operation:HELARC_INITIAL_OBSERVATION_OPERATION,revision:"2"});
export const HELARC_COMMAND_OBSERVE_OPERATION = Object.freeze({operation:{namespace:"helarc",name:"command-observe"},revision:"1"});
export const HELARC_COMMAND_OBSERVE_BINDING = Object.freeze({operation:HELARC_COMMAND_OBSERVE_OPERATION,revision:"1"});
export const HELARC_INITIAL_OBSERVATION_HANDLER = "helarc.process.initial-observation";
export const HELARC_COMMAND_OBSERVE_HANDLER = "helarc.process.observe";
export const HELARC_SHELL_COMPOSITE = "helarc.shell.start-and-observe.v2";
export const HELARC_TASK_STOP_OPERATION: OperationDefinitionRevisionRef = Object.freeze({
  operation: Object.freeze({ namespace: "helarc", name: "task-stop" }), revision: "2",
});
export const HELARC_TASK_STOP_BINDING: OperationBindingRevisionRef = Object.freeze({ operation: HELARC_TASK_STOP_OPERATION, revision: "2" });
