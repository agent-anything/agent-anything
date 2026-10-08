export const INSPECTION_STORAGE_POLICY = Object.freeze({
  datasetLimitBytes: 511 * 1024 * 1024,
  sourceLimitBytes: 2047 * 1024 * 1024,
  sourceTargetBytes: (2047 - 511) * 1024 * 1024,
  retentionDays: 7,
});
