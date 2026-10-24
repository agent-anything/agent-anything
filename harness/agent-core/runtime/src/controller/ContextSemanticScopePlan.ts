import type {ProviderRequest} from "@agent-anything/model-interaction";
import {createExactModelWorkingView, validateModelAccountScope} from "@agent-anything/model-interaction/input";

/** Enumerates possible relief, not an assertion that meaning can be compressed. */
export function contextSemanticScopes(request: ProviderRequest, runId: string, maximum: number): readonly (readonly string[])[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) throw new TypeError("Invalid semantic alternative bound.");
  const sections = request.composition.sections;
  const view = createExactModelWorkingView({sections, recipientRunId: runId, boundary: "request"});
  const eligible = new Set(view.entries.filter(entry => !entry.protection.length &&
    entry.preservation.obligations.every(value => value.requirement === "account")).map(entry => entry.sectionId));
  const groups = new Map(view.nativeGroups.flatMap(group => group.sectionIds.map(id => [id, group.sectionIds] as const)));
  const units: string[][] = [];
  for (let index = 0; index < sections.length;) {
    const id = sections[index]!.id, group = groups.get(id) ?? [id];
    if (group[0] !== id || group.some((value, offset) => sections[index + offset]?.id !== value)) {
      throw new TypeError("Native scope units are not contiguous.");
    }
    units.push([...group]); index += group.length;
  }
  const candidates: string[][] = [], seen = new Set<string>();
  const add = (ids: readonly string[]) => {
    if (candidates.length >= maximum) return;
    const key = JSON.stringify(ids);
    if (seen.has(key)) return;
    try {validateModelAccountScope(sections, ids, runId);} catch {return;}
    seen.add(key); candidates.push([...ids]);
  };
  const bytes = new Map(sections.map(section => [section.id, Buffer.byteLength(JSON.stringify(section.content))]));
  const materials = units.filter(unit => unit.every(id => eligible.has(id)) && unit.some(id =>
    sections.find(section => section.id === id)?.provenance?.purpose === "selected_material"));
  materials.sort((a, b) => b.reduce((sum, id) => sum + bytes.get(id)!, 0) - a.reduce((sum, id) => sum + bytes.get(id)!, 0));
  for (const material of materials) add(material);
  const planning = request.modelContext.assessment?.planning;
  const amount = planning?.measurement.status === "measured" ? planning.measurement.amount : null;
  const ratio = amount !== null && planning ? amount / Math.max(1, planning.footprint.bytes) : null;
  const deficit = amount !== null && planning?.releaseTarget !== null && planning?.releaseTarget !== undefined ?
    Math.max(0, amount - planning.releaseTarget) : Infinity;
  for (let start = 0; start < units.length && candidates.length < maximum;) {
    if (units[start]!.some(id => !eligible.has(id))) {start++; continue;}
    let end = start;
    while (end < units.length && units[end]!.every(id => eligible.has(id))) end++;
    let count = 1, possible = units[start]!.reduce((sum, id) => sum + bytes.get(id)!, 0) * (ratio ?? 0);
    while (count < end - start && possible < deficit) {
      possible += units[start + count]!.reduce((sum, id) => sum + bytes.get(id)!, 0) * (ratio ?? 0); count++;
    }
    for (;;) {
      add(units.slice(start, start + count).flat());
      if (count === end - start || candidates.length >= maximum) break;
      count = Math.min(end - start, count * 2);
    }
    start = end;
  }
  return Object.freeze(candidates.map(ids => Object.freeze(ids)));
}
