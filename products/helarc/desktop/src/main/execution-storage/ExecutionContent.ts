import {createHash} from "node:crypto";
import {types} from "node:util";
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
const immutableValues = new WeakSet<object>();
const validatedImmutableShapes = new WeakSet<object>();

/** Call after encoding validation; keep only locally proven immutable identities. */
export function snapshotEncodedExecutionContent<T>(value: T): T {
  const copies = new WeakMap<object, object>();
  const snapshot = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input === 0 ? 0 : input;
    if (immutableValues.has(input)) return input;
    const previous = copies.get(input);
    if (previous) return previous;
    const copy = Array.isArray(input) ? input.map(snapshot)
      : Object.fromEntries(Object.entries(input).map(([key, child]) => [key, snapshot(child)]));
    Object.freeze(copy); immutableValues.add(copy); copies.set(input, copy);
    return copy;
  };
  return snapshot(value) as T;
}

interface EncodedSubtree {
  readonly node: Node;
  readonly bytes: number;
  readonly height: number;
  readonly blocks: readonly ExecutionContentBlock[];
}

/** Representation evidence only. Never proves that bytes exist in SQLite. */
export class ExecutionContentScope {
  readonly decoded = new Map<string, DecodedSubtree>();
  readonly encoded = new WeakMap<object, Omit<EncodedSubtree, "blocks">>();
  readonly blocks = new Map<string, ExecutionContentBlock>();
  readonly parsed = new Map<string, Block>();
  private entries = 0;
  private bytes = 0;
  private decodedBytes = 0;
  rememberDecoded(key: string, entry: DecodedSubtree): void {
    if (this.decoded.has(key) || this.decoded.size >= EXECUTION_CONTENT_LIMITS.blocks ||
        this.decodedBytes + entry.bytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) return;
    this.decoded.set(key, entry); this.decodedBytes += entry.bytes;
  }
  retain(blocks: readonly ExecutionContentBlock[], values: readonly [object, Omit<EncodedSubtree, "blocks">][]): void {
    let bytes = 0, count = 0;
    for (const block of blocks) if (!this.blocks.has(block.id)) {bytes += Buffer.byteLength(block.text); count++;}
    if (this.bytes + bytes > EXECUTION_CONTENT_LIMITS.hydratedBytes || this.blocks.size + count > EXECUTION_CONTENT_LIMITS.blocks) return;
    for (const block of blocks) this.blocks.set(block.id, Object.freeze(block));
    this.bytes += bytes;
    for (const [value, entry] of values) {
      if (this.entries >= EXECUTION_CONTENT_LIMITS.blocks) break;
      if (!this.encoded.has(value)) {this.encoded.set(value, freezeContent(entry)); this.entries++;}
    }
  }
}

export class ExecutionContentStatistics {
  private readonly values: Record<string, number> = {};
  constructor(private readonly enabled = false) {}
  add(name: string, amount = 1): void {if (this.enabled) this.values[name] = (this.values[name] ?? 0) + amount;}
  take(): Readonly<Record<string, number>> {
    const result = {...this.values};
    for (const name of Object.keys(this.values)) delete this.values[name];
    return result;
  }
}

/** Reuse only subtrees whose entire object graph was verified immutable. */
export class ExecutionContentEncoder {
  private readonly entries = new Map<object | string, EncodedSubtree>();
  private bytes = 0;
  constructor(private readonly maximumBytes = 16 * 1024 * 1024, readonly statistics = new ExecutionContentStatistics()) {}
  pack(value: unknown, scope?: ExecutionContentScope): PackedExecutionContent { return packExecutionContent(value, this, scope); }
  read(value: object | string): EncodedSubtree | undefined {
    const entry = this.entries.get(value);
    if (entry) {this.entries.delete(value); this.entries.set(value, entry);}
    return entry;
  }
  remember(value: object | string, entry: EncodedSubtree): void {
    if (entry.bytes < 4096 || entry.bytes > 512 * 1024 || this.entries.has(value)) return;
    const cost = encodingCost(entry);
    if (cost > this.maximumBytes) return;
    this.entries.set(value, freezeContent(entry)); this.bytes += cost;
    while (this.bytes > this.maximumBytes || this.entries.size > 2048) {
      const key = this.entries.keys().next().value!;
      this.bytes -= encodingCost(this.entries.get(key)!); this.entries.delete(key);
    }
  }
  clear(): void {this.entries.clear(); this.bytes = 0;}
}
function encodingCost(entry: EncodedSubtree): number {
  return entry.bytes + entry.blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
}

/** Content identity is physical storage identity, never an execution identity. */
export function packExecutionContent(value: unknown, encoder?: ExecutionContentEncoder, scope?: ExecutionContentScope): PackedExecutionContent {
  const blocks = new Map<string, ExecutionContentBlock>();
  const representations = new Map<string, Block>();
  const ancestors = new Set<object>();
  const encodedObjects = new WeakMap<object, {node: Node; bytes: number; height: number; immutable: boolean}>();
  const encodedStrings = new Map<string, {node: Node; bytes: number}>();
  const heights: number[] = [];
  const immutable: boolean[] = [];
  const reusableChildren: number[] = [];
  const reusableValues: [object, Omit<EncodedSubtree, "blocks">][] = [];
  let bytes = 0;
  let retainedBytes = 0;
  const charge = (size: number) => { bytes += size; if (bytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded"); };
  const put = (block: Block): string => {
    encoder?.statistics.add("encode.blockBuilds");
    const text = JSON.stringify(block);
    const size = Buffer.byteLength(text);
    if (size > EXECUTION_CONTENT_LIMITS.blockBytes) fail("execution_content_block_too_large");
    const id = contentDigest(text);
    if (!blocks.has(id)) retainedBytes += size;
    if (retainedBytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded");
    blocks.set(id, {id, text});
    representations.set(id, block);
    if (blocks.size > EXECUTION_CONTENT_LIMITS.blocks) fail("execution_content_capacity_exceeded");
    return id;
  };
  const merge = (entry: EncodedSubtree): void => {
    charge(entry.bytes);
    for (const block of entry.blocks) {
      if (!blocks.has(block.id)) retainedBytes += Buffer.byteLength(block.text);
      blocks.set(block.id, block);
    }
    if (blocks.size > EXECUTION_CONTENT_LIMITS.blocks || retainedBytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded");
  };
  const retain = (input: object | string, node: Node, size: number, height: number): void => {
    if (!encoder || size < 4096 || size > 512 * 1024) return;
    encoder.remember(input, {node, bytes: size, height, blocks: collectEncodingBlocks(node, id => blocks.get(id)!, representations)});
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
    const retained = encoder?.read(text);
    if (retained) {
      merge(retained);
      encoder?.statistics.add("encode.reusedNodes");
      encoder?.statistics.add("encode.reusedBytes", retained.bytes);
      if (reusableChildren.length) reusableChildren[reusableChildren.length - 1] = Math.max(reusableChildren.at(-1)!,retained.bytes);
      return retained.node;
    }
    const previous = encodedStrings.get(text);
    if (previous) {charge(previous.bytes); return previous.node;}
    const before = bytes;
    const chunks: string[] = [];
    // UTF-16 slices preserve even lone surrogates exactly through JSON encoding.
    for (let i = 0; i < text.length; i += 256) {
      const chunk = text.slice(i, i + 256); charge(Buffer.byteLength(JSON.stringify(chunk)) + 8); chunks.push(chunk);
    }
    const node: Node = ["string", pages("string_page", chunks)];
    encodedStrings.set(text, {node, bytes: bytes - before});
    if (encoder && bytes - before >= 4096 && bytes - before <= 512 * 1024) {
      retain(text, node, bytes - before, 0);
      if (reusableChildren.length) reusableChildren[reusableChildren.length - 1] = Math.max(reusableChildren.at(-1)!,bytes-before);
    }
    return node;
  };
  const walk = (input: unknown, depth: number): Node => {
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
      let values: [string, unknown][];
      if (validatedImmutableShapes.has(input)) {
        // The codec proved this exact deeply frozen identity safe. Its values
        // still pass through visit, including every occurrence's resource charge.
        values = Object.entries(input);
      } else {
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
        values = Object.keys(descriptors).filter(key => !array || key !== "length")
          .map(key => [key, descriptors[key]!.value]);
      }
      charge(values.length * 8 + 16);
      if (array) {
        const items = values.map(([, value]) => visit(value, depth + 1));
        if (items.every(item => inlineDepth(item) < 7) && JSON.stringify(items).length <= 512) return ["items", items];
        return ["array", pages("array_page", items)];
      }
      // Preserve source member order: retained owner payloads may include an
      // order-sensitive wire encoding or fingerprint basis. Storage is not a normalizer.
      const members = values.map(([key, value]) => [string(key), visit(value, depth + 1)] as [Node, Node]);
      if (members.every(pair => pair.every(item => inlineDepth(item) < 7)) && JSON.stringify(members).length <= 512) return ["record", members];
      return ["object", pages("object_page", members)];
    } finally { ancestors.delete(input); }
  };
  // This synchronous scope never calls input accessors or user callbacks. Reuse
  // representation work, but charge every occurrence's expanded size and depth.
  const visit = (input: unknown, depth: number): Node => {
    const object = typeof input === "object" && input !== null;
    if (object && types.isProxy(input)) fail("execution_content_value_invalid");
    const scoped = object ? scope?.encoded.get(input) : undefined;
    const shared = scoped ? {...scoped, blocks: collectEncodingBlocks(scoped.node, id => scope!.blocks.get(id)!, scope!.parsed)}
      : object ? encoder?.read(input) : undefined;
    const previous = shared ? {...shared, immutable: true} : object ? encodedObjects.get(input) : undefined;
    if (previous) {
      encoder?.statistics.add("encode.reusedNodes");
      encoder?.statistics.add("encode.reusedBytes", previous.bytes);
      if (depth + previous.height > EXECUTION_CONTENT_LIMITS.depth) fail("execution_content_depth_exceeded");
      if (shared) merge(shared); else charge(previous.bytes);
      if (heights.length) heights[heights.length - 1] = Math.max(heights.at(-1)!, previous.height + 1);
      if (immutable.length && !previous.immutable) immutable[immutable.length - 1] = false;
      if (shared && reusableChildren.length) reusableChildren[reusableChildren.length - 1] = Math.max(reusableChildren.at(-1)!,previous.bytes);
      return previous.node;
    }
    const before = bytes;
    encoder?.statistics.add("encode.nodes");
    heights.push(0);
    immutable.push(!object || Object.isFrozen(input));
    reusableChildren.push(0);
    const node = walk(input, depth);
    const height = heights.pop()!;
    const frozen = immutable.pop()!;
    let reusable = reusableChildren.pop()!;
    if (object) {
      if (frozen) {immutableValues.add(input); validatedImmutableShapes.add(input);}
      encodedObjects.set(input, {node, bytes: bytes - before, height, immutable: frozen});
      if (frozen && scope && reusableValues.length < EXECUTION_CONTENT_LIMITS.blocks) reusableValues.push([input, {node, bytes: bytes - before, height}]);
      // Promote geometrically larger containers; cached leaves must not force
      // repeated structural traversal. Every retained closure keeps its full cost.
      if (frozen && encoder && bytes-before>=4*reusable && bytes - before >= 4096 && bytes - before <= 512 * 1024) {
        retain(input, node, bytes - before, height);
        reusable = bytes-before;
      }
    }
    if (heights.length) heights[heights.length - 1] = Math.max(heights.at(-1)!, height + 1);
    if (immutable.length && !frozen) immutable[immutable.length - 1] = false;
    if (reusable && reusableChildren.length) reusableChildren[reusableChildren.length - 1] = Math.max(reusableChildren.at(-1)!,reusable);
    return node;
  };
  const root = put(["value", visit(value, 0)]);
  const output = [...blocks.values()];
  scope?.retain(output, reusableValues);
  return {format: 1, root, blocks: output, bytes};
}

function collectEncodingBlocks(node: Node, read: (id: string) => ExecutionContentBlock, parsed = new Map<string, Block>()): readonly ExecutionContentBlock[] {
  const blocks = new Map<string, ExecutionContentBlock>();
  const block = (id: string): Block => {
    let value = parsed.get(id);
    if (!value) {value = JSON.parse(read(id).text) as Block; parsed.set(id, value);}
    return value;
  };
  const emit = (id: string) => {if (!blocks.has(id)) blocks.set(id, read(id));};
  const collect = (value: Node): void => {
    if (!Array.isArray(value)) return;
    if (value[0] === "items") {value[1].forEach(collect); return;}
    if (value[0] === "record") {value[1].forEach(pair => pair.forEach(collect)); return;}
    const id = value[1];
    if (blocks.has(id)) return;
    if (value[0] === "ref") {collect((block(id) as ["value", Node])[1]); emit(id); return;}
    // Preserve encoder order: children, leaf pages, then branch levels. A shared
    // child's earlier global insertion position is not its subtree's order.
    const levels: string[][] = [];
    const pages = (pageId: string, depth: number): void => {
      (levels[depth] ??= []).push(pageId);
      const page = block(pageId);
      if (page[0] === "branch") page[1].forEach(child => pages(child, depth + 1));
      else if (page[0] === "array_page") (page[1] as Node[]).forEach(collect);
      else if (page[0] === "object_page") (page[1] as [Node, Node][]).forEach(pair => pair.forEach(collect));
    };
    pages(id, 0);
    for (let level = levels.length - 1; level >= 0; level--) levels[level]!.forEach(emit);
  };
  collect(node);
  return [...blocks.values()];
}

/** Validate bytes before accepting them into either SQLite or a transport cache. */
export function verifyExecutionContentBlock(block: ExecutionContentBlock): void {
  parseExecutionContentBlock(block);
}

function parseExecutionContentBlock(block: ExecutionContentBlock): Block {
  if (!hashPattern.test(block.id) || typeof block.text !== "string" || Buffer.byteLength(block.text) > EXECUTION_CONTENT_LIMITS.blockBytes || contentDigest(block.text) !== block.id) fail("execution_content_corrupt");
  const value: unknown = JSON.parse(block.text);
  // Each bounded block retains canonical JSON safety checks, independently of history size.
  canonicalEncode("helarc.execution-content-block.v1", value);
  if (!Array.isArray(value) || value.length !== 2) fail("execution_content_corrupt");
  return value as Block;
}

/** Only exact, locally verified bytes may reuse a parsed block. Not a trust token. */
export class ExecutionContentCache {
  private readonly entries = new Map<string, {text: string; value: Block; bytes: number; refs?: readonly string[]}>();
  private bytes = 0;
  private readonly decoded = new Map<string, DecodedSubtree>();
  private decodedBytes = 0;

  constructor(private readonly maxBytes = 8 * 1024 * 1024, private readonly maxEntries = 4096,
    readonly statistics = new ExecutionContentStatistics()) {}

  parse(block: ExecutionContentBlock): Block {
    const previous = this.entries.get(block.id);
    if (previous?.text === block.text) {
      this.statistics.add("content.parseReuses");
      this.entries.delete(block.id); this.entries.set(block.id, previous);
      return previous.value;
    }
    this.statistics.add("content.parses");
    const value = freezeContent(parseExecutionContentBlock(block));
    const bytes = Buffer.byteLength(block.text);
    if (previous) {this.entries.delete(block.id); this.bytes -= previous.bytes;}
    if (bytes <= this.maxBytes && this.maxEntries > 0) {
      this.entries.set(block.id, {text: block.text, value, bytes}); this.bytes += bytes;
      while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
        const key = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(key)!.bytes; this.entries.delete(key);
      }
    }
    return value;
  }

  references(block: ExecutionContentBlock): readonly string[] {
    const value = this.parse(block), entry = this.entries.get(block.id);
    if (entry?.refs) {this.statistics.add("content.referenceReuses"); return entry.refs;}
    const refs = Object.freeze(contentReferences(value));
    if (entry) {
      entry.refs = refs; entry.bytes += refs.length * 8; this.bytes += refs.length * 8;
      while (this.bytes > this.maxBytes && this.entries.size) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
      }
    }
    return refs;
  }

  readDecoded(key: string): DecodedSubtree | undefined {
    const entry = this.decoded.get(key);
    if (entry) {this.decoded.delete(key); this.decoded.set(key, entry);}
    return entry;
  }
  rememberDecoded(key: string, entry: DecodedSubtree): void {
    if (entry.bytes < 4096 || entry.bytes > 512 * 1024 || this.decoded.has(key) || entry.bytes > this.maxBytes) return;
    this.decoded.set(key, Object.freeze(entry)); this.decodedBytes += entry.bytes;
    while (this.decodedBytes > this.maxBytes || this.decoded.size > this.maxEntries) {
      const oldest = this.decoded.keys().next().value!;
      this.decodedBytes -= this.decoded.get(oldest)!.bytes; this.decoded.delete(oldest);
    }
  }
  clear(): void {this.entries.clear(); this.bytes = 0; this.decoded.clear(); this.decodedBytes = 0;}
}

export function executionContentReferences(block: ExecutionContentBlock, cache?: ExecutionContentCache): readonly string[] {
  return cache ? cache.references(block) : contentReferences(parseExecutionContentBlock(block));
}
function contentReferences(value: Block): readonly string[] {
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

interface DecodedSubtree {
  readonly value: unknown;
  readonly bytes: number;
  readonly height: number;
  readonly traversals: number;
  readonly pathHeight: number;
}

export function unpackExecutionContent(root: ExecutionContentRoot, read: (id: string) => ExecutionContentBlock, verified?: ExecutionContentCache, immutable = false, scope?: ExecutionContentScope): unknown {
  if (!root || root.format !== 1 || typeof root.root !== "string" || !hashPattern.test(root.root) ||
      Object.keys(root).some(key => key !== "format" && key !== "root" && key !== "blocks" && key !== "bytes")) fail("execution_content_format_invalid");
  const cache = new Map<string, Block>();
  // Scope sharing to this expansion. These values already belong to its result;
  // large subtrees need not be retained in the bounded cross-call cache.
  const decodedSubtrees = new Map<string, DecodedSubtree>();
  const references = new Map<string, readonly string[]>();
  const path = new Set<string>();
  let bytes = 0;
  let traversals = 0;
  let retainedBytes = 0;
  const frames: {depth: number; basePath: number; height: number; pathHeight: number}[] = [];
  const charge = (size: number) => { bytes += size; if (bytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded"); };
  const load = (id: string): Block => {
    let value = cache.get(id);
    if (!value) {
      const block = read(id);
      if (!block || block.id !== id) fail("execution_content_missing");
      retainedBytes += Buffer.byteLength(block.text);
      if (retainedBytes > EXECUTION_CONTENT_LIMITS.hydratedBytes) fail("execution_content_capacity_exceeded");
      value = verified ? verified.parse(block) : parseExecutionContentBlock(block);
      if (immutable) references.set(id, verified ? verified.references(block) : contentReferences(value));
      cache.set(id, value);
      if (cache.size > EXECUTION_CONTENT_LIMITS.blocks) fail("execution_content_capacity_exceeded");
    }
    return value;
  };
  const using = <T>(id: string, body: (block: Block) => T): T => {
    if (++traversals > EXECUTION_CONTENT_LIMITS.blocks * 8) fail("execution_content_capacity_exceeded");
    if (path.has(id) || path.size > EXECUTION_CONTENT_LIMITS.depth * 8) fail("execution_content_cycle");
    path.add(id);
    for (const frame of frames) frame.pathHeight = Math.max(frame.pathHeight, path.size - frame.basePath);
    try { return body(load(id)); } finally { path.delete(id); }
  };
  const entries = (id: string, kind: PageKind, accept: (entry: unknown) => void): void => using(id, block => {
    if (!Array.isArray(block[1]) || block[1].length > EXECUTION_CONTENT_LIMITS.pageEntries) fail("execution_content_corrupt");
    if (block[0] === kind) { for (const entry of block[1]) accept(entry); }
    else if (block[0] === "branch") { for (const ref of block[1]) { if (typeof ref !== "string" || !hashPattern.test(ref)) fail("execution_content_corrupt"); entries(ref, kind, accept); } }
    else fail("execution_content_corrupt");
  });
  const walk = (node: unknown, depth: number): unknown => {
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
  const visit = (node: unknown, depth: number): unknown => {
    const key = immutable && Array.isArray(node) && node.length === 2
      ? typeof node[1] === "string" ? `${node[0]}:${node[1]}`
        : node[0] === "record" || node[0] === "items" ? JSON.stringify(node) : null
      : null;
    const reference = immutable && Array.isArray(node) && typeof node[1] === "string";
    const retained = immutable && key ? decodedSubtrees.get(key) ?? scope?.decoded.get(key) ?? verified?.readDecoded(key) : undefined;
    if (retained) {
      verified?.statistics.add("decode.reusedNodes");
      verified?.statistics.add("decode.reusedBytes", retained.bytes);
      if (key && decodedSubtrees.size < EXECUTION_CONTENT_LIMITS.blocks) decodedSubtrees.set(key, retained);
      if (depth + retained.height > EXECUTION_CONTENT_LIMITS.depth) fail("execution_content_depth_exceeded");
      if (path.size + retained.pathHeight > EXECUTION_CONTENT_LIMITS.depth * 8 + 1) fail("execution_content_cycle");
      traversals += retained.traversals;
      if (traversals > EXECUTION_CONTENT_LIMITS.blocks * 8) fail("execution_content_capacity_exceeded");
      charge(retained.bytes);
      for (const frame of frames) {
        frame.height = Math.max(frame.height, depth + retained.height - frame.depth);
        frame.pathHeight = Math.max(frame.pathHeight, path.size + retained.pathHeight - frame.basePath);
      }
      return retained.value;
    }
    for (const frame of frames) frame.height = Math.max(frame.height, depth - frame.depth);
    const frame = {depth, basePath: path.size, height: 0, pathHeight: 0};
    verified?.statistics.add("decode.nodes");
    const before = bytes, traversed = traversals;
    frames.push(frame);
    try {
      const value = walk(node, depth);
      if (immutable && value !== null && typeof value === "object") {
        Object.freeze(value); immutableValues.add(value); validatedImmutableShapes.add(value);
      }
      if (immutable && key) {
        const entry = {value, bytes: bytes - before, height: frame.height,
          traversals: traversals - traversed, pathHeight: frame.pathHeight};
        if ((reference || entry.bytes >= 4096) && decodedSubtrees.size < EXECUTION_CONTENT_LIMITS.blocks) decodedSubtrees.set(key, entry);
        if (reference || entry.bytes >= 4096) scope?.rememberDecoded(key, entry);
        verified?.rememberDecoded(key, entry);
      }
      return value;
    } finally {frames.pop();}
  };
  if (immutable) {
    // Check today's complete reachable bytes before a decoded identity can be reused.
    const checked = new Set<string>(), visiting = new Set<string>();
    const verifyClosure = (id: string): void => {
      if (visiting.has(id)) fail("execution_content_cycle");
      if (checked.has(id)) return;
      if (visiting.size > EXECUTION_CONTENT_LIMITS.depth * 8) fail("execution_content_cycle");
      visiting.add(id);
      load(id);
      verified?.statistics.add("content.closureVisits");
      for (const ref of references.get(id)!) verifyClosure(ref);
      visiting.delete(id); checked.add(id);
    };
    verifyClosure(root.root);
  }
  return using(root.root, block => { if (block[0] !== "value") fail("execution_content_corrupt"); return visit(block[1], 0); });
}

/** Freeze only already validated/decoded JSON; never invokes arbitrary input accessors. */
function freezeContent<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeContent(child);
    Object.freeze(value);
  }
  return value;
}

export function contentDigest(text: string): string { return createHash("sha256").update("helarc.execution-content.v1\0").update(text).digest("hex"); }
function inlineDepth(node: Node): number {
  if (!Array.isArray(node)) return 0;
  if (node[0] === "items") return 1 + Math.max(0, ...node[1].map(inlineDepth));
  if (node[0] === "record") return 1 + Math.max(0, ...node[1].flatMap(pair => pair.map(inlineDepth)));
  return 0;
}
function fail(code: string): never { throw Object.assign(new Error(code), {code}); }
