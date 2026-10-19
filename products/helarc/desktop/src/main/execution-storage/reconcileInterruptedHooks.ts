import { interruptedAgentHook, type AgentHookInvocationCheckpoint } from "@agent-anything/agent-hooks/execution";
import type { HelarcExecutionStore } from "./HelarcExecutionStore.js";

/** Called once by the newly exclusive Host, before accepting any new work. */
export async function reconcileInterruptedHooks(store: HelarcExecutionStore,
  observe?: (record: AgentHookInvocationCheckpoint) => void, now = () => new Date().toISOString()): Promise<void> {
  for (const pending of await store.listUnsettledHooks()) {
    const settled = interruptedAgentHook(pending, now());
    await store.commitHookInvocation(settled);
    try { observe?.(settled); } catch { /* Inspection cannot invalidate the owner commit. */ }
  }
}
