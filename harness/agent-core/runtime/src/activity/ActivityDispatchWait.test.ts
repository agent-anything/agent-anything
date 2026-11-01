import {describe,expect,it} from "vitest";
import {isActivityDispatchWaitCode} from "./ActivityDispatchWait.js";

describe("activity dispatch waiting classification",()=>{
  it.each(["activity_dependency_waiting","activity_slot_waiting","activity_schedule_turn_waiting",
    "activity_schedule_not_ready","activity_authorization_restricted"])("recognizes the original exact code %s",code=>{
    expect(isActivityDispatchWaitCode(code)).toBe(true);
  });
  it.each([undefined,null,false,0,{}, {code:"activity_schedule_not_ready"},new Error("activity_schedule_not_ready"),
    "activity_schedule_corrupt","activity_schedule_waiting","activity_schedule_not_ready:details"," activity_slot_waiting",
    "activity_control_conflict","activity_cancelled"])("does not broaden waiting to %j",code=>{
    expect(isActivityDispatchWaitCode(code)).toBe(false);
  });
});
