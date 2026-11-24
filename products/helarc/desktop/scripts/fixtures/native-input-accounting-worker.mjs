import Database from "better-sqlite3";
import {appendFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {workerData} from "node:worker_threads";

// Test-only observation of actual body-row consumption by the unchanged production Worker.
mkdirSync(workerData.directory,{recursive:true});
const log=join(workerData.directory,"body-reads.ndjson"),prepare=Database.prototype.prepare;
appendFileSync(log,JSON.stringify({kind:"probe_started",pid:process.pid})+"\n");
Database.prototype.prepare=function(sql){
  const statement=prepare.call(this,sql);
  if(/^\s*SELECT\b/i.test(sql)&&/\bprotocol_content_chunks\b/.test(sql)){
    for(const method of ["get","all","iterate"]){
      const original=statement[method];
      statement[method]=function(...args){
        const result=original.apply(this,args);
        const report=rows=>appendFileSync(log,JSON.stringify({kind:"body_read",rows:rows.length,
          bytes:rows.reduce((sum,row)=>sum+(row?.bytes?.length??0),0)})+"\n");
        if(method!=="iterate"){report(method==="get"?(result?[result]:[]):result);return result;}
        return (function*(){let rows=0,bytes=0;try{for(const row of result){rows++;bytes+=row?.bytes?.length??0;yield row;}}
          finally{appendFileSync(log,JSON.stringify({kind:"body_read",rows,bytes})+"\n");}})();
      };
    }
  }
  return statement;
};
await import("../../dist/main/execution-storage/ExecutionStoreWorker.js");
