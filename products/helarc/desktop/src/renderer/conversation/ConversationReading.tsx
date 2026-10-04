import * as React from "react";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";

// Reading controls anchor the shared conversation viewport before changing height.
export const ConversationReading = createContext<(element?: HTMLElement) => void>(() => {});
export const ConversationFollowing = createContext({following: {current: true}, latest: 0});
export const ResponseExpansions = createContext<Set<string> | undefined>(undefined);

export function ConversationExcerpt({ children, identity, label = "response" }: {
  children: React.ReactNode;
  identity: string;
  label?: string;
}) {
  const preserve = useContext(ConversationReading);
  const choices = useContext(ResponseExpansions);
  const [expanded, setExpanded] = useState(() => choices?.has(identity) ?? false);
  const [long, setLong] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const measure = () => setLong(body.current!.getBoundingClientRect().height > 240);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body.current!);
    return () => observer.disconnect();
  }, []);
  return <div className="wb-conversation-excerpt" ref={container}>
    <div className={long && !expanded ? "wb-excerpt-preview" : undefined}>
      <div ref={body}>{children}</div>
    </div>
    {long && <button type="button" className="wb-link wb-excerpt-toggle" aria-expanded={expanded}
      onClick={() => {
        preserve(container.current!);
        if (expanded) choices?.delete(identity); else choices?.add(identity);
        setExpanded(value => !value);
      }}>{expanded ? `Show less ${label}` : `Show full ${label}`}</button>}
  </div>;
}
