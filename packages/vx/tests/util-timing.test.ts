// `util/timing.ts` reads `VX_TIMING` once, at import, so each row runs a
// child that imports it fresh under the variable it names and prints the
// table to stderr. The dry-run file proves the stages appear; this one
// holds the table's arithmetic, the span accumulation and the off switch.

import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const TIMING = path.resolve(import.meta.dir, '..', 'src', 'util', 'timing.ts')

async function child(
  body: string,
  timing: string | undefined,
  prelude = `import { mark, span, printTimings } from ${JSON.stringify(TIMING)}`,
): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env }
  if (timing === undefined) delete env.VX_TIMING
  else env.VX_TIMING = timing
  const proc = Bun.spawn([process.execPath, '-e', `${prelude}\n${body}`], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code).toBe(0)
  return out + err
}

// Marks a and b 30 ms apart after a 30 ms lead; span `fast` recorded
// first (so insertion order is not size order), then two `slow` calls
// whose SECOND is the long one.
const WORKLOAD = `
await Bun.sleep(30)
mark('a')
await Bun.sleep(30)
mark('b')
span('fast')()
span('slow')()
const end = span('slow')
await Bun.sleep(30)
end()
printTimings()
`

const markRow = /^ +(\S+) +([\d.]+)ms +([\d.]+)ms$/
const spanRow = /^ +(\S+) +([\d.]+)ms +(\d+)$/

describe('the VX_TIMING table', () => {
  it("each stage's own share is its mark less the one before", async () => {
    const lines = (await child(WORKLOAD, '1')).split('\n')
    expect(lines[0]).toMatch(/^\[vx timing\] {2}stage +own {3}cumulative$/)
    const marks = lines.slice(1, 3).map((l) => markRow.exec(l))
    expect(marks.map((m) => m?.[1])).toEqual(['a', 'b'])
    const [, , aOwn, aCum] = marks[0]!.map(Number)
    const [, , bOwn, bCum] = marks[1]!.map(Number)
    expect(aOwn).toBe(aCum!)
    expect(aCum).toBeGreaterThanOrEqual(25)
    // Rounded to 0.1 ms each, so the difference carries up to 0.2 of slack.
    expect(Math.abs(bOwn! - (bCum! - aCum!))).toBeLessThanOrEqual(0.2)
    expect(bOwn).toBeGreaterThanOrEqual(25)
  })

  it('spans accumulate per label, largest total first, under their caveat', async () => {
    const lines = (await child(WORKLOAD, '1')).split('\n')
    const at = lines.indexOf('[vx timing]  accumulated                     total   count')
    expect(at).toBe(3)
    const rows = lines.slice(at + 1, at + 3).map((l) => spanRow.exec(l))
    expect(rows.map((r) => [r?.[1], r?.[3]])).toEqual([
      ['slow', '2'],
      ['fast', '1'],
    ])
    expect(Number(rows[0]![2])).toBeGreaterThanOrEqual(25)
    expect(lines.slice(at + 3)).toEqual([
      '             (wall per call, summed; concurrent calls overlap — compare spans, not totals)',
      '',
    ])
  })

  it("the clock starts at the module's load, not the process's", async () => {
    // 50 ms of the child's own work before the import: a mark taken right
    // after it reads near zero, where a process-start origin reads ≥ 50.
    const out = await child(
      `mark('a')\nprintTimings()`,
      '1',
      `const t = Bun.nanoseconds()\nwhile (Bun.nanoseconds() - t < 50e6) {}\nconst { mark, printTimings } = await import(${JSON.stringify(TIMING)})`,
    )
    const a = markRow.exec(out.split('\n')[1] ?? '')
    expect(a?.[1]).toBe('a')
    expect(Number(a![3])).toBeLessThan(25)
  })

  it('marks without spans print no span section', async () => {
    const out = await child(`mark('a')\nprintTimings()`, '1')
    expect(out).toContain('[vx timing]  stage')
    expect(out).not.toContain('accumulated')
  })

  it('an enabled run with no marks prints nothing', async () => {
    expect(await child(`span('x')()\nprintTimings()`, '1')).toBe('')
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('VX_TIMING %s is off: nothing prints, and a span is the shared no-op', async (_, v) => {
    expect(
      await child(`${WORKLOAD}\nconsole.log(span('p') === span('q') ? 'shared' : 'fresh')`, v),
    ).toBe('shared\n')
  })
})
