import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {containedInspectionPath} from "./InspectionSource.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it("checks lexical containment, each link and current real paths without caching authority",()=>{
  const root=mkdtempSync(join(tmpdir(),"inspection-path-boundary-"));roots.push(root);
  const outside=mkdtempSync(join(tmpdir(),"inspection-path-outside-"));roots.push(outside);
  mkdirSync(join(root,"plain"));writeFileSync(join(root,"plain","record"),"record");
  expect(containedInspectionPath(root,"plain","record")).toBe(join(root,"plain","record"));
  expect(containedInspectionPath(root,"future","record")).toBe(join(root,"future","record"));
  expect(()=>containedInspectionPath(root,"..","outside")).toThrow("escapes");
  symlinkSync(outside,join(root,"link"),"junction");
  expect(()=>containedInspectionPath(root,"link","record")).toThrow("links");
  expect(()=>containedInspectionPath(join(root,"link"),"record")).toThrow("link");
  rmSync(join(root,"plain"),{recursive:true});symlinkSync(outside,join(root,"plain"),"junction");
  expect(()=>containedInspectionPath(root,"plain","record")).toThrow("links");
});
