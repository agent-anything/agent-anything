import type { ProviderCallResult, ProviderRequest } from "@agent-anything/model-interaction";
import { publishProviderObservation, snapshotProviderDiagnostic, type ProviderObserver, type ProviderObservation } from "@agent-anything/model-interaction/transport";

export class ProviderExchangeObservation {
  private endpoint: string | null = null;
  private httpStatus: number | null = null;
  private encodedBytes: number | null = null;
  constructor(private readonly observer: ProviderObserver | undefined, private readonly providerId: string, private readonly model: string, private readonly request: ProviderRequest, private readonly attemptId: string) {}
  validated(request: ProviderRequest): void { this.emit("request", "accepted", { request, representation: "semantic" }); }
  dispatched(endpoint: string, encodedBody: string): void {
    if (!this.observer) return;
    try { const url = new URL(endpoint); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; this.endpoint = url.toString(); } catch { this.endpoint = null; }
    this.encodedBytes = Buffer.byteLength(encodedBody);
    this.emit("dispatch", "dispatched", { body: encodedBody, representation: "encoded_json" });
  }
  received(status: number): void { this.httpStatus = status; this.emit("http_response", "received"); }
  consumed(body: unknown, representation: "parsed_json" | "assembled_stream" | "error_diagnostic"): void { this.emit("response_body", "consumed", { body, representation }); }
  settled(result: ProviderCallResult): void { this.emit("settled", result.kind, { result, representation: "normalized", code: "failure" in result ? result.failure.code : null }); }
  threw(): void { this.emit("settled", "threw", { code: "provider_unhandled_failure" }); }
  private emit(stage: ProviderObservation["stage"], status: string, data: { request?: ProviderRequest; result?: ProviderCallResult; body?: unknown; representation?: ProviderObservation["representation"]; code?: string | null } = {}): void {
    if (!this.observer || !this.attemptId) return;
    try {
      const request = data.request ? snapshotProviderDiagnostic(data.request) : null;
      const result = data.result ? snapshotProviderDiagnostic(data.result) : null;
      const body = data.body !== undefined ? snapshotProviderDiagnostic(data.body) : null;
      publishProviderObservation(this.observer, {
        attemptId: this.attemptId, requestId: this.request.requestId,
        runId: typeof this.request.metadata?.runId === "string" ? this.request.metadata.runId : null,
        controllerRequestId: this.request.correlation?.controllerRequestId ?? null,
        providerId: this.providerId, model: this.model, occurredAt: new Date().toISOString(), stage,
        endpoint: this.endpoint, httpStatus: this.httpStatus, encodedBytes: this.encodedBytes, code: data.code ?? null, status,
        request: (request ?? null) as unknown as ProviderRequest | null,
        result: (result ?? null) as unknown as ProviderCallResult | null,
        body: body ?? null, representation: data.representation ?? null,
        contentUnavailable: request === undefined || result === undefined || body === undefined,
      });
    } catch { /* Malformed requests remain owned by the adapter's original validation. */ }
  }
}
