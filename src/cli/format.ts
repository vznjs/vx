/**
 * Human-readable byte size with KB/MB/GB/TB/PB suffixes and one
 * decimal of precision below 10 of any unit. Used by `vx stats` and
 * `vx cache prune` output.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  for (const u of units) {
    if (v < 1024) return `${v.toFixed(v < 10 ? 1 : 0)} ${u}`
    v /= 1024
  }
  return `${v.toFixed(0)} PB`
}
