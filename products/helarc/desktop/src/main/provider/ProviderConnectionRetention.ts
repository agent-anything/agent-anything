import { ProviderConfigurationError, type ProviderConfiguration } from "../../shared/ProviderConfiguration.js";
import type { ProviderDependencyPin } from "./ProviderRegistryProtocol.js";
import type { ProviderConfigurationService } from "./ProviderConfigurationService.js";

/** Execution's durable acceptance owner supplies evidence; Host custody does not infer it from Run status. */
export interface ConnectionAcceptanceEvidence {
  read(pin: ProviderDependencyPin): Promise<"accepted" | "released" | "unknown">;
}
export interface RetainedConnection {
  readonly kind: "connection";
  readonly bindingId: string;
  readonly pinId: string;
  readonly acceptanceId: string;
}
export class ProviderConnectionRetention {
  constructor(private readonly service: ProviderConfigurationService, private readonly evidence: ConnectionAcceptanceEvidence) {}
  pins(after:string,limit:number):Promise<readonly ProviderDependencyPin[]> {return this.service.pins(after,limit);}
  async accept<T>(pin: ProviderDependencyPin, accept: (connection: RetainedConnection) => Promise<T>): Promise<T> {
    await this.service.pin(pin);
    const connection: RetainedConnection = { kind: "connection", bindingId: pin.bindingId, pinId: pin.id, acceptanceId: pin.acceptanceId };
    // An exception can mean lost acknowledgement. Leave the provisional pin until the acceptance owner resolves it.
    const result = await accept(connection);
    await this.reconcile(pin);
    if ((await this.service.readPin(pin.id))?.state !== "confirmed") throw new ProviderConfigurationError("provider_acceptance_unconfirmed");
    return result;
  }
  async recover(connection: RetainedConnection): Promise<ProviderConfiguration> {
    const original = await this.readOriginal(connection);
    if ((await this.service.readPin(connection.pinId))?.state !== "confirmed") throw new ProviderConfigurationError("provider_acceptance_unconfirmed");
    return original;
  }
  async readOriginal(connection: RetainedConnection): Promise<ProviderConfiguration> {
    const pin = await this.service.readPin(connection.pinId);
    if (!pin || pin.bindingId !== connection.bindingId || pin.acceptanceId !== connection.acceptanceId || pin.state === "released")
      throw new ProviderConfigurationError("provider_connection_acceptance_mismatch");
    await this.reconcile(pin);
    if((await this.service.readPin(pin.id))?.state==="released")throw new ProviderConfigurationError("provider_connection_acceptance_mismatch");
    // Local replay is independent of key availability and network reachability.
    return (await this.service.binding(connection.bindingId)).configuration;
  }
  async reconcile(pin: ProviderDependencyPin): Promise<void> {
    const state = await this.evidence.read(pin);
    if (state !== "unknown") await this.service.settlePin(pin.id, pin.acceptanceId, state === "accepted" ? "confirmed" : "released");
  }
  async reconcilePage(after = "", limit = 100): Promise<string | null> {
    const pins = await this.service.pins(after, limit);
    for (const pin of pins) if (pin.state !== "released") await this.reconcile(pin);
    return pins.length === limit ? pins.at(-1)!.id : null;
  }
}
