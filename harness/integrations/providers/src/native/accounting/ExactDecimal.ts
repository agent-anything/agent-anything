/** JSON stores decimal strings; bigint is confined to arithmetic, never persisted. */
function parts(value: string): { coefficient: bigint; scale: number } {
  if (typeof value !== "string" || value.length > 256 || !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value))
    throw new TypeError("accounting_decimal_invalid");
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(whole! + fraction), scale: fraction.length };
}
function format(coefficient: bigint, scale: number): string {
  const sign = coefficient < 0n ? "-" : "";
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "") : digits;
  return text === "0" ? "0" : sign + text;
}
export function decimal(value: string): string { const p = parts(value); return format(p.coefficient, p.scale); }
export function nonnegativeDecimal(value: string): string {
  const result = decimal(value);
  if (result.startsWith("-")) throw new TypeError("accounting_decimal_negative");
  return result;
}
export function addDecimal(left: string, right: string): string {
  const a = parts(left), b = parts(right), scale = Math.max(a.scale, b.scale);
  return format(a.coefficient * 10n ** BigInt(scale - a.scale) + b.coefficient * 10n ** BigInt(scale - b.scale), scale);
}
export function subtractDecimal(left: string, right: string): string {
  return addDecimal(left, right.startsWith("-") ? right.slice(1) : `-${right}`);
}
export function compareDecimal(left: string, right: string): number {
  const difference = parts(subtractDecimal(left, right)).coefficient;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function multiplyDecimal(left: string, right: string): string {
  const a = parts(left), b = parts(right);
  return format(a.coefficient * b.coefficient, a.scale + b.scale);
}
export function divideDecimal(numerator: string, denominator: string): string {
  const a = parts(numerator), b = parts(denominator);
  if (b.coefficient <= 0n) throw new TypeError("accounting_price_unit_invalid");
  let n = a.coefficient * 10n ** BigInt(b.scale), d = b.coefficient * 10n ** BigInt(a.scale);
  let x = n < 0n ? -n : n, y = d;
  while (y) { const remainder = x % y; x = y; y = remainder; }
  n /= x; d /= x;
  let twos = 0, fives = 0;
  while (d % 2n === 0n) { twos++; d /= 2n; }
  while (d % 5n === 0n) { fives++; d /= 5n; }
  if (d !== 1n) throw new TypeError("accounting_nonterminating_decimal");
  const scale = Math.max(twos, fives);
  return format(n * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives), scale);
}
