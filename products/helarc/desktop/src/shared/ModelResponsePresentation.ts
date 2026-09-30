export function modelResponseProgress(attempt: {
  readonly state: string;
  readonly parts: readonly { readonly receivedLength: number }[];
} | undefined): string | null {
  if (!attempt || !["receiving", "received", "validated"].includes(attempt.state)) return null;
  if (attempt.state !== "receiving") return "Processing model response";
  return attempt.parts.some(part => part.receivedLength > 0)
    ? "Receiving model response" : "Waiting for model response";
}
