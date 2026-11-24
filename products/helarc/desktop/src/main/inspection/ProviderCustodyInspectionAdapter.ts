import { randomUUID } from "node:crypto";
import type { InspectionRecorder } from "@agent-anything/inspection/recording";
import { inspectionLink } from "@agent-anything/inspection/adapters";
import type { ProviderCustodyObservation } from "../provider/ProviderRegistryClient.js";
import type { ProviderRegistryEvent } from "../provider/ProviderRegistryProtocol.js";
import {releaseBasisSubject,type InspectedReleaseBasis} from "./ConnectionReleaseInspection.js";

/** Public identities and measured intervals only; never serialize a private binding or command. */
export class ProviderCustodyInspectionAdapter {
  private cursor = 0;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly recorder: Pick<InspectionRecorder, "ref" | "offer" | "offerWhenReady" | "confirmNativeWork">, private readonly registryId: string,
    private readonly releaseBasis?:(pin:string)=>Promise<InspectedReleaseBasis|null>) {}
  readonly observe = (event: ProviderCustodyObservation): void => {
    const subject = this.recorder.ref("provider-custody", "event", randomUUID(), null);
    this.recorder.offer({ subject, occurredAt: new Date().toISOString(),
      payload: { kind: "event", name: `provider.custody.${event.operation}`, sequence: null, code: event.outcome },
      links: event.subjectId ? [inspectionLink("binding", this.recorder.ref("provider-custody", "contribution", event.subjectId, null), subject)] : [],
      contents: [{ name: "Connection custody timing", class: "provider", stage: event.stage, mediaType: "application/json", value: {
        operation: event.operation, stage: event.stage, outcome: event.outcome, durationMs: event.durationMs,
        workerMs: event.workerMs ?? null, work: event.work ?? null, subjectId: event.subjectId, registryId: this.registryId } }] },
      {operation:event.operation,stage:event.stage});
  };
  replay(read: (after: number, limit: number) => Promise<readonly ProviderRegistryEvent[]>): Promise<void> {
    const next = this.pending.then(() => this.readFacts(read));
    this.pending = next.catch(() => {}); return next;
  }
  private async readFacts(read: (after: number, limit: number) => Promise<readonly ProviderRegistryEvent[]>): Promise<void> {
    let after = this.cursor;
    for (;;) {
      const page = await read(after, 100); if (!page.length) return;
      await this.recorder.confirmNativeWork(async()=>{for (const fact of page) {
        if (fact.sequence <= after) throw new Error("provider_custody_event_order_invalid");
        after = fact.sequence;
        const subject = this.recorder.ref("provider-custody", "event", `${this.registryId}:${fact.sequence}`, null);
        if(!await this.recorder.offerWhenReady({ id: `provider-custody:${this.registryId}:${fact.sequence}`, subject, occurredAt: fact.occurredAt,
          payload: { kind: "event", name: `provider.custody.${fact.kind}`, sequence: fact.sequence, code: null },
          links: [inspectionLink("binding", this.recorder.ref("provider-custody", "contribution", fact.subjectId, null), subject)],
          contents: [{ name: "Durable connection custody", class: "provider", stage: fact.kind, mediaType: "application/json", value: { ...fact, registryId: this.registryId } }] }))throw new Error("provider_custody_replay_rejected");
        if(fact.kind==="pin_released"&&this.releaseBasis){
          let basis:InspectedReleaseBasis|null;
          try{basis=await this.releaseBasis(fact.subjectId);}
          catch{
            if(!await this.recorder.offerWhenReady({id:`release-join-unavailable:${subject.id}`,subject,occurredAt:fact.occurredAt,
              payload:{kind:"event",name:"connection.release_join_unavailable",sequence:fact.sequence,code:"basis_unavailable"}}))throw new Error("provider_custody_replay_rejected");
            continue;
          }
          if(basis&&!await this.recorder.offerWhenReady({id:`release-join:${subject.id}`,subject,occurredAt:fact.occurredAt,
            payload:{kind:"event",name:"connection.release_receipt_linked",sequence:fact.sequence,code:null},
            links:[inspectionLink("settles",releaseBasisSubject(this.recorder,basis),subject,{operation:"physical_pin_release"})]}))throw new Error("provider_custody_replay_rejected");
        }
      }});
      this.cursor = after;
    }
  }
}
