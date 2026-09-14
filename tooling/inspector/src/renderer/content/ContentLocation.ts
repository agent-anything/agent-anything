import { findNodeAtLocation, parseTree, type ParseError } from "jsonc-parser";

export interface ContentTarget { id: string; jsonPointer?: string; stage?: string; recordId?: string }

export function locateJsonPointer(text: string, pointer: string): {offset: number; length: number} | null {
  if (pointer !== "" && !pointer.startsWith("/")) return null;
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {allowTrailingComma: false, disallowComments: true});
  if (!root || errors.length) return null;
  const path = pointer === "" ? [] : pointer.slice(1).split("/");
  let node = root;
  for (const raw of path) {
    if (/~(?![01])/u.test(raw)) return null;
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node.type === "array" && !/^(0|[1-9]\d*)$/u.test(part)) return null;
    const next = findNodeAtLocation(node, [node.type === "array" ? Number(part) : part]);
    if (!next) return null;
    node = next;
  }
  return {offset: node.offset, length: node.length};
}
