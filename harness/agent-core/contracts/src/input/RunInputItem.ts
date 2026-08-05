export type RunInputMessageRole = "system" | "user" | "assistant";

export interface RunInputItem {
  readonly id: string;
  readonly kind: "message";
  readonly role: RunInputMessageRole;
  readonly content: string;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}
