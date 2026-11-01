import { app, dialog } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
if (process.env.HELARC_SMOKE_TRANSPORT_DIAGNOSTICS === "1") {
  const fetch = globalThis.fetch;
  globalThis.smokeTransportStats = [];
  globalThis.fetch = async (...args) => {
    const body = JSON.parse(args[1].body);
    const stats = {
      startedAt: Date.now(),
      responseAt: 0,
      firstChunkAt: 0,
      lastChunkAt: 0,
      chunks: 0,
      bytes: 0,
      stream: body.stream,
      systemMessages: body.messages.filter(
        (message) => message.role === "system",
      ).length,
    };
    globalThis.smokeTransportStats.push(stats);
    const response = await fetch(...args);
    stats.responseAt = Date.now();
    stats.contentType = response.headers.get("content-type");
    stats.transferEncoding = response.headers.get("transfer-encoding");
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      json: () => response.json(),
      body: response.body?.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            stats.firstChunkAt ||= Date.now();
            stats.lastChunkAt = Date.now();
            stats.chunks++;
            stats.bytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      ),
    };
  };
}
app.setPath("userData", process.env.HELARC_SMOKE_USER_DATA);
process.env.LOCALAPPDATA=join(app.getPath("userData"),"local");
delete process.env.HELARC_RENDERER_DEV_SERVER_URL;
const endpoint=process.env.HELARC_SMOKE_ENDPOINT;
if(endpoint){
  process.env.HELARC_PROVIDER_KIND=process.env.HELARC_SMOKE_PROVIDER_KIND??"ollama";
  process.env.HELARC_PROVIDER_BASE_URL=endpoint;
  process.env.HELARC_PROVIDER_MODEL=process.env.HELARC_SMOKE_MODEL??"test-model";
  process.env.HELARC_PROVIDER_TIMEOUT_MS=process.env.HELARC_SMOKE_TIMEOUT_MS??"10000";
  process.env.HELARC_OLLAMA_CONTEXT_WINDOW_TOKENS=process.env.HELARC_SMOKE_CONTEXT_WINDOW??"163840";
  delete process.env.HELARC_PROVIDER_API_KEY;
  const workspace=join(app.getPath("userData"),"workspace");
  await mkdir(workspace,{recursive:true});
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[workspace]});
  app.on("browser-window-created",(_event,window)=>{
    window.webContents.once("did-finish-load",()=>{
      void window.webContents.executeJavaScript('window.helarc.chooseWorkspace({commandId:"smoke-workspace"})')
        .catch(error=>{console.error(error);app.exit(1);});
    });
  });
}else{
  delete process.env.HELARC_PROVIDER_MODEL;
}
// Use the actual application composition, including shared activity/recovery ownership.
await import("../dist/main/main.js");
