// An argument holding a newline was echoed raw by a refusal: the headline
// broke at it, and its second half read as the refusal's detail line
// (`vx show $'p\nq'`, `--concurrency=$'1\n2'`; fuzz, 2026-11-05).
import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve(import.meta.dir, '../src/bin.ts')

async function vx(...args: string[]): Promise<{ code: number; stderr: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-ctrl-args-'))
  try {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const stderr = await new Response(proc.stderr).text()
    return { code: await proc.exited, stderr }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

describe('an argument holding a control character', () => {
  it.each([
    [['show', 'p\nq'], 2, '"p\\nq"'],
    [['run', 'build', '--concurrency=1\n2'], 3, '"--concurrency=1\\n2"'],
    [['cache', 'x\ty'], 2, '"x\\ty"'],
  ])('%j is refused on one line, escaped, naming its position', async (args, at, shown) => {
    const r = await vx(...args)
    expect(r.code).toBe(1)
    const headline = r.stderr.split('\n')[0]!
    expect(headline).toContain(`argument ${at}`)
    expect(headline).toContain(shown)
    expect(headline).toContain('control character')
  })

  it("control: a forwarded one and a --sql query are the task's and the query's own", async () => {
    for (const args of [
      ['run', 'build', '--', 'a\nb'],
      ['last', '--sql', 'select 1\nfrom runs'],
      ['last', '--sql=select 1\nfrom runs'],
    ]) {
      const r = await vx(...args)
      expect(r.stderr).not.toContain('control character')
    }
  })
})
