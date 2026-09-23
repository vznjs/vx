import { parseDecimalInt } from './num.js'

/**
 * Parse a byte-size string: a bare integer (`"1048576"`) or an integer
 * with a K/M/G/T suffix, powers of 1024, optional trailing `B`
 * (`"512MB"`, `"8G"`). Returns `null` for anything else — including
 * fractional sizes (`"1.5GB"`); callers wanting fractions must express
 * them in a smaller unit.
 */
export function parseSize(input: string): number | null {
  const m = input.match(/^(\d+)([KMGT])?B?$/i)
  if (!m) return null
  // Digits past 2^53 parse to a different number than the user typed.
  const n = parseDecimalInt(m[1]!)
  if (n === null) return null
  const u = (m[2] ?? '').toUpperCase()
  const mult =
    u === '' ? 1 : u === 'K' ? 1024 : u === 'M' ? 1024 * 1024 : u === 'G' ? 1024 ** 3 : 1024 ** 4
  return n * mult
}

/**
 * Parse `<n><unit>` where unit is s/m/h/d, case-insensitively (`parseSize`
 * has always been case-insensitive; this matched only lowercase, so `30D`
 * was rejected while `1GB` and `1gb` both worked).
 */
export function parseDuration(input: string): number | null {
  const m = input.match(/^(\d+)([smhd])$/i)
  if (!m) return null
  const n = parseDecimalInt(m[1]!)
  if (n === null) return null
  // Lowercase before the switch: with the /i flag an uppercase `M` would
  // otherwise fall through to the days branch.
  const unit = m[2]!.toLowerCase()
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return n * mult
}

/**
 * Human-readable byte size with KB/MB/GB/TB/PB suffixes and one
 * decimal of precision below 10 of any unit. Used by `vx info`, `vx cache prune` and the
 * run's `cacheRetention` line.
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
