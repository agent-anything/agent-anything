import { describe, expect, it } from "vitest";
import { readInspectionViewState, rememberInspectionViewState } from "./InspectionViewState.js";

describe("Ephemeral investigation view state",()=>{
  it("keeps locations separate and bounds retained widget state",()=>{
    rememberInspectionViewState("a:tab","io");
    rememberInspectionViewState("b:tab","checks");
    expect(readInspectionViewState("a:tab","overview")).toBe("io");
    expect(readInspectionViewState("b:tab","overview")).toBe("checks");
    for(let i=0;i<64;i++)rememberInspectionViewState(`bounded:${i}`,i);
    expect(readInspectionViewState("a:tab","overview")).toBe("overview");
    expect(readInspectionViewState("bounded:63",-1)).toBe(63);
  });
});
