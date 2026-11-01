import {createHash} from "node:crypto";
import {snapshotContextMaterialRef,type ContextMaterialRef} from "../material/ContextMaterial.js";
import {custodyCount,custodyToken,MaterialCustodyError,type MaterialRange,type MaterialVersion} from "./MaterialCustody.js";

/** Stable material identity; no recipient, authority, custody instance or hold is encoded. */
export function materialViewReferenceId(range:MaterialRange):string {
  custodyToken(range.materialId);custodyToken(range.version);custodyCount(range.start);custodyCount(range.end);
  if(range.coordinate!=="bytes"||range.end<range.start)throw new MaterialCustodyError("material_range_invalid");
  const value={materialId:range.materialId,version:range.version,start:range.start,end:range.end,coordinate:range.coordinate};
  return `custody:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
export function materialViewReference(range:MaterialRange,version:MaterialVersion):ContextMaterialRef {
  if(range.materialId!==version.ref.materialId||range.version!==version.ref.version||range.end>version.bytes)
    throw new MaterialCustodyError("material_range_invalid");
  return snapshotContextMaterialRef({id:materialViewReferenceId(range),revision:version.digest});
}
