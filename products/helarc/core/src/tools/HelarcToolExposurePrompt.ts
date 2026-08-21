import type { ToolExposureProof } from "@agent-anything/tools/selection";

export function buildHelarcToolExposureText(
  exposure: Pick<ToolExposureProof, "catalog">,
): string {
  return [
    "Active Tool exposure:",
    ...exposure.catalog.tools.map((tool) => [
      `- ${tool.name}: ${tool.description ?? "Use the exact registered Tool contract."}`,
      `  Revision: ${tool.ref.revision}.`,
      `  Input JSON Schema: ${JSON.stringify(tool.inputSchema)}.`,
      `  Annotations: ${JSON.stringify(tool.annotations)}.`,
      `  Settlement binding: ${tool.binding.kind}.`,
    ].join("\n")),
    "Tool exposure and schema validity do not grant authority. The Harness applies the declared binding and assesses any external effect from its exact trusted materialization.",
  ].join("\n");
}
