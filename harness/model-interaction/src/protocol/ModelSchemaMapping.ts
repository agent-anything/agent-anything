import { ModelProtocolBindingError, protocolDigest, protocolRecord, snapshotModelInteractionProtocol, snapshotProtocolRevisionRef,
  type ModelInteractionProtocolRef, type ProtocolRevisionRef } from "./ProtocolIdentity.js";
import { snapshotNativeModelSource, type NativeModelSourceRef } from "./NativeModelSource.js";

export interface ModelSchemaMappingBinding {
  readonly mapping: ProtocolRevisionRef;
  readonly protocol: ModelInteractionProtocolRef;
  readonly purpose: ProtocolRevisionRef;
  readonly canonicalSchema: ProtocolRevisionRef;
  readonly wireSchema: ProtocolRevisionRef;
}
export interface ModelSchemaMapping<TCanonical, TWire> {
  readonly binding: ModelSchemaMappingBinding;
  encode(value: TCanonical): TWire;
  decode(value: TWire): TCanonical;
}
export interface DecodedModelArguments<TValue> {
  readonly mapping: ModelSchemaMappingBinding;
  readonly source: NativeModelSourceRef;
  readonly value: TValue;
}
export function snapshotModelSchemaMapping(value: unknown): ModelSchemaMappingBinding {
  protocolRecord(value, ["mapping", "protocol", "purpose", "canonicalSchema", "wireSchema"]);
  return Object.freeze({ mapping: snapshotProtocolRevisionRef(value.mapping), protocol: snapshotModelInteractionProtocol(value.protocol),
    purpose: snapshotProtocolRevisionRef(value.purpose), canonicalSchema: snapshotProtocolRevisionRef(value.canonicalSchema), wireSchema: snapshotProtocolRevisionRef(value.wireSchema) });
}

/** Resolution is exact; a current codec cannot reinterpret retained arguments. */
export function decodeModelArguments<TCanonical, TWire>(input: {
  readonly retained: ModelSchemaMappingBinding;
  readonly codec: ModelSchemaMapping<TCanonical, TWire>;
  readonly source: NativeModelSourceRef;
  readonly raw: TWire;
}): DecodedModelArguments<TCanonical> {
  const mapping = snapshotModelSchemaMapping(input.retained);
  const source = snapshotNativeModelSource(input.source);
  if (protocolDigest(mapping) !== protocolDigest(snapshotModelSchemaMapping(input.codec.binding)) ||
      protocolDigest(source.protocol) !== protocolDigest(mapping.protocol) || protocolDigest(source.scope.purpose) !== protocolDigest(mapping.purpose))
    throw new ModelProtocolBindingError("model_schema_original_mapping_unavailable");
  return Object.freeze({ mapping, source, value: input.codec.decode(input.raw) });
}
