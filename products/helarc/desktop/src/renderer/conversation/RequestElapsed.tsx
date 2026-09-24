import * as React from "react";
import { Clock3 } from "lucide-react";
import type { HelarcMainSnapshot } from "../../shared/HelarcDesktopApi.js";
import { ElapsedTime } from "../workbench/ElapsedTime.js";

export function RequestElapsed({ snapshot, submissionStartedAt, newConversation, visible }: {
  snapshot: HelarcMainSnapshot; submissionStartedAt: string | null;
  newConversation: boolean; visible: boolean;
}) {
  const latest = snapshot.threadSummaries.find(thread => thread.id === snapshot.activeThread?.id)?.latestRun;
  const run = snapshot.run;
  // A local pending submission precedes its persisted Product record. Never reuse the previous work's time.
  const pending = submissionStartedAt !== null;
  if (!pending && (newConversation || !latest || (run && run.productRunId !== latest.runId))) return null;
  const start = pending ? submissionStartedAt : latest!.startedAt;
  const end = pending ? null : run?.host.terminal?.completedAt ?? latest!.completedAt;
  const live = pending || (!!run && !run.display.terminal);
  if (!live && !end) return <span className="wb-request-elapsed" title="No recorded end time">Duration unavailable</span>;
  return <span className="wb-request-elapsed" aria-label="Request elapsed time"
    title="Time since request submission, including waits">
    <Clock3 size={12} aria-hidden="true" />
    <ElapsedTime key={pending ? start : latest!.runId} start={start} end={end} ticking={live && visible} />
  </span>;
}
