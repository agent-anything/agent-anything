import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import { ActivityCheckpointError, type ActivityCheckpointPort } from "../activity/ActivityCheckpoint.js";
import { assertControllerCheckpointValue } from "../activity/ActivityCheckpointValue.js";

/** Values belong to the Provider-backed Controller, not to the Runtime state model. */
export class ModelActivityCheckpoint {
  constructor(private readonly port: ActivityCheckpointPort | undefined) {}

  read<T>(key: string): T | null {
    const record = this.port?.read(`provider-controller:${key}`);
    if (record === null || record === undefined) return null;
    if (typeof record !== "object" || !("revision" in record) || record.revision !== 1 || !("value" in record)) {
      throw new ActivityCheckpointError(key);
    }
    return structuredClone(record.value) as T;
  }

  async save(key: string, value: unknown, usage?: import("./AuxiliaryModelUsage.js").AuxiliaryModelUsage): Promise<void> {
    if (!this.port) return;
    try {
      assertControllerCheckpointValue(value);
      if (usage && this.port.commitWithAuxiliaryUsage) await this.port.commitWithAuxiliaryUsage(`provider-controller:${key}`, {revision: 1, value}, usage);
      else await this.port.commit(`provider-controller:${key}`, {revision: 1, value});
    } catch (cause) { throw new ActivityCheckpointError(key, {cause}); }
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
      throw new ActivityCheckpointError("binding");
    }
  }
}
