import type {ToolJsonObject} from "@agent-anything/tools/catalog";
const text={type:"string"};
const number={type:"number",minimum:0};
const integer={type:"integer",minimum:0};
const nullable=(value:ToolJsonObject):ToolJsonObject=>({anyOf:[value,{type:"null"}]});
const object=(properties:Record<string,ToolJsonObject>):ToolJsonObject=>({type:"object",additionalProperties:false,required:Object.keys(properties),properties});
const stream=object({text,encoding:nullable(text),encoding_source:{enum:["utf8","bom","detected","fallback","none"]},
  integrity:{enum:["exact","inferred","lossy","unavailable"]},replacement_count:integer,byte_start:integer,byte_end:integer,
  received_bytes:integer,omitted_bytes:integer,projection_pending:{type:"boolean"},segments:{type:"array",items:object({byteStart:integer,byteEnd:integer,decoderInputStart:integer,text})}});
export const HELARC_PROCESS_WAIT_SCHEMA:ToolJsonObject={anyOf:[{const:0},{type:"integer",minimum:1000,maximum:30000}],default:10000};
export const HELARC_PROCESS_OBSERVATION_SCHEMA:ToolJsonObject=object({
  task_id:text,run_id:text,observation_id:text,invocation_id:text,snapshot_revision:integer,action_id:text,
  phase:{enum:["starting","running","stopping","draining","settled","unresolved"]},
  outcome:nullable({enum:["succeeded","failed","cancelled","timed_out","unknown"]}),
  requested_wait_ms:integer,effective_wait_ms:integer,elapsed_wait_ms:number,
  return_reason:{enum:["initial_wait_limit","observation_wait_limit","immediate_snapshot","output_available","lifecycle_changed","process_settled"]},
  stdout:stream,stderr:stream,next_cursor:text,has_more:{type:"boolean"},process_id:nullable(integer),helper_process_id:nullable(integer),
  started_at:nullable(text),finished_at:nullable(text),deadline_at:nullable(text),
  root_exit:nullable(object({code:nullable({type:"integer"}),signal:nullable(text),observedAt:text})),
  termination:nullable(object({reason:{enum:["model_stop","run_cancelled","execution_timeout","run_deadline","run_finalization","host_shutdown","backend_failure"]},requestedAt:text,method:{enum:["graceful","forced","none"]}})),
  containment:object({disposition:{enum:["active","empty","unknown"]},confirmedAt:nullable(text),kind:{enum:["windows_job","posix_process_group"]}}),
  output:object({capture:{enum:["open","closed","incomplete"]},persistence:{enum:["pending","complete","failed"]},retainedBytes:integer,omittedBytes:nullable(integer)}),
  initial_cwd:text,final_cwd:nullable(text),session_cwd:nullable(text),cwd_disposition:{enum:["eligible","committed","unchanged","detached","unavailable"]},
  limitations:{type:"array",items:text},
});
