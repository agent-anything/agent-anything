import {createDefaultHelarcContextSettings,contextSettingsSnapshot,type HelarcContextSettingsSnapshot} from "@agent-anything/helarc/configuration";
import {SerializedAtomicFile,type SerializedAtomicFileOptions} from "../persistence/SerializedAtomicFile.js";

export class FileHelarcContextSettingsStore {
  private readonly file:SerializedAtomicFile;
  constructor(path:string,options:SerializedAtomicFileOptions={}) {this.file=new SerializedAtomicFile(path,options);}
  load():Promise<HelarcContextSettingsSnapshot> {return this.file.transact(async file=>read(await file.readText()));}
  save(value:unknown,expectedRevision:string):Promise<HelarcContextSettingsSnapshot> {
    const snapshot=contextSettingsSnapshot(value);
    return this.file.transact(async file=>{
      const current=read(await file.readText());
      if(current.revision!==expectedRevision)throw new TypeError("context_settings_revision_changed");
      await file.replaceText(JSON.stringify({formatVersion:1,...snapshot},null,2));return snapshot;
    });
  }
}
function read(text:string|null):HelarcContextSettingsSnapshot {
  if(text===null)return contextSettingsSnapshot(createDefaultHelarcContextSettings());
  const value=JSON.parse(text);
  if(!value||value.formatVersion!==1||Object.keys(value).length!==3)throw new TypeError("context_settings_format_invalid");
  const snapshot=contextSettingsSnapshot(value.settings);
  if(value.revision!==snapshot.revision)throw new TypeError("context_settings_integrity_invalid");
  return snapshot;
}
