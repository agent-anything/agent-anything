import { useEffect, useState } from "react";
import type { HelarcModelDiscoveryResult } from "../../shared/HelarcModelSelection.js";

export function useModelDiscovery(profileId: string | undefined, revision: string | undefined, model: string, enabled = true) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<HelarcModelDiscoveryResult | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let disposed = false;
    setResult(null);
    if (!enabled || !profileId || !revision) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void window.helarc.discoverModels({ profileId, profileRevision: revision, model, refresh: refresh > 0 })
        .then(value => { if (!disposed) setResult(value); })
        .catch(() => { if (!disposed) setResult({ ok: false, error: "Model discovery is unavailable." }); })
        .finally(() => { if (!disposed) setLoading(false); });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [profileId, revision, model, enabled, refresh]);
  return { result, loading, refresh: () => setRefresh(value => value + 1),
    capability: result?.ok ? result.catalog.models.find(item => item.id === model)?.thinking : undefined };
}
