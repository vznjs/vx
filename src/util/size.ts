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
