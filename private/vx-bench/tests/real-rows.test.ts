import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  bestReps,
  dataRow,
  formatMs,
  mergeRows,
  serializeData,
  settle,
  type DataRow,
} from '../real/rows.ts'

const META = {
  repo: 'solidjs/solid',
  version: '2.10.10',
  setup: 'native config',
  date: '2026-11-10',
  heading: 'Real repos on native config',
}

const OUT = [
  'vx cold 40600 ms exit=0',
  'turbo cold 45500 ms exit=0',
  'vx restore 70 ms exit=0',
  'turbo restore 127 ms exit=0',
  'vx noop 51 ms exit=0',
  'turbo noop 44 ms exit=0',
  'vx noop2 50 ms exit=0',
  'vx cold 39000 ms exit=1',
  'vx cold 41000 ms exit=0',
  'vx restore 66 ms exit=0',
].join('\n')

describe('real-repo rows', () => {
  it('keeps the best successful rep per tool and arm, and names each failed one', () => {
    const best = bestReps(OUT)
    expect(best.ms.get('vx cold')).toBe(40600)
    expect(best.ms.get('vx restore')).toBe(66)
    expect(best.ms.get('turbo noop')).toBe(44)
    expect(best.failed).toEqual(['vx cold exited 1'])
  })

  it('spells figures as real-repos.json does', () => {
    expect([66, 999, 1430, 3440, 40_600, 126_900].map(formatMs)).toEqual([
      '66 ms',
      '999 ms',
      '1.43 s',
      '3.44 s',
      '40.6 s',
      '126.9 s',
    ])
  })

  it('pairs vx with the rival per arm and marks the rival only where it wins', () => {
    const r = dataRow(META, 'turbo', bestReps(OUT))
    expect(r).toEqual({
      row: {
        ...META,
        tool: 'Turbo',
        cold: ['40.6 s', '45.5 s'],
        restore: ['66 ms', '127 ms'],
        noop: ['51 ms', '**44 ms**'],
      },
    })
  })

  it('names each arm a tool has no successful rep of', () => {
    const r = dataRow(META, 'nx', bestReps('vx cold 1 ms exit=0\nnx cold 2 ms exit=2'))
    expect(r).toEqual({
      missing: ['nx cold', 'vx restore', 'nx restore', 'vx noop', 'nx noop'],
    })
  })

  it('replaces the row of the same repo in place and appends a new one', () => {
    const row = (repo: string, date: string) => ({ ...META, repo, date }) as DataRow
    const merged = mergeRows(
      [row('a/a', 'old'), row('b/b', 'old')],
      [row('b/b', 'new'), row('c/c', 'new')],
    )
    expect(merged.map((r) => `${r.repo} ${r.date}`)).toEqual(['a/a old', 'b/b new', 'c/c new'])
  })

  it('waits for a quiet box, at most two minutes, and says the load it starts at', async () => {
    let t = 0
    const sleep = async (ms: number) => {
      t += ms
    }
    const falling = () => [t < 20_000 ? 3.5 : 0.4, 2, 1]
    expect(await settle(falling, sleep, () => t)).toBe('0.40 2.00 1.00')
    expect(t).toBe(20_000)
    t = 0
    expect(
      await settle(
        () => [9, 9, 9],
        sleep,
        () => t,
      ),
    ).toBe('9.00 9.00 9.00')
    expect(t).toBe(120_000)
  })

  it('writes real-repos.json back byte for byte', () => {
    const file = path.join(import.meta.dir, '../real-repos.json')
    const text = readFileSync(file, 'utf8')
    expect(serializeData(JSON.parse(text))).toBe(text)
  })
})
