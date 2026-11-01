import * as React from "react";
import { useContext } from "react";
import { Clock3, FileInput, LockKeyhole, RotateCcw, Workflow } from "lucide-react";
import type { ExecutionActivitiesResult, ExecutionActivity } from "../../shared/HelarcExecutionActivities.js";
import type { WorkbenchScope } from "../../shared/HelarcWorkbench.js";
import { useRead } from "../workbench/useRead.js";
import "./activities.css";

type ActivityRead = { result: ExecutionActivitiesResult | null; failed: boolean };
export const ExecutionActivityContext = React.createContext<ActivityRead>({ result: null, failed: false });

function useActivityRead(scope: WorkbenchScope | null, revision: number | string, visible: boolean) {
  const read = useRead(
    scope ? JSON.stringify([scope.threadId, scope.productRunId, scope.runId]) : "",
    revision,
    async (): Promise<ExecutionActivitiesResult> => window.helarc.readExecutionActivities
      ? window.helarc.readExecutionActivities({ ...scope!, includeDescendants: true })
      : { status: "unavailable" },
    visible,
  );
  return { result: read.error ? null : read.value, failed: !!read.error, refresh: read.refresh };
}

export function ExecutionActivitiesProvider({ scope, revision, visible, children }: {
  scope: WorkbenchScope | null; revision: number | string; visible: boolean; children: React.ReactNode;
}) {
  const read = useActivityRead(scope, revision, visible);
  return <ExecutionActivityContext.Provider value={read}>{children}</ExecutionActivityContext.Provider>;
}

function scopedActivities(result: ExecutionActivitiesResult | null, scope: WorkbenchScope | null) {
  if (!scope || result?.status !== "page" || result.scope.threadId !== scope.threadId ||
      result.scope.productRunId !== scope.productRunId) return [];
  return result.items.filter(item => item.runId === scope.runId);
}

export function activitiesForScope(result: ExecutionActivitiesResult | null, scope: WorkbenchScope | null) {
  return scopedActivities(result, scope).filter(item => item.state !== "settled");
}

export function useExecutionActivityItems(scope: WorkbenchScope) {
  return activitiesForScope(useContext(ExecutionActivityContext).result, scope);
}

function ActivityIcon({ item }: { item: ExecutionActivity }) {
  const Icon = item.state === "authorization" || item.state === "execution_limit" ? LockKeyhole
    : item.placement === "settlement" ? RotateCcw
    : item.state === "waiting_input" || item.state === "preparing" ? FileInput
    : item.state === "resource_queue" ? Clock3 : Workflow;
  return <Icon size={14} aria-hidden="true" />;
}

const stateOrder: Readonly<Record<ExecutionActivity["state"], number>> = {
  authorization: 0, execution_limit: 1, resource_queue: 2, waiting_input: 3,
  preparing: 4, processing: 5, running: 6, settling: 7, unknown: 8, settled: 9,
};
function foremost(items: readonly ExecutionActivity[]) {
  return [...items].sort((a, b) => stateOrder[a.state] - stateOrder[b.state] || a.id.localeCompare(b.id))[0];
}

export function ForegroundActivity({ scope, active, responseProgress, showAvailability = false }: {
  scope: WorkbenchScope | null; active: boolean; responseProgress: string | null; showAvailability?: boolean;
}) {
  const read = useContext(ExecutionActivityContext);
  if (!active || scopedActivities(read.result, scope).some(item => item.taskEnded)) return null;
  const item = foremost(activitiesForScope(read.result, scope).filter(item => !item.taskEnded && item.placement === "foreground"));
  const unavailable = read.failed || read.result?.status === "unavailable" || read.result?.status === "rejected";
  return <>
    {item ? <div className="wb-execution-foreground" role="status">
      <ActivityIcon item={item} />
      <span>{item.title}: {item.purpose === "task_response" && item.state === "running" && responseProgress ? responseProgress : item.status}</span>
      {item.detailsLimited && <small>Limited view</small>}
    </div> : responseProgress ? <div className="wb-model-response-progress" role="status"><span>{responseProgress}</span></div> : null}
    {showAvailability && unavailable && <p className="wb-muted wb-execution-availability">Activity status unavailable.</p>}
    {showAvailability && read.result?.status === "page" && read.result.hasMore &&
      <p className="wb-muted wb-execution-availability">Some activities are outside this view.</p>}
  </>;
}

export function ChildExecutionActivity({ scope }: { scope: WorkbenchScope }) {
  const items = useExecutionActivityItems(scope);
  const foreground = items.filter(item => item.placement === "foreground" && !item.taskEnded);
  const item = foremost(foreground.length ? foreground : items);
  if (!item) return null;
  return <div className="wb-execution-child" aria-label="Execution activity">
    <ActivityIcon item={item} />
    <span>{item.title}: {item.status}</span>
    {item.taskEnded && <small>Task ended</small>}
    {items.length > 1 && <small title={`${items.length - 1} additional activities`}>+{items.length - 1}</small>}
    {item.detailsLimited && <small>Limited view</small>}
  </div>;
}

export function ExecutionActivitiesPanel({ scope, revision, visible }: {
  scope: WorkbenchScope | null; revision: number | string; visible: boolean;
}) {
  const read = useActivityRead(scope, revision, visible);
  if (!scope) return null;
  return <ExecutionActivitiesSummary result={read.result} failed={read.failed} onRetry={read.refresh} />;
}

export function ExecutionActivitiesSummary({ result, failed, onRetry }: ActivityRead & { onRetry: () => void }) {
  const items = result?.status === "page" ? result.items.filter(item => item.state !== "settled" && item.placement !== "foreground") : [];
  const unavailable = failed || result?.status === "unavailable" || result?.status === "rejected";
  if (!items.length && !unavailable && !(result?.status === "page" && result.hasMore)) return null;
  return <section className="wb-section wb-execution-activities" aria-label="Preparation and background activity">
    <h3>Preparation &amp; background</h3>
    {unavailable ? <div className="wb-execution-availability">
      <span>Activity status unavailable.</span>
      <button className="wb-icon" title="Retry activity status" aria-label="Retry activity status" onClick={onRetry}><RotateCcw size={14} /></button>
    </div> : <>
      {([ ["support", "Preparation"], ["background", "Background"], ["remaining", "Unfinished activity"], ["settlement", "Settlement"] ] as const).map(([placement, title]) => {
        const group = items.filter(item => item.placement === placement);
        return group.length ? <div className="wb-execution-group" key={placement}>
          <h4>{title}</h4>
          {group.map(item => <div className="wb-execution-row" key={item.id}>
            <ActivityIcon item={item} />
            <div><strong>{item.title}</strong><small>{item.taskLabel}{item.taskEnded ? " / Task ended" : ""}</small>
              <span>{item.status}</span>{item.detailsLimited && <small>Some stages are outside this view.</small>}
            </div>
          </div>)}
        </div> : null;
      })}
      {result?.status === "page" && result.hasMore && <p className="wb-muted">Some activities are outside this view.</p>}
    </>}
  </section>;
}
