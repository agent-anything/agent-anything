import {processOutputViewSegments, type ProcessCheckpoint, type ProcessOutputMaterialView} from "@agent-anything/helarc-local-environment/command";
import type {ContextMaterialDescription} from "@agent-anything/context/material";

export function projectProcessOutputMaterial(checkpoint: ProcessCheckpoint<unknown>, view: ProcessOutputMaterialView) {
  if (!checkpoint.output) throw new Error("Output material capture is unavailable.");
  const description: ContextMaterialDescription = {
    reference:view.reference,originRunId:checkpoint.input.runId,
    source:{owner:"helarc-command",kind:"command_output",id:checkpoint.input.executionId,revision:view.reference.revision},
    label:`${view.stream} of command ${checkpoint.input.executionId}`,role:"data",position:checkpoint.revision,
    bytes:view.bytes,format:"text",relationships:[{kind:"execution",id:checkpoint.input.executionId},{kind:"stream",id:view.stream}],
    limitations:["frozen_captured_text_prefix","not_a_command_success_assessment",`encoding:${view.encoding ?? "unknown"}`,`integrity:${view.integrity}`,
      `capture:${view.capture}`,`source_capture_persistence:${view.capturePersistence}`,`omitted_raw_bytes:${view.omittedBytes}`,...(view.projectionPending ? ["decoder_tail_not_in_view"] : [])],
  };
  return {description,texts:processOutputViewSegments(checkpoint.output,view,checkpoint.input.runId)};
}
