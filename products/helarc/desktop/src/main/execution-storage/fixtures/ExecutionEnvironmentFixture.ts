import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";
import {HelarcExecutionStore} from "../HelarcExecutionStore.js";
import type {ExecutionEnvironmentCipher} from "../ExecutionEnvironmentProtection.js";

/** Deterministic test key; production uses Electron safeStorage, never this cipher. */
export function environmentFixtureCipher(): ExecutionEnvironmentCipher {
  const key = createHash("sha256").update("execution-environment-test-fixture-only").digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
    },
    decryptString(value) {
      const bytes = Buffer.from(value, "base64");
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}

export function openExecutionStoreFixture(...args: Parameters<typeof HelarcExecutionStore.open>): Promise<HelarcExecutionStore> {
  return HelarcExecutionStore.open(args[0], args[1], args[2], args[3], args[4], args[5] ?? environmentFixtureCipher());
}
