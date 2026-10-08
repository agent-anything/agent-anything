import { describe, expect, it } from "vitest";
import { readOperationLimitFailureDetail } from "./OperationLimitFailureDetail.js";

const detail = {kind: "capacity", stage: "admission", scope: {owner: "test-owner", kind: "operation"},
  limit: {name: "requests", count: 2, maximum: 2}, dispatch: "never_dispatched",
  description: "Request capacity reached before dispatch."} as const;

describe("OperationLimitFailureDetail", () => {
  it("projects only bounded owner-defined facts, not arbitrary nested diagnostics", () => {
    const result = readOperationLimitFailureDetail({...detail, secret: "private", metadata: {raw: "private"},
      scope: {...detail.scope, secret: "private"}, limit: {...detail.limit, secret: "private"}});
    expect(result).toEqual(detail);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.scope)).toBe(true);
    expect(Object.isFrozen(result?.limit)).toBe(true);
  });

  it.each([
    {kind: "unknown"}, {stage: ""}, {stage: "a".repeat(129)}, {scope: "global"},
    {scope: {owner: "owner", kind: "not a token"}}, {dispatch: "dispatched"},
    {description: ""}, {description: "a".repeat(1_001)}, {limit: null},
    ...[1, -1, Infinity, 2.5].map(count => ({limit: {...detail.limit, count}})),
    ...[0, null, Number.MAX_SAFE_INTEGER + 1, 1.5].map(maximum => ({limit: {...detail.limit, maximum}})),
  ])("rejects malformed or contradictory detail %j", override => {
    expect(readOperationLimitFailureDetail({...detail, ...override})).toBeNull();
  });

  it("rejects missing and unstructured values", () => {
    for (const value of [null, undefined, "limit_exceeded", [], {}]) {
      expect(readOperationLimitFailureDetail(value)).toBeNull();
    }
  });

  it("preserves different owners' public limit vocabulary without interpreting policy", () => {
    const anotherOwner = {...detail, kind: "limit", stage: "scheduling",
      scope: {owner: "test-scheduler", kind: "queue"}, limit: {name: "queued_jobs", count: 3, maximum: 2}};
    expect(readOperationLimitFailureDetail(anotherOwner)).toEqual(anotherOwner);
  });
});
