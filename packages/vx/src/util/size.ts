import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseDecimalInt } from './num.js'

/**
 * Parse a byte-size string: a bare integer (`"1048576"`) or an integer
 * with a K/M/G/T suffix, powers of 1024, optional trailing `B` or `iB`
 * (`"512MB"`, `"8G"`, `"32KiB"`). Returns `null` for anything else — including
 * fractional sizes (`"1.5GB"`); callers wanting fractions must express
 * them in a smaller unit.
 */
export function parseSize(input: string): number | null {
  const m = input.match(/^(\d+)(?:([KMGT])(?:i?B)?|B)?$/i)
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
 * Parse `<n><unit>` where unit is ms/s/m/h/d, case-insensitively (`parseSize`
 * has always been case-insensitive; this matched only lowercase, so `30D`
 * was rejected while `1GB` and `1gb` both worked). Minutes are `m` only:
 * `M` is a month to systemd, and `--older-than 1M` read as a minute
 * empties the cache.
 */
export function parseDuration(input: string): number | null {
  const m = input.match(/^(\d+)(ms|[smhd])$/i)
  if (!m || m[2] === 'M') return null
  const n = parseDecimalInt(m[1]!)
  if (n === null) return null
  // Lowercase before the switch: with the /i flag an uppercase `M` would
  // otherwise fall through to the days branch.
  const unit = m[2]!.toLowerCase()
  const mult =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000
  return n * mult
}

/**
 * Human-readable byte size with KB/MB/GB/TB/PB suffixes and one
 * decimal of precision below 10 of any unit. Used by `vx info` and `vx cache clean`.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  // The tier is the printed value's: 1 MiB less a byte printed `1024 KB`,
  // and 10 KiB less one `10.0 KB`.
  const shown = (x: number): string => {
    const one = x.toFixed(1)
    return Number(one) < 10 ? one : x.toFixed(0)
  }
  for (const u of units) {
    if (Number(shown(v)) < 1024) return `${shown(v)} ${u}`
    v /= 1024
  }
  return `${v.toFixed(0)} PB`
}

/** Bytes under `p` on disk, links not followed; 0 when it is missing. */
export function treeBytes(p: string): number {
  const st = lstatSync(p, { throwIfNoEntry: false })
  if (st === undefined) return 0
  if (!st.isDirectory()) return st.size
  return readdirSync(p).reduce((n, e) => n + treeBytes(path.join(p, e)), 0)
}
