import {describe,it,expect} from "vitest";
import {defaultHelarcInRequestCompactionPolicy,snapshotHelarcInRequestCompactionPolicy} from "./HelarcInRequestCompactionPolicy.js";

describe("human-adopted in-request compaction policy",()=>{
  const defaults=(model="gpt-5.3-codex",protocol="openai.responses",officialEndpoint=true)=>
    defaultHelarcInRequestCompactionPolicy({model,protocol,officialEndpoint,target:"original-target"});
  it("separates documented method assurance from application evaluation",()=>{
    const policy=defaults();expect(snapshotHelarcInRequestCompactionPolicy(policy)).toEqual(policy);
    expect(policy.origin).toBe("provider_documentation");expect(policy.support).toBe("accepted");
    expect(policy.profiles[0]!.specialRequirements).toEqual([]);
    expect(policy.profiles[0]!.limitations.join(" ")).toContain("no application evaluation");
    expect(policy.trigger).toMatchObject({windowTokens:400000,thresholdTokens:200000});
  });
  it("does not infer support by name prefix, route, or another Protocol",()=>{
    for(const model of ["new-model","gpt-5.3-codex-unreviewed-snapshot"]){expect(defaults(model).support).toBe("unassessed");expect(defaults(model).profiles).toEqual([]);}
    expect(defaults("gpt-5.3-codex","openai.responses",false).support).toBe("unassessed");
    for(const protocol of ["ollama.chat","deepseek.chat-completions"])expect(defaults("same-name",protocol).support).toBe("excluded");
  });
  it("retains whole use profiles and rejects malformed or widened evidence",()=>{
    const policy=defaults(),profile=policy.profiles[0]!;
    expect(()=>snapshotHelarcInRequestCompactionPolicy({...policy,profiles:[profile,profile]})).toThrow();
    expect(()=>snapshotHelarcInRequestCompactionPolicy({...policy,profiles:[{...profile,preservation:{goals_and_constraints:"accepted"}}]})).toThrow();
    expect(()=>snapshotHelarcInRequestCompactionPolicy({...policy,trigger:{...policy.trigger,thresholdTokens:policy.trigger.windowTokens}})).toThrow();
    expect(()=>snapshotHelarcInRequestCompactionPolicy({...policy,origin:"unassessed"})).toThrow();
    expect(()=>snapshotHelarcInRequestCompactionPolicy({...policy,reviewedAt:"2026-02-31"})).toThrow();
    const frozen=snapshotHelarcInRequestCompactionPolicy(policy);
    const revised={...policy,origin:"external_evaluation" as const,basis:"Human adopted assessment",support:"excluded" as const};
    expect(snapshotHelarcInRequestCompactionPolicy(revised).support).toBe("excluded");expect(frozen.support).toBe("accepted");
  });
});
