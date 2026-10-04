// docs/benchmarks.md's hand-typed runner tables (rows named vx, turbo, nx)
// give every competitor cell vx's multiple against the `vx` row of the same column.
// update-site.ts --check holds only the generated table, so these are held
// here: each multiple is recomputed from the two figures the row shows, with
// update-site.ts's rounding (down when vx is faster, up when slower).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const BENCH = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')

/** A figure as the tables print it, in ms: `71 ms`, `10.58 s`, `5m 4s`. */
function ms(text: string): number {
  const t = text.replaceAll('*', '').trim()
  const m = /^(\d+)m (\d+)s$/.exec(t)
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000
  const v = /^(\d+(?:\.\d+)?) ?(ms|s)$/.exec(t)
  if (!v) throw new Error(`not a figure: ${text}`)
  return Number(v[1]) * (v[2] === 's' ? 1000 : 1)
}

function versus(ours: number, theirs: number): string {
  const faster = ours < theirs
  const r = faster ? theirs / ours : ours / theirs
  const round = faster ? Math.floor : Math.ceil
  if (r === 1) return 'vx same'
  const at = (k: number) => round(r * k) / k
  const n = r >= 10 ? round(r) : at(10) > 1 ? at(10) : at(100)
  return `vx ${n}× ${faster ? 'faster' : 'slower'}`
}

/** Each table whose first column names runners: its rows' cells, by runner. */
function tables(): Map<string, string[]>[] {
  const out: Map<string, string[]>[] = []
  let rows: Map<string, string[]> | undefined
  for (const line of BENCH.split('\n')) {
    if (!line.startsWith('|')) {
      rows = undefined
      continue
    }
    const cells = line.split('|').slice(1, -1)
    const name = cells[0]!.trim()
    if (name !== 'vx' && name !== 'turbo' && name !== 'nx') continue
    if (!rows) out.push((rows = new Map()))
    rows.set(
      name,
      cells.slice(1).map((c) => c.trim()),
    )
  }
  return out
}

describe('benchmarks.md: every vx multiple is the two figures its row shows', () => {
  it('each competitor cell’s multiple matches the vx row of its column', () => {
    const wrong: string[] = []
    let checked = 0
    for (const rows of tables()) {
      const vx = rows.get('vx')!
      for (const runner of ['turbo', 'nx']) {
        rows.get(runner)?.forEach((cell, i) => {
          const m = /^(.+?) \((vx (?:[\d.]+× (?:faster|slower)|same))\)$/.exec(
            cell.replaceAll('*', ''),
          )
          if (!m) return
          checked += 1
          const want = versus(ms(vx[i]!), ms(m[1]!))
          if (want !== m[2]) wrong.push(`${runner} ${cell}: vx ${vx[i]} gives ${want}`)
        })
      }
    }
    // Five tables: 46 packages twice, 476 twice, 3,270 on Linux.
    expect(checked).toBe(36)
    expect(wrong).toEqual([])
  })
})
