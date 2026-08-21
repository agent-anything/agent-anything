import { createHash } from "node:crypto";

export type {
  ToolKey,
  ToolBindingRef,
  ToolDescendantAgentBindingRef,
  ToolInteractionBindingRef,
  ToolOperationBindingRef,
  ToolRevisionRef,
  ToolSchemaRevisionRefs,
  ToolSourceRef,
} from "./ToolRevision.js";
export { toolRevisionKey } from "./ToolRevision.js";

export function createToolContractIdentity(
  domain: string,
  value: unknown,
): string {
  if (
    typeof domain !== "string" ||
    domain.length === 0 ||
    domain.length > 256 ||
    domain !== domain.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(domain)
  ) {
    throw new TypeError("Tool identity requires a canonical versioned domain.");
  }

  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Tool identity data must contain finite numbers.");
    }
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") {
    throw new TypeError("Tool identity data must be serializable.");
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Tool identity data must use plain objects.");
  }
  const keys = Object.keys(value).sort(compareStrings);
  if (Reflect.ownKeys(value).length !== keys.length) {
    throw new TypeError("Tool identity data cannot contain symbol properties.");
  }
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
