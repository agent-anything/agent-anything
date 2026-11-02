import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join,dirname,resolve,basename} from "node:path";
import {tmpdir} from "node:os";
import {mountProcessProvider} from "./process-provider.mjs";

test("provider closure cancels and joins an in-flight handler and its final logs",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"evaluation-provider-test-"));let resource;
  const entered=Promise.withResolvers(),released=Promise.withResolvers();let handlerSettled=false;
  try{
    const endpoint=await mountProcessProvider({acquire:async(_id,_kind,create)=>resource=await create()},directory,{
      respond:async({signal})=>{entered.resolve();await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}));
        await released.promise;handlerSettled=true;throw new Error("cancelled_after_cleanup");}});
    const request=fetch(endpoint,{method:"POST",body:'{"messages":[]}'}).catch(()=>null);await entered.promise;
    let closed=false;const closing=resource.close().then(()=>{closed=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(handlerSettled,false);
    released.resolve();await closing;await request;assert(handlerSettled);
    const logs=(await readFile(join(directory,"provider.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(logs.map(log=>log.kind),["request","transport_failure"]);
  }finally{
    released.resolve();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert(basename(directory).startsWith("evaluation-provider-test-"));
    await rm(directory,{recursive:true,force:true});
  }
});
