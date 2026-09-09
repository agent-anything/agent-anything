import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { InspectionRecorder } from "@agent-anything/inspection/recording";
import type { InspectionLink } from "@agent-anything/inspection/records";

export async function createTestRecording(complex = false) {
  const directory = mkdtempSync(join(tmpdir(), "agent-inspector-ui-"));
  const recorder = await InspectionRecorder.create({ root: directory, application: "inspector-ui-test", name: "Component qualification", policy: { revision: "test", enabled: true, definition: true, agent: true, provider: true, execution: true } });
  const root = recorder.ref("runtime", "run", "root-run", "root-run");
  const child = recorder.ref("runtime", "run", "child-investigation", "child-investigation");
  const call = recorder.ref("runtime", "call", "inspect-call", "root-run");
  const result = recorder.ref("runtime", "contribution", "child-result", "root-run");
  const request = recorder.ref("model-interaction", "request", "parent-request", "root-run");
  const link = (from: typeof root, to: typeof root, kind: InspectionLink["kind"], condition: InspectionLink["condition"] = null) => ({ from, to, kind, condition, operation: null, sourceLocation: null, targetLocation: null });
  for (const [index, subject] of [root, child].entries()) {
    recorder.offer({ subject, occurredAt: "2026-09-09T00:00:00Z", payload: { kind: "snapshot", status: "running", revision: 1, agentId: "qualification-agent", taskId: "component-proof", parentRunId: index ? root.id : null }, links: index ? [link(root, child, "descendant")] : [], contents: [{ name: "Empty output", stage: "published", class: "agent", mediaType: "text/plain", value: "" }] });
    recorder.offer({ subject, occurredAt: "2026-09-09T00:00:00Z", payload: { kind: "interval", phase: "started", activity: "run", status: null, clock: "test-process" } });
  }
  recorder.offer({ subject: root, occurredAt: null, payload: { kind: "lifecycle", revision: "test-lifecycle", states: ["running", "waiting", "suspended", "completed"], transitions: [{ id: "wait", from: "running", to: "waiting", trigger: "pending opened" }, { id: "resume", from: "waiting", to: "running", trigger: "result accepted" }, { id: "finish", from: "running", to: "completed", trigger: "completion accepted" }] } });
  recorder.offer({ subject: root, occurredAt: "2026-09-09T00:00:02Z", payload: { kind: "transition", from: "running", to: "waiting", revision: 2, transitionId: "wait", reasonCode: "pending_opened" } });
  recorder.offer({ subject: call, occurredAt: "2026-09-09T00:00:02Z", payload: { kind: "scheduling", position: 0, disposition: "queued", rule: "serial", reason: "exclusive execution", groupId: "decision-1" }, links: [link(root, call, "contains"), link(child, call, "prerequisite", "succeeded")] });
  recorder.offer({ subject: result, occurredAt: "2026-09-09T00:00:03Z", payload: { kind: "transfer", stage: "produced", producerId: child.id, consumerId: root.id, operation: null }, links: [link(child, result, "produces"), link(result, root, "delivers"), link(result, request, "includes")], contents: [{ name: "Returned contribution", stage: "produced", class: "agent", mediaType: "application/json", value: { summary: "Recorded component proof", items: ["one", "two"] } }] });
  recorder.offer({ subject: request, occurredAt: "2026-09-09T00:00:04Z", payload: { kind: "request", purpose: "controller", providerId: "test-provider", model: "test-model", compositionId: "composition-1", messageCount: 2, toolCount: 1 }, links: [link(root, request, "contains")], contents: [{ name: "Semantic request", stage: "composed", class: "provider", mediaType: "application/json", value: { messages: [{ role: "user", content: "component qualification" }] } }] });
  recorder.offer({ subject: child, occurredAt: "2026-09-09T00:00:05Z", payload: { kind: "interval", phase: "settled", activity: "run", status: "completed", clock: "test-process" } });
  if (complex) {
    const nested = recorder.ref("runtime", "run", "nested-investigation", "nested-investigation");
    const secondCall = recorder.ref("runtime", "call", "second-call", child.id);
    recorder.offer({ subject: nested, occurredAt: "2026-09-09T00:00:01Z", payload: { kind: "snapshot", status: "running", revision: 1, agentId: "qualification-agent", taskId: "nested", parentRunId: child.id }, links: [link(child, nested, "descendant")] });
    recorder.offer({ subject: secondCall, occurredAt: "2026-09-09T00:00:02Z", payload: { kind: "scheduling", position: 1, disposition: "dispatched", rule: "parallel_admission", reason: null, groupId: "decision-2" }, links: [link(child, secondCall, "contains"), link(secondCall, call, "materializes")] });
    recorder.offer({ subject: root, occurredAt: "2026-09-09T00:00:03Z", payload: { kind: "transition", from: "waiting", to: "running", revision: 3, transitionId: "resume", reasonCode: "result_accepted" } });
    recorder.offer({ subject: result, occurredAt: "2026-09-09T00:00:05Z", payload: { kind: "transfer", stage: "included", producerId: nested.id, consumerId: request.id, operation: "recorded transformation" }, links: [link(nested, result, "produces"), link(result, request, "includes"), link(result, request, "transforms")], contents: [{ name: "Untrusted recorded content", stage: "produced", class: "agent", mediaType: "text/plain", value: '<script>window.injected = true</script>' }, { name: "Large content", stage: "produced", class: "agent", mediaType: "text/plain", value: "a".repeat(300000) }] });
  }
  await recorder.flush();
  return { root: directory, recorder, sourceId: root.sourceId, datasetId: root.datasetId, async close() { await recorder.flush(true); const target = resolve(directory); if (!relative(tmpdir(), target).startsWith("agent-inspector-ui-")) throw new Error("Invalid test cleanup target"); rmSync(target, { recursive: true, force: true }); } };
}
