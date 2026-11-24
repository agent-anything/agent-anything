export function validWorkInputBudget(tokens:unknown):tokens is number {
  return typeof tokens==="number" && Number.isSafeInteger(tokens) && tokens>0;
}
