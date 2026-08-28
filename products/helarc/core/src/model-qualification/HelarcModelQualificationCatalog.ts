import { createHelarcModelQualificationCatalog } from "./HelarcModelQualification.js";

// Production decisions are added only with retained evidence for an exact target.
export const HELARC_MODEL_QUALIFICATION_CATALOG =
  createHelarcModelQualificationCatalog({ decisions: [] });
