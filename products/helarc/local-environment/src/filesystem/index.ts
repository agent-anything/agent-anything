export { createLocalCodeSourcePort } from "./LocalCodeSource.js";
export {
  HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS,
  createHelarcLocalFileActionCapability,
} from "./LocalFileActionCapability.js";
export type {
  CreateHelarcLocalFileActionCapabilityInput,
  HelarcLocalFileActionCapability,
} from "./LocalFileActionCapability.js";
export { defaultCodeAgentFileLimits } from "./FileSystemLimits.js";
export {
  createCodeAgentCanonicalWorkspaceRoots,
  inspectPreparedFileSystemTarget,
  prepareFileSystemTarget,
} from "./FileSystemTarget.js";
export type { PreparedFileSystemTarget } from "./FileSystemTarget.js";
export { FILE_MATERIAL_POLICY, snapshotFileMaterialPreparation, validFileDigest } from "./FileMaterial.js";
export type { FileMaterialPreparation, FileMaterialRecord, FileMaterialRecordPort, FileMaterialReservation, FileMaterialRead, FileMaterialObservation, FileMaterialObserver } from "./FileMaterial.js";
export { captureFilePreimage } from "./FilePreimageCapture.js";
export type { FilePreimageCapture } from "./FilePreimageCapture.js";
export { restoreBoundFileContent } from "./FileContentRestoration.js";
export type { FileContentRestorationInput, FileContentRestorationResult } from "./FileContentRestoration.js";
export { fileAncestryIdentity } from "./FileSupportCapture.js";
export type { FileSupportServices } from "./FileSupportCapture.js";
