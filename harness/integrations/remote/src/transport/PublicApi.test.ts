import { describe, expect, expectTypeOf, it } from "vitest";
import * as transportApi from "./index.js";
import type { RemoteOperationTransportPort } from "./index.js";

describe("remote transport public API", () => {
  it("is a type-only protocol surface", () => {
    expect(Object.keys(transportApi)).toEqual([]);
    expectTypeOf<RemoteOperationTransportPort>().toBeObject();
  });
});
