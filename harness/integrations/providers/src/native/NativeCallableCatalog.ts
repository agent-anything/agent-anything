import { type ModelCallableDefinition } from "@agent-anything/model-interaction";
import { type ModelInteractionProtocolRef, type ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import { compileNativeSchema, type NativeSchemaCodec, type NativeSchemaWork } from "./NativeSchema.js";
import { copy, digest, NativeProtocolError } from "./NativeJson.js";

export interface NativeCallable {
  readonly definition: ModelCallableDefinition;
  readonly codec: NativeSchemaCodec;
}
export interface NativeCallableCatalog {
  readonly revision: string;
  readonly entries: readonly NativeCallable[];
}
export function compileNativeCatalog(input: {readonly protocol:ModelInteractionProtocolRef;readonly purpose:ProtocolRevisionRef;
  readonly definitions:readonly ModelCallableDefinition[];readonly mode:"responses-strict"|"identity"},observe?:(work:NativeSchemaWork)=>void): NativeCallableCatalog {
  if(input.definitions.length>256 || new Set(input.definitions.map(d=>d.name)).size!==input.definitions.length)
    throw new NativeProtocolError("native_catalog_invalid");
  const entries=input.definitions.map(definition=>{
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name))throw new NativeProtocolError("native_callable_name_invalid");
    return Object.freeze({definition:copy(definition),codec:compileNativeSchema({protocol:input.protocol,purpose:input.purpose,
      canonical:definition.inputSchema,mode:input.mode,root:"function"},observe)});
  });
  return Object.freeze({revision:digest(entries.map(e=>[e.definition,e.codec.binding])),entries:Object.freeze(entries)});
}
export function findNativeCallable(catalog:NativeCallableCatalog,name:string):NativeCallable|undefined {
  return catalog.entries.find(entry=>entry.definition.name===name);
}
