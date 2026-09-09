import { parseArgs } from "node:util";
import { defaultInspectionRoot } from "@agent-anything/inspection/sources";
import { retireInspectionDatasets } from "@agent-anything/inspection/storage";

const { values } = parseArgs({ options: { "data-root": { type: "string" }, source: { type: "string" }, dataset: { type: "string" }, before: { type: "string" }, apply: { type: "boolean", default: false } } });
if (!values.source) throw new Error("Specify --source with an Inspector source identifier.");
const results = retireInspectionDatasets(values["data-root"] ?? defaultInspectionRoot(), values.source, { before: values.before ?? new Date(Date.now() - 7 * 86400000).toISOString(), apply: values.apply, ...(values.dataset ? { datasetId: values.dataset } : {}) });
process.stdout.write(`${JSON.stringify({ applied: values.apply, results }, null, 2)}\n`);
