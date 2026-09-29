import * as React from "react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from "react";

type Resource = "rows" | "children" | "turns";
/** Limits mounted reading surfaces only; it has no authority over work or retention. */
class ReadingBudget {
  readonly requests = new Map<string, { kind: Resource; amount: number }>();
  readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(id: string, kind: Resource, amount: number) {
    this.requests.set(id, { kind, amount });
    this.listeners.forEach((l) => l());
    return () => {
      this.requests.delete(id);
      this.listeners.forEach((l) => l());
    };
  }
  available(id: string, kind: Resource) {
    let remaining = { rows: 300, children: 8, turns: 3 }[kind];
    for (const [key, request] of this.requests) {
      if (request.kind !== kind) continue;
      const granted = Math.max(0, Math.min(remaining, request.amount));
      if (key === id) return granted;
      remaining -= granted;
    }
    return 0;
  }
}
const Context = createContext<ReadingBudget | null>(null);
export function ConversationReadingBudget({
  children,
}: {
  children: React.ReactNode;
}) {
  const [budget] = useState(() => new ReadingBudget());
  return <Context.Provider value={budget}>{children}</Context.Provider>;
}
export function useConversationCapacity(kind: Resource, amount: number) {
  const budget = useContext(Context),
    id = useId();
  useEffect(() => budget?.set(id, kind, amount), [budget, id, kind, amount]);
  return useSyncExternalStore(
    budget?.subscribe ?? (() => () => {}),
    () => budget?.available(id, kind) ?? amount,
    () => amount,
  );
}
