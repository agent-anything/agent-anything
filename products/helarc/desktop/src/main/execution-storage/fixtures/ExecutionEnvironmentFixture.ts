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

export async function openExecutionStoreFixture(...args: Parameters<typeof HelarcExecutionStore.open>): Promise<HelarcExecutionStore> {
  const timings=new Map<string,{count:number;totalMs:number;maxMs:number;counters:Record<string,number>}>();
  const observer=process.env.HELARC_TEST_STORAGE_TIMINGS==="1"?{
    record:(...values:Parameters<NonNullable<typeof args[4]>["record"]>)=>args[4]?.record(...values),
    performance(event:import("../../diagnostics/ExecutionPerformance.js").ExecutionPerformanceEvent){
      args[4]?.performance?.(event);
      if(event.kind!=="finished")return;
      const key=`${event.stage}:${event.context.command??event.context.commandKind??event.context.sourceKind??""}`;
      const aggregate=timings.get(key)??{count:0,totalMs:0,maxMs:0,counters:{}};
      aggregate.count++;aggregate.totalMs+=event.durationMs;aggregate.maxMs=Math.max(aggregate.maxMs,event.durationMs);timings.set(key,aggregate);
      for(const [name,value] of Object.entries(event.counters??{}))aggregate.counters[name]=(aggregate.counters[name]??0)+value;
    },
  }:args[4];
  const store=await HelarcExecutionStore.open(args[0],args[1],args[2],args[3],observer,args[5]??environmentFixtureCipher(),args[6],args[7],args[8]);
  if(observer!==args[4]){
    const close=store.close.bind(store);let printed=false;
    store.close=async()=>{try{await close();}finally{if(!printed){printed=true;console.info("Execution fixture timing summary",JSON.stringify(Object.fromEntries(timings)));}}};
  }
  return store;
}
