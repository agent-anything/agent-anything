export interface TaskRef {
  readonly id: string;
}

export function snapshotTaskRef(input: TaskRef, field = "TaskRef"): TaskRef {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${field} must be an object.`);
  }
  if (Object.keys(input).some((key) => key !== "id")) {
    throw new TypeError(`${field} contains an unsupported field.`);
  }
  if (
    typeof input.id !== "string" ||
    input.id.length === 0 ||
    input.id !== input.id.trim()
  ) {
    throw new TypeError(`${field}.id must be a non-empty canonical string.`);
  }
  return Object.freeze({ id: input.id });
}
