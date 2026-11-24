import {build} from "vite";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
await build({
  configFile:false,
  root,
  ssr:{target:"node",noExternal:[/^@agent-anything\//],external:["better-sqlite3"]},
  build:{
    ssr:"src/main/execution-storage/ExecutionStoreWorker.ts",
    outDir:"dist/main/execution-storage",
    emptyOutDir:false,
    target:"node24",
    minify:false,
    sourcemap:true,
    rolldownOptions:{output:{entryFileNames:"ExecutionStoreWorker.js",codeSplitting:false}},
  },
});

await build({
  configFile:false, root,
  ssr:{target:"node",noExternal:[/^@agent-anything\//],external:["better-sqlite3"]},
  build:{ssr:"src/main/provider/ProviderRegistryWorker.ts",outDir:"dist/main/provider",emptyOutDir:false,
    target:"node24",minify:false,sourcemap:true,
    rolldownOptions:{output:{entryFileNames:"ProviderRegistryWorker.js",codeSplitting:false}}},
});
