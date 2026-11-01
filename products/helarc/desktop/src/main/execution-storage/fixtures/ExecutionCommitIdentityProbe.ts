import type {RunTreeCommit,RunCommit} from "@agent-anything/agent-runtime/execution-coordinator";

/** Counts identity reuse without retaining contents or altering commits. Explicit test diagnostics only. */
export function createExecutionCommitIdentityProbe() {
  const seen = new WeakSet<object>();
  const fields = new Map<string, {objects: number; properties: number; reusedRoots: number}>();
  let commits = 0;
  return {
    observeRuns(runs: readonly RunCommit[], tree?: unknown) {
      commits++;
      const inspect = (name: string, value: unknown) => {
        const counts = fields.get(name) ?? {objects: 0, properties: 0, reusedRoots: 0};
        fields.set(name, counts);
        const visit = (item: unknown): void => {
          if (item === null || typeof item !== "object") return;
          if (seen.has(item)) {counts.reusedRoots++; return;}
          seen.add(item); counts.objects++;
          const values = Object.values(item); counts.properties += values.length;
          for (const child of values) visit(child);
        };
        visit(value);
      };
      inspect("tree", tree);
      for (const run of runs) {
        for (const [name, value] of Object.entries(run.state)) inspect(`state.${name}`, value);
        for (const [name, value] of Object.entries(run.control)) inspect(`control.${name}`, value);
        inspect("admission", run.admission);
      }
    },
    observe(commit: RunTreeCommit) {this.observeRuns(commit.runs,commit.checkpoint);},
    summary: () => ({commits, fields: Object.fromEntries([...fields].sort((a,b) => b[1].properties - a[1].properties))}),
  };
}
