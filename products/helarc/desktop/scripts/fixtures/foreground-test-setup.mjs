import { afterAll } from "vitest";
import { acquireForegroundTestPolicy } from "./test-execution-policy.mjs";

const restore = acquireForegroundTestPolicy();
afterAll(restore);
