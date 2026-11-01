import type {AgentDefinition} from "@agent-anything/agent-core/agent";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {TaskDecisionInputSources} from "./TaskDecisionActivity.js";
import {TaskResponseBindingError} from "./TaskResponseBindingError.js";
import {assertControllerCheckpointValue} from "../activity/ActivityCheckpointValue.js";

export interface TaskDecisionSourceRecord {
  readonly id:string;
  readonly version:1;
  readonly source:Omit<TaskDecisionInputSources,"agent"> & {readonly agent:Omit<AgentDefinition,"output">};
}

/** Data belongs to the original decision; executable validation is rebound by exact Agent identity. */
export function retainTaskDecisionSource(source:TaskDecisionInputSources):TaskDecisionSourceRecord {
  const {output:_,...agent}=source.agent;
  const body={version:1 as const,source:structuredClone({...source,agent})};
  const record={id:`task-source:${modelInputValueDigest(body)}`,...body};
  validateTaskDecisionSource(record);
  return record;
}
export function validateTaskDecisionSource(record:TaskDecisionSourceRecord):void {
  assertControllerCheckpointValue(record);
  if(record?.version!==1||!record.source?.runId||!record.source.toolExposure?.controllerRequestId||
    !record.source.agent?.id||!record.source.agent.revision||"output" in record.source.agent||
    record.id!==`task-source:${modelInputValueDigest({version:record.version,source:record.source})}`)
    throw new TaskResponseBindingError("task_decision_source_binding_invalid");
}
export function restoreTaskDecisionSource<T>(record:TaskDecisionSourceRecord,agent:AgentDefinition<T>):TaskDecisionInputSources<T> {
  validateTaskDecisionSource(record);
  const {output:_,...definition}=agent;
  if(typeof agent.output?.validate!=="function"||modelInputValueDigest(definition)!==modelInputValueDigest(record.source.agent))
    throw new TaskResponseBindingError("task_decision_original_agent_unavailable");
  return {...structuredClone(record.source),agent};
}
