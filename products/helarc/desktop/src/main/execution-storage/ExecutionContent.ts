import {createHash} from "node:crypto";
import {canonicalEncode} from "@agent-anything/canonical-action/subject";

export interface ExecutionContentBlock { readonly id: string; readonly text: string; }
export interface ExecutionContentRoot { readonly format: 1; readonly root: string; }
export interface PackedExecutionContent extends ExecutionContentRoot {
  readonly blocks: readonly ExecutionContentBlock[];
  readonly bytes: number;
}

export const EXECUTION_CONTENT_LIMITS = Object.freeze({
  blockBytes: 64 * 1024, pageEntries: 32, inlineBytes: 2048,
  transferBytes: 1024 * 1024, hydratedBytes: 128 * 1024 * 1024,
  blocks: 131072, depth: 64,
});
type Atom = null | boolean | number | string;
type Node = Atom | ["ref", string] | ["array" | "object" | "string", string]
  | ["items", Node[]] | ["record", [Node, Node][]];
type PageKind = "array_page" | "object_page" | "string_page";
type Block = ["value", Node] | [PageKind, readonly unknown[]] | ["branch", readonly string[]];
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const hashPattern = /^[a-f0-9]{64}$/;

/** Content identity is physical storage identity, never an execution identity. */
export function packExecutionContent(value: unknown): PackedExecutionContent {
  const blocks = new Map<string, ExecutionContentBlock>();
  const ancestors = new Set<object>();
  let bytes = 0;
  let retainedBytes = 0;
  const charge = (size: number) => { bytes += size; if (bytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded"); };
  const put = (block: Block): string => {
    const text = JSON.stringify(block);
    const size = Buffer.byteLength(text);
    if (size > EXECUTION_CONTENT_LIMITS.blockBytes) fail("execution_content_block_too_large");
    const id = contentDigest(text);
    if (!blocks.has(id)) retainedBytes += size;
    if (retainedBytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded");
    blocks.set(id, {id, text});
    if (blocks.size > EXECUTION_CONTENT_LIMITS.blocks) fail("execution_content_capacity_exceeded");
    return id;
  };
  const pages = (kind: PageKind, entries: readonly unknown[]): string => {
    let level: string[] = [];
    let page: unknown[] = [], size = 0;
    for (const entry of entries) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (page.length && (page.length === EXECUTION_CONTENT_LIMITS.pageEntries || size + bytes > 48 * 1024)) {
        level.push(put([kind, page])); page = []; size = 0;
      }
      page.push(entry); size += bytes;
    }
    if (page.length || !level.length) level.push(put([kind, page]));
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += EXECUTION_CONTENT_LIMITS.pageEntries) next.push(put(["branch", level.slice(i, i + EXECUTION_CONTENT_LIMITS.pageEntries)]));
      level = next;
    }
    return level[0]!;
  };
  const string = (text: string): Node => {
    if (text.length <= EXECUTION_CONTENT_LIMITS.inlineBytes / 6) { charge(Buffer.byteLength(JSON.stringify(text))); return text; }
    const chunks: string[] = [];
    // UTF-16 slices preserve even lone surrogates exactly through JSON encoding.
    for (let i = 0; i < text.length; i += 256) {
      const chunk = text.slice(i, i + 256); charge(Buffer.byteLength(JSON.stringify(chunk)) + 8); chunks.push(chunk);
    }
    return ["string", pages("string_page", chunks)];
  };
  const visit = (input: unknown, depth: number): Node => {
    if (depth > EXECUTION_CONTENT_LIMITS.depth) fail("execution_content_depth_exceeded");
    if (typeof input === "string") return string(input);
    if (input === null || typeof input === "boolean") { charge(8); return input; }
    if (typeof input === "number" && Number.isFinite(input)) { charge(24); return input === 0 ? 0 : input; }
    if (typeof input !== "object" || input === null) fail("execution_content_value_invalid");
    if (ancestors.has(input)) fail("execution_content_cycle");
    const array = Array.isArray(input);
    if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) fail("execution_content_value_invalid");
    ancestors.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(input);
      if (array && keys.length !== input.length + 1) fail("execution_content_value_invalid");
      for (const key of keys) {
        if (typeof key !== "string") fail("execution_content_value_invalid");
        if (array && key === "length") continue;
        const descriptor = descriptors[key]!;
        if (forbidden.has(key) || !descriptor.enumerable || !("value" in descriptor)) fail("execution_content_value_invalid");
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) fail("execution_content_value_invalid");
      }
      charge((array ? input.length : keys.length) * 8 + 16);
      if (array) {
        const items = Array.from({length: input.length}, (_, i) => {
        const entry = descriptors[String(i)];
        if (!entry || !("value" in entry)) fail("execution_content_value_invalid");
        return visit(entry.value, depth + 1);
        });
        if (items.every(item => inlineDepth(item) < 7) && JSON.stringify(items).length <= 512) return ["items", items];
        return ["array", pages("array_page", items)];
      }
      // Preserve source member order: retained owner payloads may include an
      // order-sensitive wire encoding or fingerprint basis. Storage is not a normalizer.
      const members = Object.keys(descriptors).map(key => [string(key), visit(descriptors[key]!.value, depth + 1)] as [Node, Node]);
      if (members.every(pair => pair.every(item => inlineDepth(item) < 7)) && JSON.stringify(members).length <= 512) return ["record", members];
      return ["object", pages("object_page", members)];
    } finally { ancestors.delete(input); }
  };
  const root = put(["value", visit(value, 0)]);
  return {format: 1, root, blocks: [...blocks.values()], bytes};
}

/** Validate bytes before accepting them into either SQLite or a transport cache. */
export function verifyExecutionContentBlock(block: ExecutionContentBlock): void {
  if (!hashPattern.test(block.id) || typeof block.text !== "string" || Buffer.byteLength(block.text) > EXECUTION_CONTENT_LIMITS.blockBytes || contentDigest(block.text) !== block.id) fail("execution_content_corrupt");
  const value: unknown = JSON.parse(block.text);
  // Each bounded block retains canonical JSON safety checks, independently of history size.
  canonicalEncode("helarc.execution-content-block.v1", value);
}

export function executionContentReferences(block: ExecutionContentBlock): readonly string[] {
  verifyExecutionContentBlock(block);
  const value = JSON.parse(block.text) as Block;
  const refs: string[] = [];
  const node = (entry: unknown): void => {
    if (!Array.isArray(entry)) return;
    if (entry.length === 2 && entry[0] === "items" && Array.isArray(entry[1])) { entry[1].forEach(node); return; }
    if (entry.length === 2 && entry[0] === "record" && Array.isArray(entry[1])) {
      for (const pair of entry[1]) {
        if (!Array.isArray(pair) || pair.length !== 2) fail("execution_content_corrupt");
        node(pair[0]); node(pair[1]);
      }
      return;
    }
    if (entry.length !== 2 || !["ref", "array", "object", "string"].includes(entry[0]) || typeof entry[1] !== "string") fail("execution_content_corrupt");
    refs.push(entry[1]);
  };
  if (value[0] === "branch") refs.push(...value[1]);
  else if (value[0] === "value") node(value[1]);
  else if (value[0] === "array_page") value[1].forEach(node);
  else if (value[0] === "object_page") value[1].forEach(entry => {
    if (!Array.isArray(entry) || entry.length !== 2) fail("execution_content_corrupt");
    node(entry[0]); node(entry[1]);
  });
  else if (value[0] !== "string_page") fail("execution_content_corrupt");
  if (refs.some(id => !hashPattern.test(id))) fail("execution_content_corrupt");
  return refs;
}

export function unpackExecutionContent(root: ExecutionContentRoot, read: (id: string) => ExecutionContentBlock): unknown {
  if (!root || root.format !== 1 || typeof root.root !== "string" || !hashPattern.test(root.root) ||
      Object.keys(root).some(key => key !== "format" && key !== "root" && key !== "blocks" && key !== "bytes")) fail("execution_content_format_invalid");
  const cache = new Map<string, Block>();
  const path = new Set<string>();
  let bytes = 0;
  let traversals = 0;
  let retainedBytes = 0;
  const charge = (size: number) => { bytes += size; if (bytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded"); };
  const load = (id: string): Block => {
    let value = cache.get(id);
    if (!value) {
      const block = read(id);
      if (!block || block.id !== id) fail("execution_content_missing");
      retainedBytes += Buffer.byteLength(block.text);
      if (retainedBytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded");
      verifyExecutionContentBlock(block);
      value = JSON.parse(block.text) as Block;
      if (!Array.isArray(value) || value.length !== 2) fail("execution_content_corrupt");
      cache.set(id, value);
      if (cache.size > EXECUTION_CONTENT_LIMITS.blocks) fail("execution_content_capacity_exceeded");
    }
    return value;
  };
  const using = <T>(id: string, body: (block: Block) => T): T => {
    if (++traversals > EXECUTION_CONTENT_LIMITS.blocks * 8) fail("execution_content_capacity_exceeded");
    if (path.has(id) || path.size > EXECUTION_CONTENT_LIMITS.depth * 8) fail("execution_content_cycle");
    path.add(id);
    try { return body(load(id)); } finally { path.delete(id); }
  };
  const entries = (id: string, kind: PageKind, accept: (entry: unknown) => void): void => using(id, block => {
    if (!Array.isArray(block[1]) || block[1].length > EXECUTION_CONTENT_LIMITS.pageEntries) fail("execution_content_corrupt");
    if (block[0] === kind) { for (const entry of block[1]) accept(entry); }
    else if (block[0] === "branch") { for (const ref of block[1]) { if (typeof ref !== "string" || !hashPattern.test(ref)) fail("execution_content_corrupt"); entries(ref, kind, accept); } }
    else fail("execution_content_corrupt");
  });
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > EXECUTION_CONTENT_LIMITS.depth) fail("execution_content_depth_exceeded");
    if (node === null || typeof node === "boolean") { charge(8); return node; }
    if (typeof node === "number" && Number.isFinite(node)) { charge(24); return node; }
    if (typeof node === "string") { charge(Buffer.byteLength(JSON.stringify(node))); return node; }
    if (!Array.isArray(node) || node.length !== 2) fail("execution_content_corrupt");
    const [kind, id] = node;
    if (kind === "items" && Array.isArray(id)) { charge(id.length * 8 + 16); return id.map(part => visit(part, depth + 1)); }
    const object = (each: (accept: (part: unknown) => void) => void): unknown => {
      const result: Record<string, unknown> = {};
      charge(16);
      each(part => {
        charge(8);
        if (!Array.isArray(part) || part.length !== 2) fail("execution_content_corrupt");
        const key = visit(part[0], depth);
        if (typeof key !== "string" || forbidden.has(key) || Object.hasOwn(result, key)) fail("execution_content_corrupt");
        result[key] = visit(part[1], depth + 1);
      });
      return result;
    };
    if (kind === "record" && Array.isArray(id)) return object(accept => id.forEach(accept));
    if (typeof id !== "string" || !hashPattern.test(id)) fail("execution_content_corrupt");
    if (kind === "string") {
      const chunks: string[] = [];
      entries(id, "string_page", part => { if (typeof part !== "string") fail("execution_content_corrupt"); charge(Buffer.byteLength(JSON.stringify(part)) + 8); chunks.push(part); });
      return chunks.join("");
    }
    if (kind === "array") { const result: unknown[] = []; charge(16); entries(id, "array_page", part => {charge(8); result.push(visit(part, depth + 1));}); return result; }
    if (kind === "object") return object(accept => entries(id, "object_page", accept));
    if (kind === "ref") return using(id, block => { if (block[0] !== "value") fail("execution_content_corrupt"); return visit(block[1], depth); });
    return fail("execution_content_corrupt");
  };
  return using(root.root, block => { if (block[0] !== "value") fail("execution_content_corrupt"); return visit(block[1], 0); });
}

export function contentDigest(text: string): string { return createHash("sha256").update("helarc.execution-content.v1\0").update(text).digest("hex"); }
function inlineDepth(node: Node): number {
  if (!Array.isArray(node)) return 0;
  if (node[0] === "items") return 1 + Math.max(0, ...node[1].map(inlineDepth));
  if (node[0] === "record") return 1 + Math.max(0, ...node[1].flatMap(pair => pair.map(inlineDepth)));
  return 0;
}
function fail(code: string): never { throw Object.assign(new Error(code), {code}); }
