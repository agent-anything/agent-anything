import type { ConversationBlock } from "../../shared/HelarcWorkbench.js";

type Activity = Extract<ConversationBlock, { kind: "activity" }>;
type WorkGroup<K extends string> = {
  kind: K;
  id: string;
  blocks: Activity[];
};
export type ConversationBlockGroup = Exclude<ConversationBlock, Activity>
  | WorkGroup<"activities"> | WorkGroup<"delegations">;

export function conversationBlockGroups(blocks: readonly ConversationBlock[]): ConversationBlockGroup[] {
  const groups: ConversationBlockGroup[] = [];
  const delegated = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== "activity") {
      groups.push(block);
      continue;
    }
    const child = block.item.child;
    if (child?.relationship === "created") {
      const id = child.concurrentGroup?.id ?? block.id;
      if (delegated.has(id)) continue;
      delegated.add(id);
      const members = child.concurrentGroup
        ? blocks.filter((b): b is Activity => b.kind === "activity" &&
          b.item.child?.relationship === "created" && b.item.child.concurrentGroup?.id === id)
        : [block];
      members.sort((a, b) => (a.item.child!.concurrentGroup?.index ?? 0) - (b.item.child!.concurrentGroup?.index ?? 0));
      groups.push({kind: "delegations", id: `delegation:${id}`, blocks: members});
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.kind === "activities") previous.blocks.push(block);
    else groups.push({kind: "activities", id: block.modelItemId, blocks: [block]});
  }
  return groups;
}
