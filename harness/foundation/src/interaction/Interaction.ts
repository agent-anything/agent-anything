import type { ArtifactRef } from "../artifact/index.js";
import type { ISODateTimeString, Metadata } from "../primitives/index.js";

export interface Interaction {
  readonly id: string;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export interface Conversation {
  readonly id: string;
  readonly interactionId: string;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export type MessageContent<TContent = unknown> =
  | {
      readonly kind: "inline";
      readonly value: TContent;
    }
  | {
      readonly kind: "artifact_ref";
      readonly artifactRef: ArtifactRef;
    };

export interface Message<TContent = unknown> {
  readonly id: string;
  readonly conversationId: string;
  readonly source: string;
  readonly content: MessageContent<TContent>;
  readonly createdAt: ISODateTimeString;
  readonly runIds: readonly string[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly metadata: Metadata;
}

export type RunInputMessageRole = "system" | "user" | "assistant";

export interface RunInputItem {
  readonly id: string;
  readonly kind: "message";
  readonly role: RunInputMessageRole;
  readonly content: string;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}
