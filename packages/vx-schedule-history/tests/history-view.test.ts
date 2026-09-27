// `vx history`'s pretty table as a pure function (item 805): who is listed,
// the count of who is not, and the unit breaks of the p50 and the peak.
import { describe, expect, it } from 'bun:test'
import { renderHistory, type HistoryRow } from '../src/history-view.js'
import { resourceEstimates, withDeclared } from '../src/index.js'

const MB = 1024 * 1024

function row(extra: Partial<HistoryRow> & { id: string }): HistoryRow {
  return {
    runs: 1,
    p50DurationMs: null,
    maxPeakRssBytes: null,
    maxCpuParallelism: null,
    reservation: null,
    declared: false,
    ...extra,
  }
}

const table = (rows: HistoryRow[]) => renderHistory(rows, 20, { cpus: 4, memory: 1024 }, true)
const cells = (text: string, id: string): string[] =>
  text
    .split('\n')
    .find((l) => l.trimStart().startsWith(`${id} `))!
    .trim()
    .split(/\s{2,}/)

describe('renderHistory', () => {
  it('lists a task with a declared reservation and no execution; counts the rest', () => {
    const text = table([
      row({ id: 'a#t', runs: 2 }),
      row({ id: 'b#t', runs: 0, reservation: { memory: 512 }, declared: true }),
      row({ id: 'c#t', runs: 0 }),
    ])
    expect(cells(text, 'b#t')).toEqual(['b#t', '0', '—', '—', '—', '512 MB (declared)'])
    expect(text).not.toContain('c#t')
    expect(text).toContain('  1 task with no execution in the window reserves nothing\n')
    expect(
      table([row({ id: 'a#t' }), row({ id: 'b#t', runs: 0 }), row({ id: 'c#t', runs: 0 })]),
    ).toContain('  2 tasks with no execution in the window reserve nothing\n')
  })

  it.each([
    [999, '999ms'],
    [1000, '1.00s'],
    [59_999, '60.00s'],
    [60_000, '1m 0s'],
  ])('a p50 of %d ms reads %s', (ms, shown) => {
    expect(cells(table([row({ id: 'a#t', p50DurationMs: ms })]), 'a#t')[2]).toBe(shown)
  })

  it.each([
    [MB - 1, '1024 KB'],
    [MB, '1 MB'],
    [1024 * MB - 1, '1024 MB'],
    [1024 * MB, '1.0 GB'],
  ])('a peak of %d bytes reads %s', (bytes, shown) => {
    expect(cells(table([row({ id: 'a#t', maxPeakRssBytes: bytes })]), 'a#t')[3]).toBe(shown)
  })

  it('the memory budget says where it came from', () => {
    const budgets = { cpus: 4, memory: 1024 }
    expect(renderHistory([], 20, budgets, true)).toContain(' · 1024 MB (the memory option)\n')
    expect(renderHistory([], 20, budgets, false)).toContain(
      ' · 1024 MB (what this process may use)\n',
    )
  })
})

// The README's `vx history` sample showed a learned row reserving
// `· 2 cores` beside a docstring saying the reservation holds "the most
// CPU parallelism seen", while cores are never learned (lead routed by
// stream J). The sample is the renderer's output for the history it
// describes, reservations taken the plugin's way.
describe('the README sample', () => {
  it('is what `vx history` prints for the history it shows', async () => {
    const readme = await Bun.file(new URL('../README.md', import.meta.url)).text()
    const sample = readme.slice(readme.indexOf('$ vx history\n') + '$ vx history\n'.length)
    const shown = sample.slice(0, sample.indexOf('```'))
    const h = (runs: number, p50: number, rss: number | undefined, cpu: number) => ({
      runs,
      p50DurationMs: p50,
      p99DurationMs: p50,
      successRate: 1,
      hitRate: 0,
      failureMode: 'none' as never,
      ...(rss === undefined ? {} : { maxPeakRssBytes: rss }),
      maxCpuParallelism: cpu,
    })
    const history = new Map([
      ['app#build', h(12, 8410, 612 * MB, 1.9)],
      ['app#e2e', h(3, 41_200, 1.4 * 1024 * MB, 1.1)],
      ['lib#test', h(12, 1020, undefined, 1.0)],
    ])
    const ids = [...history.keys(), 'x#a', 'x#b', 'x#c']
    const declared = { 'app#e2e': { memory: 4096, cpus: 2 } }
    const reservations = withDeclared(
      resourceEstimates(new Map(ids.map((id) => [id, {} as never])), history),
      declared,
    )
    const rows = ids.map((id) => {
      const t = history.get(id)
      return row({
        id,
        runs: t?.runs ?? 0,
        p50DurationMs: t?.p50DurationMs ?? null,
        maxPeakRssBytes: t?.maxPeakRssBytes ?? null,
        maxCpuParallelism: t?.maxCpuParallelism ?? null,
        reservation: reservations.get(id) ?? null,
        declared: id in declared,
      })
    })
    expect(shown).toBe(renderHistory(rows, 20, { cpus: 4, memory: 13_567 }, false))
  })
})
