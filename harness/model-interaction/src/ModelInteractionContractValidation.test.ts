import {describe,it,expect} from "vitest";
import {snapshotJsonValue} from "./ModelInteractionContractValidation.js";
import {snapshotModelCallableDefinition,snapshotModelCallableDefinitions} from "./ModelCallableDefinition.js";
import {modelInputValueDigest} from "./input/ModelWorkingView.js";

describe("owned immutable model snapshots",()=>{
  it("reuses only owned snapshots, never a mutable input or an arbitrary frozen graph",()=>{
    const input={nested:{value:1}};
    const first=snapshotJsonValue(input,"input");
    expect(snapshotJsonValue(first,"again")).toBe(first);
    input.nested.value=2;
    expect(snapshotJsonValue(input,"changed")).toEqual({nested:{value:2}});
    const frozen=Object.freeze({nested:{value:1}});
    const saved=snapshotJsonValue(frozen,"untrusted");
    frozen.nested.value=3;
    expect(snapshotJsonValue(frozen,"untrusted")).toEqual({nested:{value:3}});
    expect(saved).toEqual({nested:{value:1}});
    const stable=Object.freeze({nested:Object.freeze({value:4})});
    const stableSnapshot=snapshotJsonValue(stable,"stable");
    expect(snapshotJsonValue(stable,"again")).toBe(stableSnapshot);
    expect(modelInputValueDigest(stable)).toBe(modelInputValueDigest({nested:{value:4}}));
    let answer=1;
    const accessor=Object.freeze({get value(){return answer;}});
    expect(snapshotJsonValue(accessor,"accessor")).toEqual({value:1});
    answer=2;
    expect(snapshotJsonValue(accessor,"accessor")).toEqual({value:2});
    expect(modelInputValueDigest(frozen)).not.toBe(modelInputValueDigest(saved));
    expect(()=>snapshotJsonValue(Object.freeze({bad:Infinity}),"invalid")).toThrow();
    const cycle:{next?:unknown}={};cycle.next=cycle;
    expect(()=>snapshotJsonValue(Object.freeze(cycle),"cycle")).toThrow(/cycles/);
  });
  it("retains callable limits and revalidates deserialized or modified definitions",()=>{
    const original={name:"test",description:"Test",inputSchema:{type:"object"}};
    const definition=snapshotModelCallableDefinition(original);
    expect(snapshotModelCallableDefinition(definition)).toBe(definition);
    const list=snapshotModelCallableDefinitions([definition]);
    expect(snapshotModelCallableDefinitions(list)).toBe(list);
    expect(()=>snapshotModelCallableDefinitions([...list,...list])).toThrow(/unique/);
    expect(()=>snapshotModelCallableDefinition({...definition,name:"bad name"})).toThrow();
    expect(()=>snapshotModelCallableDefinition({...definition,inputSchema:{text:"x".repeat(131073)}})).toThrow(/large/);
    const restored=JSON.parse(JSON.stringify(definition));restored.inputSchema.bad=Infinity;
    expect(()=>snapshotModelCallableDefinition(restored)).toThrow();
  });
});
