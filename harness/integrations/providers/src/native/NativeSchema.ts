import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { type ModelSchemaMapping, type ModelInteractionProtocolRef, type ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import { copy, digest, freeze, json, object, NativeProtocolError, type JsonObject } from "./NativeJson.js";

export interface NativeSchemaSpec {
  readonly protocol: ModelInteractionProtocolRef;
  readonly purpose: ProtocolRevisionRef;
  readonly canonical: JsonObject;
  readonly mode: "responses-strict" | "identity";
  readonly root: "function" | "body" | "object-body";
}
export interface NativeSchemaCodec extends ModelSchemaMapping<unknown, unknown> {
  readonly spec: NativeSchemaSpec;
  readonly wire: JsonObject;
  readonly wrapped: boolean;
  parse(text: string): unknown;
}
export interface NativeSchemaWork {
  readonly mappingRevision:string;
  readonly disposition:"compiled"|"reused";
  readonly canonicalBytes:number;
  readonly wireBytes:number;
  readonly elapsedMs:number;
}
interface NodeCodec { schema: JsonObject; encode(value: unknown): unknown; decode(value: unknown): unknown }
const cache = new Map<string, NativeSchemaCodec>();
const COMPILER = "native-schema.v1";
const ajv = new Ajv2020({allErrors: false, strict: true, strictTypes: false, addUsedSchema: false});
function compile(schema: JsonObject): ValidateFunction {
  try { return ajv.compile(schema); }
  catch { throw new NativeProtocolError("native_schema_configuration_invalid"); }
}
function checked(validate: ValidateFunction, value: unknown, stage: string): void {
  if (!validate(value)) throw new NativeProtocolError("native_arguments_invalid", {
    stage, issues: validate.errors?.slice(0, 8).map(e => ({path: e.instancePath, keyword: e.keyword, params: e.params})),
  });
}

/** Only immutable compilation is reused. Acceptance and current authority are never cached here. */
export function compileNativeSchema(input: NativeSchemaSpec,observe?:(work:NativeSchemaWork)=>void): NativeSchemaCodec {
  const started=performance.now();
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 262144) throw new NativeProtocolError("native_schema_configuration_limit");
  const key = digest([COMPILER, input]);
  const report=(codec:NativeSchemaCodec,disposition:NativeSchemaWork["disposition"])=>{
    if(observe)try{observe({mappingRevision:key,disposition,canonicalBytes:Buffer.byteLength(JSON.stringify(codec.spec.canonical)),
      wireBytes:Buffer.byteLength(JSON.stringify(codec.wire)),elapsedMs:performance.now()-started});}catch{/* Diagnostics do not change mapping. */}
    return codec;
  };
  const existing = cache.get(key);
  if (existing) return report(existing,"reused");
  const spec = copy(input), canonicalValidator = compile(spec.canonical);
  let count = 0;
  const expand = (value: unknown, stack: string[] = [], depth = 0): JsonObject => {
    if (++count > 8192 || depth > 48) throw new NativeProtocolError("native_schema_configuration_limit");
    const schema = object(value);
    if (schema.$ref !== undefined) {
      const ref = schema.$ref;
      if (typeof ref !== "string" || !ref.startsWith("#/$defs/") || stack.includes(ref) ||
          Object.keys(schema).some(k => k !== "$ref" && k !== "description" && k !== "title"))
        throw new NativeProtocolError("native_schema_structure_unsupported");
      let target: unknown = spec.canonical;
      for (const part of ref.slice(2).split("/")) target = object(target)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      return {...expand(target, [...stack, ref], depth + 1), ...(schema.description ? {description: schema.description} : {})};
    }
    return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$defs" && k !== "$schema" && k !== "$id").map(([k,v]) => {
      if (k === "properties") return [k, Object.fromEntries(Object.entries(object(v)).map(([name, child]) => [name, expand(child, stack, depth + 1)]))];
      if (k === "items") return [k, expand(v, stack, depth + 1)];
      if (k === "anyOf") return [k, (v as unknown[]).map(child => expand(child, stack, depth + 1))];
      return [k,v];
    }));
  };
  const strictNode = (original: JsonObject): NodeCodec => {
    const schema={...original};
    if(Object.hasOwn(schema,"default")){
      schema.description=[schema.description,`Canonical default annotation: ${JSON.stringify(schema.default)}. Defaults are applied only by the capability owner; omission remains omission.`].filter(Boolean).join(" ");
      delete schema.default;
    }
    if(schema.type===undefined&&(schema.enum!==undefined||Object.hasOwn(schema,"const"))){
      const values=Object.hasOwn(schema,"const")?[schema.const]:schema.enum as unknown[];
      const types=[...new Set(values.map(v=>v===null?"null":typeof v))];
      if(types.some(t=>!["null","string","number","boolean"].includes(t)))throw new NativeProtocolError("native_schema_structure_unsupported");
      schema.type=types.length===1?types[0]:types;
    }
    const stringBounds=["minLength","maxLength","pattern"],numberBounds=["minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf"],arrayBounds=["minItems","maxItems"];
    const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "anyOf", "enum", "const", "description", "title",...stringBounds,...numberBounds,...arrayBounds]);
    if (Object.keys(schema).some(k => !allowed.has(k))) throw new NativeProtocolError("native_schema_structure_unsupported");
    const annotations = Object.fromEntries(["description", "title"].filter(k => k in schema).map(k => [k, schema[k]]));
    if (schema.anyOf !== undefined) {
      if (Object.keys(schema).some(k => !["anyOf", "description", "title"].includes(k))) throw new NativeProtocolError("native_schema_structure_unsupported");
      const branches = (schema.anyOf as JsonObject[]).map(s => ({codec: strictNode(s), validate: compile(s)}));
      // Canonical alternatives may overlap. A wire tag preserves the selected decoding path.
      return {schema: {...annotations, anyOf: branches.map((b,index) => ({type:"object",properties:{variant:{type:"string",enum:[String(index)]},value:b.codec.schema},
        required:["variant","value"],additionalProperties:false}))},
        encode(value){const index=branches.findIndex(b=>b.validate(value));if(index<0)throw new NativeProtocolError("native_arguments_invalid");
          return {variant:String(index),value:branches[index].codec.encode(value)};},
        decode(value){const wire=object(value),index=Number(wire.variant);
          if(!Number.isSafeInteger(index)||String(index)!==wire.variant||!branches[index])throw new NativeProtocolError("native_arguments_invalid");
          return branches[index].codec.decode(wire.value);}};
    }
    if (schema.type === "object") {
      if (schema.additionalProperties !== false || schema.enum !== undefined || schema.const !== undefined)
        throw new NativeProtocolError("native_schema_open_object_unsupported");
      const properties = object(schema.properties ?? {}), required = new Set(schema.required as string[] ?? []);
      const fields = Object.entries(properties).map(([name, child]) => {
        const original = object(child), codec = strictNode(original), optional = !required.has(name);
        const nullable = compile(original)(null) === true;
        const mapped = !optional ? codec.schema : nullable ? {anyOf: [
          {type:"object",properties:{state:{type:"string",enum:["absent"]}},required:["state"],additionalProperties:false},
          {type:"object",properties:{state:{type:"string",enum:["present"]},value:codec.schema},required:["state","value"],additionalProperties:false},
        ], description:"state absent omits the property; state present supplies value, including null."} :
          {anyOf:[codec.schema,{type:"null"}],description:"null means the property was not supplied. Empty values remain supplied values."};
        return {name,codec,optional,nullable,mapped};
      });
      return {schema:{...annotations,type:"object",properties:Object.fromEntries(fields.map(f => [f.name,f.mapped])),required:fields.map(f=>f.name),additionalProperties:false},
        encode(value) { const record = object(value); return Object.fromEntries(fields.map(f => [f.name, !Object.hasOwn(record,f.name)
          ? f.nullable ? {state:"absent"} : null
          : f.optional && f.nullable ? {state:"present",value:f.codec.encode(record[f.name])} : f.codec.encode(record[f.name])])); },
        decode(value) { const record = object(value); return Object.fromEntries(fields.flatMap(f => {
          const wire = record[f.name];
          if (f.optional && (f.nullable ? object(wire).state === "absent" : wire === null)) return [];
          return [[f.name,f.codec.decode(f.optional && f.nullable ? object(wire).value : wire)]];
        })); }};
    }
    if (schema.type === "array") {
      if (!schema.items || schema.enum !== undefined || schema.const !== undefined) throw new NativeProtocolError("native_schema_structure_unsupported");
      const item = strictNode(object(schema.items));
      return {schema:{...annotations,type:"array",items:item.schema,...Object.fromEntries(arrayBounds.filter(k=>k in schema).map(k=>[k,schema[k]]))},encode:v=>(v as unknown[]).map(item.encode),decode:v=>(v as unknown[]).map(item.decode)};
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.some(t => !["string","number","integer","boolean","null"].includes(t as string)) ||
        Object.keys(schema).some(k => !["type","enum","const","description","title",...stringBounds,...numberBounds].includes(k))) throw new NativeProtocolError("native_schema_structure_unsupported");
    return {schema:{...annotations,type:schema.type,...Object.fromEntries([...stringBounds,...numberBounds].filter(k=>k in schema).map(k=>[k,schema[k]])),
      ...("const" in schema ? {enum:[schema.const]} : "enum" in schema ? {enum:schema.enum} : {})},encode:v=>v,decode:v=>v};
  };
  let node: NodeCodec = {schema:spec.canonical,encode:v=>v,decode:v=>v};
  if (spec.mode === "responses-strict") node = strictNode(expand(spec.canonical));
  const wrapped = (spec.mode === "responses-strict" || spec.root === "object-body") && node.schema.type !== "object";
  if (wrapped && spec.root === "function") throw new NativeProtocolError("native_function_root_object_required");
  const wire = freeze(wrapped ? {type:"object",properties:{result:node.schema},required:["result"],additionalProperties:false} : node.schema);
  const wireValidator = compile(wire);
  const codec: NativeSchemaCodec = Object.freeze({spec,wire,wrapped,
    binding: freeze({mapping:{id:COMPILER,revision:key},protocol:spec.protocol,purpose:spec.purpose,
      canonicalSchema:{id:"canonical",revision:digest(spec.canonical)},wireSchema:{id:"wire",revision:digest(wire)}}),
    encode(value:unknown) { checked(canonicalValidator,value,"canonical"); const encoded = node.encode(value), result = wrapped ? {result:encoded} : encoded; checked(wireValidator,result,"wire"); return copy(result); },
    decode(value:unknown) { checked(wireValidator,value,"wire"); const result = node.decode(wrapped ? object(value).result : value); checked(canonicalValidator,result,"canonical"); return copy(result); },
    parse(text:string) { return this.decode(json(text)); },
  });
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key,codec); return report(codec,"compiled");
}
