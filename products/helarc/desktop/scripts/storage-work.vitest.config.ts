import desktop from "../vitest.config.js";

export default {...desktop,test:{...desktop.test,
  include:["scripts/fixtures/storage-work.spec.mjs"],pool:"forks",maxWorkers:1,minWorkers:1,
}};
