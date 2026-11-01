import type {ActivityScopeLifetime} from "@agent-anything/agent-runtime/activity";

export function runActivityLifetime(runId:string):ActivityScopeLifetime {
  const id=`run-lifetime:${runId}`;
  return {source:{id,runId,owner:"runtime"},closedFactId:`${id}:closed`};
}
