import * as React from "react";
import { useEffect, useState } from "react";

export function ElapsedTime({ start, end, ticking, minimumSeconds = 0 }: {
  start: string | null; end: string | null; ticking: boolean; minimumSeconds?: number;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking || !start) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, start]);
  if (!start || (!ticking && !end)) return null;
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds) || seconds < minimumSeconds) return null;
  return <small>{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</small>;
}
