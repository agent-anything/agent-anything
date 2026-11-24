import {
  snapshotModelInteractionProtocol, snapshotProtocolRevisionRef,
  type ModelInteractionProtocolRef, type ProtocolRevisionRef,
} from "@agent-anything/model-interaction/protocol";
import { equal, record, snapshot } from "./AccountingValue.js";

export type NativeQuantity =
  | { readonly state: "known"; readonly value: number }
  | { readonly state: "missing" | "unavailable" | "not_applicable" | "invalid"; readonly reason: string }
  | { readonly state: "conflicting"; readonly values: readonly NativeQuantity[] };

export type NativeUsageProfile =
  | { readonly kind: "openai.responses"; readonly revision: "1";
      readonly cacheWrites: "unestablished" | "not_applicable" | "aggregate" | "lifetimes";
      readonly basis: ProtocolRevisionRef }
  | { readonly kind: "deepseek.chat-completions" | "ollama.chat"; readonly revision: "1"; readonly basis: ProtocolRevisionRef };

export interface NativeChargeComponent {
  readonly id: string;
  readonly unit: "tokens";
  readonly quantity: NativeQuantity;
  readonly formula: string;
}
export interface NativeUsageProjection {
  readonly protocol: ModelInteractionProtocolRef;
  readonly profile: NativeUsageProfile;
  /** Only the original usage object (Ollama's usage fields), never the response body. */
  readonly raw: unknown;
  readonly fields: Readonly<Record<string, NativeQuantity>>;
  readonly units: Readonly<Record<string, "tokens" | "nanoseconds">>;
  readonly components: readonly NativeChargeComponent[];
  readonly inputField: string;
  readonly outputField: string;
  readonly cacheReadField: string | null;
  readonly cacheWriteField: string | null;
  readonly issues: readonly string[];
}

const known = (value: number): NativeQuantity => ({ state: "known", value });
const missing = (reason: string): NativeQuantity => ({ state: "missing", reason });
const invalid = (reason: string): NativeQuantity => ({ state: "invalid", reason });
export function mergeNativeQuantities(values: readonly NativeQuantity[]): NativeQuantity {
  const informative = values.filter(value => value.state !== "missing" && value.state !== "unavailable");
  const candidates = informative.length ? informative : values;
  const distinct = candidates.filter((value, index) => candidates.findIndex(other => equal(value, other)) === index);
  return distinct.length === 1 ? distinct[0]! : { state: "conflicting", values: distinct };
}

export function projectNativeUsage(input: {
  readonly protocol: ModelInteractionProtocolRef; readonly profile: NativeUsageProfile; readonly usage: unknown;
}): NativeUsageProjection {
  const protocol = snapshotModelInteractionProtocol(input.protocol), profile = snapshot(input.profile);
  snapshotProtocolRevisionRef(profile.basis);
  if (profile.kind !== protocol.id || profile.revision !== "1" || protocol.revision !== "1" ||
      !["openai.responses", "deepseek.chat-completions", "ollama.chat"].includes(profile.kind))
    throw new TypeError("accounting_usage_profile_mismatch");
  if (profile.kind === "openai.responses" && !["unestablished", "not_applicable", "aggregate", "lifetimes"].includes(profile.cacheWrites))
    throw new TypeError("accounting_usage_profile_invalid");
  const raw = snapshot(input.usage), fields: Record<string, NativeQuantity> = {}, units: Record<string, "tokens" | "nanoseconds"> = {};
  const issues: string[] = [], components: NativeChargeComponent[] = [];
  function read(path: string, unit: "tokens" | "nanoseconds" = "tokens"): NativeQuantity {
    units[path] = unit;
    let value: unknown = raw;
    for (const segment of path.split(".")) {
      if (value === null) return fields[path] = { state: "unavailable", reason: `${path}: null` };
      if (value === undefined) return fields[path] = missing(path);
      const object = record(value);
      if (!object) { issues.push(`invalid_container:${path}`); return fields[path] = invalid(path); }
      value = object[segment];
    }
    if (value === undefined) return fields[path] = missing(path);
    if (value === null) return fields[path] = { state: "unavailable", reason: path };
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      issues.push(`invalid_quantity:${path}`); return fields[path] = invalid(path);
    }
    return fields[path] = known(value as number);
  }
  function inconsistent(paths: string[], reason: string): void {
    issues.push(reason);
    for (const path of paths) fields[path] = invalid(reason);
  }
  function sumEquals(parts: string[], total: string): void {
    const values = parts.map(path => fields[path]!), aggregate = fields[total]!;
    if (aggregate.state === "known" && values.every(value => value.state === "known") &&
        values.reduce((sum, value) => sum + BigInt((value as { value: number }).value), 0n) !== BigInt(aggregate.value))
      inconsistent([...parts, total], `inconsistent_sum:${total}`);
  }
  function subset(part: string, total: string): void {
    const a = fields[part]!, b = fields[total]!;
    if (a.state === "known" && b.state === "known" && a.value > b.value) inconsistent([part, total], `invalid_subset:${part}`);
  }
  function component(id: string, quantity: NativeQuantity, formula = id): void {
    components.push({ id, unit: "tokens", quantity, formula });
  }
  function difference(total: string, subpaths: string[]): NativeQuantity {
    const all = [total, ...subpaths].map(path => fields[path]!);
    if (all.some(value => value.state === "invalid")) return invalid("invalid_input_partition");
    if (all.some(value => value.state !== "known" && value.state !== "not_applicable")) return missing("input_partition_unestablished");
    const n = (value: NativeQuantity): bigint => value.state === "known" ? BigInt(value.value) : 0n;
    const remainder = n(all[0]!) - all.slice(1).reduce((sum, value) => sum + n(value), 0n);
    if (remainder < 0n) { inconsistent([total, ...subpaths], "overlapping_input_partition"); return invalid("overlapping_input_partition"); }
    return known(Number(remainder));
  }

  let inputField: string, outputField: string, cacheReadField: string | null = null, cacheWriteField: string | null = null;
  if (profile.kind === "openai.responses") {
    inputField = "input_tokens"; outputField = "output_tokens";
    cacheReadField = "input_tokens_details.cached_tokens"; cacheWriteField = "input_tokens_details.cache_write_tokens";
    const short = "input_tokens_details.cache_write_tokens_details.ttl_30m_tokens";
    const long = "input_tokens_details.cache_write_tokens_details.ttl_12h_tokens";
    for (const path of [inputField, outputField, "total_tokens", cacheReadField, cacheWriteField, short, long, "output_tokens_details.reasoning_tokens"]) read(path);
    if (profile.cacheWrites === "not_applicable") {
      if ([cacheWriteField, short, long].some(path => fields[path]!.state === "known" && (fields[path] as { value: number }).value !== 0))
        inconsistent([cacheWriteField, short, long, inputField], "cache_write_contract_conflict");
      else for (const path of [cacheWriteField, short, long]) {
        if (fields[path]!.state === "missing") fields[path] = { state: "not_applicable", reason: "retained_legacy_contract" };
      }
    }
    sumEquals([inputField, outputField], "total_tokens");
    sumEquals([short, long], cacheWriteField);
    subset(cacheReadField, inputField); subset(cacheWriteField, inputField); subset("output_tokens_details.reasoning_tokens", outputField);
    const ordinary = difference(inputField, [cacheReadField, cacheWriteField]);
    component("input_tokens.ordinary", ordinary, `${inputField} - ${cacheReadField} - ${cacheWriteField}`);
    component(cacheReadField, fields[cacheReadField]!);
    if (profile.cacheWrites === "lifetimes") {
      // The aggregate is a consistency check, never an additional charge.
      for (const path of [short, long]) component(path, fields[path]!);
    } else component(cacheWriteField, fields[cacheWriteField]!);
    component(outputField, fields[outputField]!);
  } else if (profile.kind === "deepseek.chat-completions") {
    inputField = "prompt_tokens"; outputField = "completion_tokens"; cacheReadField = "prompt_cache_hit_tokens";
    for (const path of [inputField, outputField, "total_tokens", cacheReadField, "prompt_cache_miss_tokens", "prompt_tokens_details.cached_tokens", "completion_tokens_details.reasoning_tokens"]) read(path);
    sumEquals([inputField, outputField], "total_tokens");
    sumEquals([cacheReadField, "prompt_cache_miss_tokens"], inputField);
    subset(cacheReadField, inputField); subset("completion_tokens_details.reasoning_tokens", outputField);
    const alias = fields["prompt_tokens_details.cached_tokens"]!, readValue = fields[cacheReadField]!;
    if (alias.state === "known" && readValue.state === "known" && alias.value !== readValue.value)
      inconsistent([cacheReadField, "prompt_tokens_details.cached_tokens", "prompt_cache_miss_tokens"], "cache_read_alias_conflict");
    component("prompt_cache_miss_tokens", fields["prompt_cache_miss_tokens"]!);
    component(cacheReadField, fields[cacheReadField]!); component(outputField, fields[outputField]!);
  } else {
    inputField = "prompt_eval_count"; outputField = "eval_count";
    cacheReadField = "prompt_eval_cached_count";
    read(inputField); read(outputField); read(cacheReadField); subset(cacheReadField, inputField);
    for (const path of ["total_duration", "load_duration", "prompt_eval_duration", "eval_duration"]) read(path, "nanoseconds");
    component(inputField, fields[inputField]!); component(outputField, fields[outputField]!);
  }
  return snapshot({ protocol, profile, raw, fields, units, components, inputField, outputField, cacheReadField, cacheWriteField, issues });
}
