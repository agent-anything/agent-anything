import {describe, expect, it} from "vitest";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import {createCodeFileOperationContribution} from "./CodeFileOperation.js";

const contribution = createCodeFileOperationContribution({admittedAt: "2026-10-01T00:00:00.000Z",
  actionAdapterIds: {read: "read", write: "write", edit: "edit", glob: "glob", grep: "grep"}});
function accepts(kind: string, output: unknown) {
  const contract = contribution.resultContracts.find(contract => contract.operation.operation.name === kind)!;
  return contract.validateOutput({status: "succeeded", output} as OperationResult);
}
const complete = {complete: true, entries_visited: 2, files_searched: 1, bytes_read: 5,
  skipped_count: 0, skipped: [], skipped_details_truncated: false, stop_reason: null};
describe("file result coverage contract", () => {
  it("distinguishes a negative search from an empty offset page and an incomplete scan", () => {
    const output = {output_mode: "content", entries: [], truncated: false, omitted_count: 0, scan: complete};
    expect(accepts("grep", output)).toBe(true);
    expect(accepts("grep", {...output, omitted_count: 2, truncated: true})).toBe(true);
    const partial = {...output, truncated: true, omitted_count: null, scan: {...complete, complete: false, stop_reason: "byte_limit"}};
    expect(accepts("grep", partial)).toBe(true);
    expect(accepts("grep", {...partial, omitted_count: 0})).toBe(false);
    expect(accepts("grep", {...partial, truncated: false})).toBe(false);
    expect(accepts("grep", {...partial, scan: {...partial.scan, stop_reason: null}})).toBe(false);
    expect(accepts("grep", {...output, scan: {...complete, skipped_count: 1}})).toBe(false);
  });
  it("requires a valid advancing page or an explicit end", () => {
    const output = {target_id: "target", file_path: "file.txt", byte_length: 12, content_digest: "sha256:test",
      content: "one\r\n", start_line: 1, end_line: 1, total_lines: 3, next_offset: 2, truncated: true};
    expect(accepts("read", output)).toBe(true);
    expect(accepts("read", {...output, next_offset: 1})).toBe(false);
    expect(accepts("read", {...output, next_offset: 3})).toBe(false);
    expect(accepts("read", {...output, next_offset: null})).toBe(false);
    expect(accepts("read", {...output, content: "", start_line: 4, end_line: 0, next_offset: null})).toBe(true);
    expect(accepts("read", {...output, content: "", total_lines: 0, end_line: 0, next_offset: null, truncated: false})).toBe(true);
  });
});
