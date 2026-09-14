import { describe, expect, it } from "vitest";
import type { InspectionGraph } from "@agent-anything/inspection/query";
import type { InspectionLink, InspectionSubjectRef } from "@agent-anything/inspection/records";
import { dataFlowNeighborhood, dataObjectTitle, defaultDataFocus, shortDataIdentity } from "./DataFlowModel.js";

const ref = (id: string, kind: InspectionSubjectRef["kind"] = "contribution", revision: string | null = null): InspectionSubjectRef => ({ sourceId: "source", datasetId: "dataset", owner: "owner", kind, id, revision, runId: "root" });
const a = ref("a"), b = ref("b"), c = ref("c"), d = ref("d");
const link = (id: string, from: InspectionSubjectRef, to: InspectionSubjectRef, kind: InspectionLink["kind"] = "includes"): InspectionLink => ({id,from,to,kind,operation:null,condition:null,sourceLocation:null,targetLocation:null,establishedBy:`record-${id}`});
const graph = (links: InspectionLink[]): InspectionGraph => ({ nodes:[a,b,c,d].map(subject=>({subject,record:null,availability:"not_observed"})),links,scope:"dataset",limited:false,nodeLimit:300,edgeLimit:1000 });

describe("recorded data-flow presentation", () => {
  it("keeps parallel records distinct, isolates immediate neighbors and preserves direction", () => {
    const input = graph([link("1",a,b),link("2",a,b,"transforms"),link("3",b,c),link("4",c,d),link("5",b,b)]);
    const result = dataFlowNeighborhood(input,b,"all");
    expect(result.incoming.map(n=>n.node.subject.id)).toEqual(["a"]);
    expect(result.incoming[0]!.links.map(l=>l.id)).toEqual(["1","2"]);
    expect(result.outgoing.map(n=>n.node.subject.id)).toEqual(["c"]);
    expect(result.links.map(l=>l.id)).toEqual(["1","2","3","5"]);
    expect(input.links).toHaveLength(5);
  });
  it("does not conflate revisions, missing endpoints, or omitted data with inclusion", () => {
    const revised = ref("a","contribution","2");
    const input = graph([link("1",a,b),link("2",revised,b,"omits")]);
    const result = dataFlowNeighborhood(input,b,"all");
    expect(result.incoming).toHaveLength(2);
    expect(result.incoming[1]!.node).toEqual({subject:revised,record:null,availability:"not_observed"});
    expect(dataFlowNeighborhood(input,b,"omits").links.map(l=>l.id)).toEqual(["2"]);
  });
  it("prefers model interaction requests from the scoped Run without inventing names", () => {
    const request = {...ref("root:model-input:1", "request"),owner:"model-interaction"};
    const other = {...request,id:"child-request",runId:"child"};
    const input: InspectionGraph = {...graph([]), nodes:[...graph([]).nodes,{subject:other,record:null,availability:"not_observed"},{subject:request,record:null,availability:"not_observed"}]};
    expect(defaultDataFocus(input,"root")!.subject).toEqual(request);
    expect(shortDataIdentity(request)).toBe("model-input:1");
    expect(dataObjectTitle(defaultDataFocus(input,"root")!)).toBe("Model request");
  });
});
