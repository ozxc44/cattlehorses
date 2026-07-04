/**
 * Formats a byte count into a human-readable string.
 *
 * Uses binary units (B, KB, MB, GB) with one fractional digit when the value
 * is 1.0 or greater. Falls back to bytes when the input is negative.
 *
 * @param bytes - The number of bytes to format.
 * @returns A human-readable representation such as "1.5 MB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0) {
    return `${bytes} B`;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${value} ${units[unitIndex]}`;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
