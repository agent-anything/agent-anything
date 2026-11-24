import { snapshotModelInteractionProtocol, type ModelInteractionProtocolRef, type ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import { copy, digest, token, NativeProtocolError, type JsonObject } from "../NativeJson.js";

/** Selection provenance shared by input collaborators, not a neutral message format. */
export interface NativeInputScope {
  readonly id: string;
  readonly runId: string;
  readonly recipientId: string;
  readonly purpose: ProtocolRevisionRef;
  readonly compositionDigest: string;
}
export interface NativeInputGroup {
  readonly id: string;
  readonly representation: ProtocolRevisionRef;
  readonly sources: readonly string[];
  readonly holds: readonly string[];
  readonly deliveries: readonly string[];
  readonly requires: readonly { readonly id: string; readonly digest: string }[];
  readonly items: readonly JsonObject[];
  readonly replay: "local" | "remote_only";
}
export interface NativeInputManifest {
  readonly protocol: ModelInteractionProtocolRef;
  readonly scope: NativeInputScope;
  readonly target: { readonly model: string; readonly configuration: string; readonly connection: string; readonly disclosure: string };
  readonly selection: { readonly id: string; readonly revision: string; readonly boundary: string; readonly judgments: readonly string[] };
  readonly groups: readonly NativeInputGroup[];
  readonly settings: JsonObject;
  readonly settingSources: readonly { readonly field: string; readonly source: string; readonly digest: string }[];
  readonly digest: string;
}
export type NativeInputManifestDraft = Omit<NativeInputManifest, "digest">;

export function bindNativeInputManifest(value: NativeInputManifestDraft): NativeInputManifest {
  const draft: NativeInputManifestDraft = { protocol: value.protocol, scope: value.scope, target: value.target,
    selection: value.selection, groups: value.groups, settings: value.settings, settingSources: value.settingSources };
  snapshotModelInteractionProtocol(draft.protocol);
  const scope = draft.scope;
  for (const value of [scope.id, scope.runId, scope.recipientId, scope.purpose.id, scope.purpose.revision, scope.compositionDigest,
    ...Object.values(draft.target), draft.selection.id, draft.selection.revision, draft.selection.boundary]) token(value);
  unique(draft.selection.judgments);
  if (!draft.selection.judgments.length || draft.settings.model !== draft.target.model) throw new NativeProtocolError("native_selection_basis_invalid");
  unique(draft.groups.map(g => g.id));
  unique(draft.groups.flatMap(g => g.deliveries));
  for (const group of draft.groups) {
    token(group.representation.id); token(group.representation.revision);
    if (!group.items.length || !group.sources.length || !group.holds.length || !["local", "remote_only"].includes(group.replay))
      throw new NativeProtocolError("native_group_basis_missing");
    unique(group.sources); unique(group.holds); unique(group.deliveries);
    for (const dependency of group.requires) {
      const required = draft.groups.find(g => g.id === dependency.id);
      if (!required || dependency.digest !== nativeInputGroupDigest(required) || required.id === group.id)
        throw new NativeProtocolError("native_group_dependency_changed");
    }
  }
  if (["input", "messages", "previous_response_id", "conversation"].some(k => Object.hasOwn(draft.settings, k)))
    throw new NativeProtocolError("native_settings_contains_history");
  unique(draft.settingSources.map(s => s.field));
  if (draft.settingSources.length !== Object.keys(draft.settings).length || draft.settingSources.some(s =>
    !s.source || !Object.hasOwn(draft.settings, s.field) || digest(draft.settings[s.field]) !== s.digest))
    throw new NativeProtocolError("native_settings_source_mismatch");
  return copy({ ...draft, digest: digest(draft) });
}
export function assertNativeInputManifest(manifest: NativeInputManifest): void {
  const { digest: expected, ...draft } = manifest;
  if (bindNativeInputManifest(draft).digest !== expected) throw new NativeProtocolError("native_manifest_changed");
}
export function nativeInputGroupDigest(group: NativeInputGroup): string {
  const { holds: _holds, deliveries: _deliveries, ...content } = group;
  return digest(content);
}
export function nativeInputCoverage(manifest: NativeInputManifest): readonly { readonly id: string; readonly digest: string }[] {
  assertNativeInputManifest(manifest);
  return copy(manifest.groups.map(group => ({ id: group.id, digest: nativeInputGroupDigest(group) })));
}
export function nativeInputSettings(body: JsonObject): JsonObject {
  const { input: _input, messages: _messages, previous_response_id: _previous, conversation: _conversation, ...settings } = body;
  return copy(settings);
}
function unique(values: readonly string[]): void {
  values.forEach(token);
  if (new Set(values).size !== values.length) throw new NativeProtocolError("native_input_identity_duplicate");
}
