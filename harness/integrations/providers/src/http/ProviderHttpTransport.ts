export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: HttpResponseHeadersLike;
  readonly body?: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

export interface HttpResponseHeadersLike {
  get(name: string): string | null;
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;
