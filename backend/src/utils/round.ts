/**
 * Rounds a number to a specified number of decimal places.
 *
 * @param value - The number to round.
 * @param decimals - The number of decimal places to keep. Defaults to 2.
 * @returns The rounded value.
 */
export function round(value: number, decimals: number = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
