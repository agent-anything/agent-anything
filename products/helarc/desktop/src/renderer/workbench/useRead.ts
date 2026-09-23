import { useEffect, useRef, useState } from "react";

/** A scoped observational read; late replies cannot replace a newly selected object. */
export function useRead<T>(
  key: string,
  revision: number | string,
  read: () => Promise<T>,
  enabled = true,
) {
  const [value, setValue] = useState<{ key: string; value: T } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [reload, setReload] = useState(0);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    if (!key || !enabled) return;
    let disposed = false;
    void reader
      .current()
      .then((value) => {
        if (!disposed) {
          setValue({ key, value });
          setError(null);
        }
      })
      .catch(() => {
        if (!disposed) setError({ key, message: "Content could not be read." });
      });
    return () => {
      disposed = true;
    };
  }, [key, revision, reload, enabled]);
  return {
    value: value?.key === key ? value.value : null,
    error: error?.key === key ? error.message : null,
    refresh: () => setReload((v) => v + 1),
  };
}
