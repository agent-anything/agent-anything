import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import { ControllerCheckpointError, type ControllerCheckpointPort } from "./ControllerCheckpoint.js";
import { assertControllerCheckpointValue } from "./ControllerCheckpointValue.js";

/** Values belong to the Provider-backed Controller, not to the Runtime state model. */
export class ProviderControllerCheckpoint {
  constructor(private readonly port: ControllerCheckpointPort | undefined) {}

  read<T>(key: string): T | null {
    const record = this.port?.read(`provider-controller:${key}`);
    if (record === null || record === undefined) return null;
    if (typeof record !== "object" || !("revision" in record) || record.revision !== 1 || !("value" in record)) {
      throw new ControllerCheckpointError(key);
    }
    return structuredClone(record.value) as T;
  }

  async save(key: string, value: unknown, usage?: import("./ControllerAuxiliaryUsage.js").ControllerAuxiliaryUsage): Promise<void> {
    if (!this.port) return;
    try {
      assertControllerCheckpointValue(value);
      if (usage && this.port.commitWithAuxiliaryUsage) await this.port.commitWithAuxiliaryUsage(`provider-controller:${key}`, {revision: 1, value}, usage);
      else await this.port.commit(`provider-controller:${key}`, {revision: 1, value});
    } catch (cause) { throw new ControllerCheckpointError(key, {cause}); }
  }

  async once<T>(key: string, create: () => T | Promise<T>): Promise<T> {
    const retained = this.read<T>(key);
    if (retained !== null) return retained;
    const value = await create();
    await this.save(key, value);
    return value;
  }

  async bind(value: unknown): Promise<void> {
    if (!this.port) return;
    const previous = await this.once("binding", () => value);
    const expected = canonicalEncode("provider-controller-binding.v1", previous);
    const actual = canonicalEncode("provider-controller-binding.v1", value);
    if (expected.length !== actual.length || expected.some((byte, i) => byte !== actual[i])) {
      throw new ControllerCheckpointError("binding");
    }
  }
}
