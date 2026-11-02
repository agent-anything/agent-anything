import Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {mkdirSync,existsSync,statSync,readdirSync,rmSync} from "node:fs";
import {containedInspectionPath} from "../sources/index.js";
import {decodeMetricCursor,encodeMetricCursor,metricDigest,type MetricCursor} from "./InspectionMetricValidation.js";
import type {InspectionMetricScope,InspectionMetricRead} from "./InspectionMetricQuery.js";

const TTL=15*60*1000;
export interface MetricState {
  id:string;scope:string;policy:string;expires:number;step:number;limitation:string|null;
  phase:InspectionMetricRead["status"];recording:number;sequence:number;key:string;
  scanned:number;identities:number;
  lastResponse:Pick<InspectionMetricRead,"status"|"cursor"|"expiresAt"|"scanned"|"identities">|null;
  union:null|{group:string;start:number;end:number;first:number;last:number;duration:number};
  intervalAfter:{group:string;start:number;id:string}|null;
}
/** Disposable investigation state. It is never an execution journal or recovery authority. */
export class InspectionMetricStore {
  readonly db:Database.Database;readonly slot:number;state:MetricState;
  reducingIdentity:string|null=null;
  private readonly file:string;
  constructor(root:string,scope:InspectionMetricScope,policy:string,cursor?:string){
    const directory=containedInspectionPath(root,"query-aggregates");mkdirSync(directory,{recursive:true,mode:0o700});
    const decoded=cursor?decodeMetricCursor(cursor,scope):null;
    let slot=decoded?.slot??-1,db:Database.Database|undefined;
    if(!decoded){
      for(let i=0;i<8;i++){
        const dir=containedInspectionPath(directory,String(i));
        if(existsSync(dir)){
          try{const path=containedInspectionPath(dir,"aggregate.sqlite");const old=new Database(path,{readonly:true,fileMustExist:true,timeout:50});
            let expired=false;try{expired=Number((old.prepare("SELECT expires FROM state WHERE singleton=1").get() as {expires:number}).expires)<Date.now();}finally{old.close();}
            if(expired)rmSync(dir,{recursive:true,force:true});
          }catch{
            // An interrupted initialization may have only an empty slot. Never remove an unfamiliar database.
            if(Date.now()-statSync(dir).birthtimeMs>TTL&&readdirSync(dir).length===0)rmSync(dir,{recursive:true});
          }
        }
        try{mkdirSync(dir,{mode:0o700});slot=i;break;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
      }
      if(slot<0)throw new Error("inspection_aggregation_capacity");
    }
    this.slot=slot;this.file=containedInspectionPath(directory,String(slot),"aggregate.sqlite");
    if(decoded&&!existsSync(this.file))throw new Error("inspection_aggregation_expired");
    try{
      db=new Database(this.file,{fileMustExist:!!decoded,timeout:100});this.db=db;
      if(!decoded)db.pragma("page_size=4096");
      if(db.pragma("page_size",{simple:true})!==4096||Number(db.pragma("page_count",{simple:true}))>8192)throw new Error("inspection_aggregation_corrupt");
      db.pragma("trusted_schema=OFF");db.pragma("secure_delete=ON");db.pragma("cache_size=-2048");db.pragma("temp_store=FILE");db.pragma("max_page_count=8192");
      if(!decoded){db.exec(`BEGIN;
        CREATE TABLE reserve(value BLOB NOT NULL);
        INSERT INTO reserve VALUES(zeroblob(131072));
        CREATE TABLE state(singleton INTEGER PRIMARY KEY,expires INTEGER NOT NULL,value TEXT NOT NULL);
        CREATE TABLE identities(key TEXT PRIMARY KEY,kind TEXT NOT NULL);
        CREATE TABLE items(key TEXT NOT NULL,part TEXT NOT NULL,variant TEXT NOT NULL,ordinal INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(key,part,variant));
        CREATE INDEX items_order ON items(key,ordinal DESC);
        CREATE TABLE observations(id INTEGER PRIMARY KEY,key TEXT NOT NULL,part TEXT NOT NULL,variant TEXT NOT NULL,location TEXT NOT NULL);
        CREATE INDEX observations_identity ON observations(key,id);
        CREATE TABLE metrics(id TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE members(id INTEGER PRIMARY KEY,metric_id TEXT NOT NULL,identity TEXT NOT NULL,UNIQUE(metric_id,identity));
        CREATE INDEX members_metric ON members(metric_id,id);
        CREATE TABLE intervals(id TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE interval_order(group_key TEXT NOT NULL,start REAL NOT NULL,id TEXT NOT NULL,end REAL NOT NULL,PRIMARY KEY(group_key,start,id));
      `);
        this.state={id:randomUUID(),scope:metricDigest(scope),policy,expires:Date.now()+TTL,step:0,limitation:null,phase:"collecting",recording:0,sequence:0,key:"",scanned:0,identities:0,lastResponse:null,union:null,intervalAfter:null};
        db.prepare("INSERT INTO state VALUES(1,?,?)").run(this.state.expires,JSON.stringify(this.state));
        db.exec("COMMIT");
      }else{
        const schema=db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as {name:string;type:string}[];
        if(schema.some(s=>s.type!=="table"&&s.type!=="index")||["reserve","state","identities","items","observations","metrics","members","intervals","interval_order"].some(name=>!schema.some(s=>s.name===name&&s.type==="table")))throw new Error("inspection_aggregation_corrupt");
        const saved=db.prepare("SELECT expires,value FROM state WHERE singleton=1").get() as {expires:number;value:string}|undefined;
        if(!saved||Buffer.byteLength(saved.value)>256*1024)throw new Error("inspection_aggregation_corrupt");
        this.state=JSON.parse(saved.value);
        if(!this.state||this.state.expires!==saved.expires||![this.state.expires,this.state.step,this.state.recording,this.state.sequence,this.state.scanned,this.state.identities].every(v=>Number.isSafeInteger(v)&&v>=0)||
          !["collecting","reducing","intervals","complete","limited","released"].includes(this.state.phase))throw new Error("inspection_aggregation_corrupt");
        if(this.state.id!==decoded.id||this.state.expires<Date.now())throw new Error("inspection_aggregation_expired");
        if(this.state.scope!==decoded.scope)throw new Error("inspection_cursor_invalid");
        if(this.state.policy!==policy){this.erase();throw new Error("inspection_aggregation_scope_changed");}
      }
    }catch(error){db?.close();if(!decoded)rmSync(containedInspectionPath(directory,String(slot)),{recursive:true,force:true});if((error as NodeJS.ErrnoException).code==="SQLITE_CANTOPEN")throw new Error("inspection_aggregation_expired");throw error;}
  }
  cursor():string{return encodeMetricCursor({slot:this.slot,id:this.state.id,step:this.state.step,scope:this.state.scope});}
  check(cursor:string,scope:InspectionMetricScope):MetricCursor {const v=decodeMetricCursor(cursor,scope);if(v.step!==this.state.step&&v.step!==this.state.step-1)throw new Error("inspection_cursor_invalid");return v;}
  save():void {this.db.prepare("UPDATE state SET value=? WHERE singleton=1").run(JSON.stringify(this.state));}
  limitStorage():void {this.db.transaction(()=>{this.db.exec("DELETE FROM reserve");this.state.phase="limited";this.state.limitation="aggregation_storage_limit";this.state.lastResponse=null;this.state.step++;this.save();})();}
  erase():void {this.db.transaction(()=>{for(const name of ["observations","items","identities","metrics","members","intervals","interval_order"])this.db.exec(`DELETE FROM ${name}`);
    this.state.phase="released";this.state.lastResponse=null;this.state.expires=0;this.db.prepare("UPDATE state SET expires=0,value=? WHERE singleton=1").run(JSON.stringify(this.state));})();}
  close():void{this.db.close();}
}
