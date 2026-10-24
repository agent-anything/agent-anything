import {afterEach, describe, expect, it} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {contextMaterialDigest, type ContextMaterialDocument} from "@agent-anything/context/material";
import {CONTEXT_MATERIAL_SCHEMA, ContextMaterialDatabase} from "./ContextMaterialDatabase.js";

const connections: Database.Database[] = [], directories: string[] = [];
afterEach(() => {for (const db of connections.splice(0)) if (db.open) db.close(); for (const dir of directories.splice(0)) rmSync(dir, {recursive:true,force:true});});
function open(path = ":memory:", initialize = true) {const db = new Database(path); connections.push(db); if (initialize) db.exec(CONTEXT_MATERIAL_SCHEMA); return {db, material: new ContextMaterialDatabase(db)};}
function document(id: string, text: string): ContextMaterialDocument {return {text, description: {reference: {id,revision:contextMaterialDigest(text)},
  originRunId: "root", source: {owner:"test",kind:"public",id,revision:"1"}, label:`Report ${id}`, role:"tool",position:1,bytes:Buffer.byteLength(text),format:"text",relationships:[],limitations:[]}};}

describe("retained context material", () => {
  it("returns exact UTF-8 pages, empty sources and boundaries without reading changed external files", () => {
    const {material} = open(), doc = document("unicode", "a".repeat(65535) + "中😀end"); material.publish(doc, "root");
    expect(material.read("root", {reference:doc.description.reference,offset:65534,length:4}).text).toBe("a中");
    expect(() => material.read("root", {reference:doc.description.reference,offset:65536})).toThrow("UTF-8");
    expect(material.read("root", {reference:doc.description.reference,offset:doc.description.bytes})).toMatchObject({text:"",nextOffset:null});
    const empty = document("empty", ""); material.publish(empty,"root"); expect(material.read("root",{reference:empty.description.reference}).complete).toBe(true);
    expect(() => material.read("sibling",{reference:doc.description.reference})).toThrow("not disclosed");
    expect(material.search("sibling",{}).matches).toEqual([]);
  });
  it("bounds no-match scanning and finds matches spanning storage chunks and scan boundaries", () => {
    const {material} = open(), doc = document("long", "x".repeat(262142)+"NEEDLE"+"y".repeat(20)); material.publish(doc,"root");
    const page = material.search("root",{query:"NEEDLE"}); expect(page.matches[0]?.byteStart).toBe(262142);
    const miss = material.search("root",{query:"absent"}); expect(miss).toMatchObject({exhausted:false,scannedBytes:262144,matches:[]});
    expect(material.search("root",{query:"absent",cursor:miss.nextCursor!}).exhausted).toBe(true);
  });
  it("freezes membership and persists exact invocation results across reopening", () => {
    const directory = mkdtempSync(join(tmpdir(),"helarc-material-test-")); directories.push(directory); const path = join(directory,"material.sqlite");
    const first = open(path); first.material.publish(document("a","alpha"),"root"); first.material.publish(document("b","beta"),"root");
    const command = {kind:"search" as const,runId:"root",invocationId:"invocation-1",input:{limit:1}};
    const page = first.material.command(command) as ReturnType<ContextMaterialDatabase["search"]>;
    first.material.publish(document("c","new arrival"),"root"); first.db.close();
    const next = open(path,false); expect(next.material.command(command)).toEqual(page);
    expect(next.material.search("root",{limit:16,cursor:page.nextCursor!}).matches.map(value=>value.description.reference.id)).toEqual(["b"]);
    expect(next.material.search("root",{}).matches).toHaveLength(3);
    expect(()=>next.material.command({...command,input:{query:"alpha"}})).toThrow("context_invocation_conflict");
    expect(()=>next.material.search("sibling",{cursor:page.nextCursor!})).toThrow("cursor");
  });
  it("acknowledges retention before transfer, isolates consumers and fences late reacquisition", () => {
    const {db,material} = open(), doc = document("report","exact source"); material.publish(doc,"root");
    const transfer = {id:"assignment",sourceRunId:"root",recipientRunId:"child",references:[doc.description.reference],basis:{kind:"assignment" as const,id:"delegation"}};
    material.prepare(transfer); expect(material.retainedOwners()).toEqual(["child"]);
    expect(()=>material.read("child",{reference:doc.description.reference})).toThrow("not disclosed");
    material.accept(transfer); material.accept(transfer); expect(material.read("child",{reference:doc.description.reference}).text).toBe("exact source");
    material.accept({...transfer,id:"request-hold",basis:{kind:"frozen_request",id:"request"}});
    material.release("assignment"); expect(material.retainedOwners()).toEqual(["child"]);
    expect(()=>material.prepare(transfer)).toThrow("released");
    material.releaseRun("child"); expect(material.retainedOwners()).toEqual([]);
    expect(()=>material.prepare({...transfer,id:"late"})).toThrow("released");
    expect(db.prepare("SELECT COUNT(*) AS n FROM context_material_holds").get()).toEqual({n:0});
  });
  it("checks content digests and rolls back a rejected transfer without publishing scope", () => {
    const {db,material} = open(), doc = document("report","body"); material.publish(doc,"root");
    expect(()=>material.command({kind:"accept",transfer:{id:"bad",sourceRunId:"root",recipientRunId:"child",references:[doc.description.reference,{id:"missing",revision:doc.description.reference.revision}],basis:{kind:"assignment",id:"d"}}})).toThrow();
    expect(material.search("child",{}).matches).toEqual([]);
    db.prepare("UPDATE context_material_chunks SET bytes=?").run(Buffer.from("oops"));
    expect(()=>material.read("root",{reference:doc.description.reference})).toThrow("integrity");
  });
  it("retains read pages independently and never inherits private reads as an explicit transfer", () => {
    const {material} = open(), doc = document("private", "read but not shared"); material.publish(doc,"root");
    material.command({kind:"read",runId:"root",invocationId:"read-1",input:{reference:doc.description.reference}});
    expect(material.retainedOwners()).toEqual(["root"]);
    expect(material.inheritedReferences("root",null)).toEqual([]);
    material.release("read-1:material-read"); expect(material.retainedOwners()).toEqual([]);
    material.release("not-yet-prepared");
    expect(()=>material.prepare({id:"not-yet-prepared",sourceRunId:"root",recipientRunId:"child",references:[doc.description.reference],basis:{kind:"assignment",id:"d"}})).toThrow("released");
  });
  it("checks accepted consumer integrity before propagating access to a continuation", () => {
    const {db,material} = open(), doc = document("report", "body"); material.publish(doc,"root");
    const transfer = {id:"shared",sourceRunId:"root",recipientRunId:"child",references:[doc.description.reference],basis:{kind:"assignment" as const,id:"d"}};
    material.accept(transfer); expect(material.inheritedReferences("child",null)).toEqual([doc.description.reference]);
    db.prepare("UPDATE context_material_consumers SET value=? WHERE id=?").run("{}","shared");
    expect(()=>material.accept(transfer)).toThrow("corrupt");
    expect(()=>material.inheritedReferences("child",null)).toThrow("corrupt");
  });
});
