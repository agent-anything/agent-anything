import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync,mkdtempSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import electron from "electron";
import cases from "./fixtures/responses-case-environment.cjs";
import {runPreparedCase} from "./run-responses-case.mjs";

const desktop=fileURLToPath(new URL("../",import.meta.url)),entry=join(desktop,"scripts/fixtures/responses-case-setup.cjs");
const root=mkdtempSync(join(tmpdir(),"helarc-responses-config-")),target="Helarc-Custody-Test/"+randomUUID();
const helperDir=join(desktop,"native/credential-helper"),helper=join(helperDir,"target/x86_64-pc-windows-msvc/release/examples/external-credential-fixture.exe");
function run(program,args,opts={}){
  const result=spawnSync(program,args,{cwd:desktop,encoding:"utf8",windowsHide:true,timeout:90000,...opts});
  if(result.error)throw result.error;
  return result;
}
if(!existsSync(helper)){
  const build=run("cargo",["build","--locked","--release","--target","x86_64-pc-windows-msvc","--example","external-credential-fixture"],{cwd:helperDir});
  assert.equal(build.status,0,build.stderr);
}
function boot(command,id,directory,expectedFailure=false){
  const env={...process.env,HELARC_RESPONSES_TEST_CREDENTIAL_TARGET:target};delete env.ELECTRON_RUN_AS_NODE;
  const r=run(electron,[entry,command,id,directory],{env});
  if(expectedFailure){assert.equal(r.status,1,r.stdout+r.stderr);return r.stderr;}
  assert.equal(r.status,0,r.stdout+r.stderr);
  return JSON.parse(r.stdout.split(/\r?\n/).findLast(line=>line.startsWith('{"caseId"')));
}
function census(env){
  const db=new DatabaseSync(join(env.profile,"provider-registry/registry.sqlite"),{readOnly:true});
  try{return Object.fromEntries(["configurations","updates","revisions","bindings","credentials","selection"].map(table=>
    [table,db.prepare("SELECT count(*) AS n FROM "+table).get().n]));}finally{db.close();}
}
const evidence=[];
console.log("Responses offline evidence:",root);
assert.equal(run(helper,["create",target]).status,0,"could not create synthetic external credential");
try{
  for(const id of cases.cards){
    const directory=join(root,id);
    let first;
    runPreparedCase({caseId:id,directory,setup:"prepare-offline"},(...args)=>{first=boot(...args);return 0;},()=>{
      const env=cases.openCase(id,directory),before=census(env);
      assert.deepEqual(before,{configurations:1,updates:1,revisions:1,bindings:1,credentials:1,selection:0});
      const second=boot("reopen",id,directory);
      assert.notEqual(first.pid,second.pid);assert(second.worker>first.worker);
      assert.deepEqual(second.target,first.target);assert.deepEqual(census(env),before);
      assert.equal(first.fetches+second.fetches+first.admissions+second.admissions,0);
      assert.throws(()=>cases.openLive(id,directory,"--authorize-live"),/not a live case/);
      evidence.push({id,first,second,census:before});console.log(id,"fresh and reopened");
      return 0;
    });
  }
  const d=join(root,"standalone-compaction"),env=cases.openCase("standalone-compaction",d),before=census(env);
  assert.match(boot("prepare-offline","standalone-compaction",d,true),/EEXIST/);
  assert.match(boot("reopen","delegated-material",d,true),/not the original case receipt/);
  const manifest=join(d,"responses-fixture.json"),original=readFileSync(manifest);
  try{
    const damaged=JSON.parse(original);damaged.target.binding="connection-not-the-original";
    writeFileSync(manifest,JSON.stringify(damaged));
    assert.match(boot("reopen","standalone-compaction",d,true),/original binding changed/);
  }finally{writeFileSync(manifest,original);}
  assert.deepEqual(census(env),before);
  assert.match(boot("reopen","standalone-compaction",join(root,"missing"),true),/ENOENT/);
  assert(!existsSync(join(root,"missing")));
}finally{assert.equal(run(helper,["delete",target]).status,0,"synthetic credential cleanup failed");}
writeFileSync(join(root,"result.json"),JSON.stringify({evidence,negative:["existing","wrong-case","changed-binding","missing"],externalFixtureRemoved:true},null,2));
console.log("Passed: isolated configuration setup and reopen only; no live case or in-request-compaction budget admission.");
