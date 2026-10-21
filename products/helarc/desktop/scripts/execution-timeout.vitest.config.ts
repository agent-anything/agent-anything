import desktop from "../vitest.config.js";

export default {...desktop, test: {...desktop.test,
  include: ["src/main/run/fixtures/ExecutionTimeout.spec.ts"],
  pool: "forks", maxWorkers: 1, minWorkers: 1, hookTimeout: 10000,
}};
