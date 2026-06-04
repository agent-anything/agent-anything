export function parseSymptom(rawSymptom: string | undefined): string {
  return rawSymptom?.trim() ?? "";
}
