export type ModelInputAllocationGroup = "request_bindings" | "working_conversation" | "selected_material";
export const MODEL_INPUT_ALLOCATION_GROUPS: readonly ModelInputAllocationGroup[] = Object.freeze([
  "request_bindings", "working_conversation", "selected_material",
]);

export interface ModelInputAllocationUnit {
  readonly id: string;
  readonly group: ModelInputAllocationGroup;
  /** Source-ordered, already admitted forms. The first form is the required baseline. */
  readonly forms: readonly {
    readonly id: string;
    readonly cost: number;
    readonly requires: readonly { readonly unitId: string; readonly formId: string }[];
  }[];
}
export interface ModelInputAllocationPolicy {
  readonly target: number | null;
  readonly groups?: Partial<Record<ModelInputAllocationGroup, {
    readonly reservation?: number;
    readonly ceiling?: number;
    readonly tier?: number;
    readonly weight?: number;
  }>>;
}
export interface ModelInputAllocation {
  readonly target: number | null;
  readonly baseline: number;
  readonly used: number;
  readonly selected: readonly { readonly unitId: string; readonly formId: string }[];
  readonly groups: readonly { readonly group: ModelInputAllocationGroup; readonly baseline: number;
    readonly demand: number; readonly initialGrant: number; readonly grant: number; readonly used: number; readonly unmet: number }[];
  readonly limitations: readonly string[];
}

/** Pure planning over owner-admitted forms; costs never establish native input validity. */
export function allocateModelInput(units: readonly ModelInputAllocationUnit[], policy: ModelInputAllocationPolicy): ModelInputAllocation {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  if (byId.size !== units.length) throw new TypeError("Allocation unit identities must be unique.");
  const finite = (value: number) => Number.isFinite(value) && value >= 0;
  if (policy.target !== null && !finite(policy.target)) throw new TypeError("Invalid allocation target.");
  for (const unit of units) {
    if (!unit.id || !MODEL_INPUT_ALLOCATION_GROUPS.includes(unit.group) || !unit.forms.length ||
        new Set(unit.forms.map(form => form.id)).size !== unit.forms.length) throw new TypeError("Invalid allocation forms.");
    if (unit.group === "request_bindings" && unit.forms.length !== 1) throw new TypeError("Request bindings are indivisible.");
    unit.forms.forEach((form, index) => {
      if (!form.id || !finite(form.cost) || (index > 0 && form.cost < unit.forms[index - 1]!.cost)) throw new TypeError("Forms require finite nondecreasing costs.");
      for (const dependency of form.requires) if (!byId.get(dependency.unitId)?.forms.some(candidate => candidate.id === dependency.formId)) {
        throw new TypeError("Allocation companion is unavailable.");
      }
    });
  }
  const close = (selection: Map<string, number>): Map<string, number> | null => {
    const visited = new Set<string>();
    const visit = (unit: ModelInputAllocationUnit): boolean => {
      const index = selection.get(unit.id)!;
      const key = `${unit.id}\0${index}`;
      if (visited.has(key)) return true;
      visited.add(key);
      for (const dependency of unit.forms[index]!.requires) {
        const other = byId.get(dependency.unitId)!;
        const required = other.forms.findIndex(form => form.id === dependency.formId);
        const current = selection.get(other.id)!;
        // A later form is not implicitly equivalent to a specifically required companion.
        if (current > required) return false;
        selection.set(other.id, required);
        if (!visit(other)) return false;
      }
      return true;
    };
    return units.every(visit) && units.every(unit => unit.forms[selection.get(unit.id)!]!.requires.every(dependency =>
      byId.get(dependency.unitId)!.forms[selection.get(dependency.unitId)!]!.id === dependency.formId)) ? selection : null;
  };
  const baseline = close(new Map(units.map(unit => [unit.id, 0])));
  if (!baseline) throw new TypeError("Required allocation companions conflict.");
  const costs = (selection: Map<string, number>) => MODEL_INPUT_ALLOCATION_GROUPS.map(group =>
    units.filter(unit => unit.group === group).reduce((sum, unit) => sum + unit.forms[selection.get(unit.id)!]!.cost, 0));
  const base = costs(baseline);
  const demand = MODEL_INPUT_ALLOCATION_GROUPS.map(group => units.filter(unit => unit.group === group)
    .reduce((sum, unit) => sum + unit.forms.at(-1)!.cost, 0));
  const rules = MODEL_INPUT_ALLOCATION_GROUPS.map(group => policy.groups?.[group] ?? {});
  for (const rule of rules) {
    if (Object.values(rule).some(value => !finite(value)) || rule.weight === 0) throw new TypeError("Invalid allocation group policy.");
  }
  const caps = demand.map((value, i) => Math.max(base[i]!, Math.min(value, rules[i]!.ceiling ?? value)));
  const grant = [...base];
  let remaining = Math.max(0, (policy.target ?? demand.reduce((a, b) => a + b, 0)) - base.reduce((a, b) => a + b, 0));
  const share = (indices: number[], limits: number[]) => {
    let active = indices.filter(i => limits[i]! > grant[i]!);
    while (remaining > 1e-9 && active.length) {
      const weight = active.reduce((sum, i) => sum + (rules[i]!.weight ?? 1), 0);
      const pool = remaining;
      for (const i of active) {
        const amount = Math.min(limits[i]! - grant[i]!, pool * (rules[i]!.weight ?? 1) / weight);
        grant[i]! += amount; remaining -= amount;
      }
      active = active.filter(i => limits[i]! - grant[i]! > 1e-9);
    }
  };
  share([0, 1, 2], caps.map((cap, i) => Math.min(cap, Math.max(base[i]!, rules[i]!.reservation ?? 0))));
  for (const tier of [...new Set(rules.map(rule => rule.tier ?? 1))].sort((a, b) => a - b)) {
    share([0, 1, 2].filter(i => (rules[i]!.tier ?? 1) === tier), caps);
  }
  let selected = baseline;
  const initialGrant = [...grant];
  for (const unit of units) for (let index = 1; index < unit.forms.length; index++) {
    if (index <= selected.get(unit.id)!) continue;
    const candidate = new Map(selected); candidate.set(unit.id, index);
    const closed = close(candidate);
    if (closed && costs(closed).every((cost, i) => cost <= grant[i]! + 1e-9)) selected = closed;
  }
  // Return unusable fractional grants to the shared pool, then admit whole bundles
  // in policy/source order. No remote count or semantic decision occurs in this pass.
  const ordered = [...units].sort((a, b) => (rules[MODEL_INPUT_ALLOCATION_GROUPS.indexOf(a.group)]!.tier ?? 1) -
    (rules[MODEL_INPUT_ALLOCATION_GROUPS.indexOf(b.group)]!.tier ?? 1));
  for (const unit of ordered) for (let index = selected.get(unit.id)! + 1; index < unit.forms.length; index++) {
    const candidate = new Map(selected); candidate.set(unit.id, index);
    const closed = close(candidate);
    if (!closed) continue;
    const cost = costs(closed);
    if (cost.every((amount, i) => amount <= caps[i]!) && cost.reduce((a, b) => a + b, 0) <= (policy.target ?? Infinity)) selected = closed;
  }
  const used = costs(selected);
  for (let i = 0; i < grant.length; i++) grant[i] = used[i]!;
  const totalBaseline = base.reduce((a, b) => a + b, 0);
  return Object.freeze({target: policy.target, baseline: totalBaseline, used: used.reduce((a, b) => a + b, 0),
    selected: Object.freeze(units.map(unit => Object.freeze({unitId: unit.id, formId: unit.forms[selected.get(unit.id)!]!.id}))),
    groups: Object.freeze(MODEL_INPUT_ALLOCATION_GROUPS.map((group, i) => Object.freeze({group, baseline: base[i]!,
      demand: demand[i]!, initialGrant: initialGrant[i]!, grant: grant[i]!, used: used[i]!, unmet: Math.max(0, demand[i]! - used[i]!)}))),
    limitations: Object.freeze([
      ...(policy.target === null ? ["planning_target_unknown"] : totalBaseline > policy.target ? ["required_baseline_exceeds_target"] : []),
      ...(base.some((value, i) => value > (rules[i]!.ceiling ?? Infinity)) ? ["required_baseline_exceeds_local_ceiling"] : []),
      ...(policy.target !== null && used.reduce((a, b) => a + b, 0) < policy.target &&
        used.some((value, i) => value < caps[i]!) ? ["indivisible_forms_leave_unused_capacity"] : []),
    ])});
}
