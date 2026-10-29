// Bun decodes argv as lossy UTF-8 and offers no raw bytes on macOS, so
// `-- $'a\xfe'` and `-- $'a\xff'` both reached the task as `a` U+FFFD and
// shared one key: the second run replayed the first's output (Turbo #14570).
import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve(import.meta.dir, '../src/bin.ts')

async function vx(args: string): Promise<{ code: number; stderr: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-nonutf8-'))
  try {
    // bash's $'…' is the only way to put bytes that are not UTF-8 in argv:
    // a JS string handed to spawn is encoded as UTF-8.
    const proc = Bun.spawn(['bash', '-c', `exec "$0" "$1" ${args}`, process.execPath, BIN], {
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

describe('an argument that is not UTF-8', () => {
  it('a forwarded one is refused, naming its position, before any workspace is read', async () => {
    const r = await vx(`run build -- $'a\\xfe'`)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('argument 4')
    expect(r.stderr).toContain('UTF-8')
  })

  it('one before `--` is refused too', async () => {
    const r = await vx(`run $'b\\xff'`)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('argument 2')
  })

  it('control: a valid UTF-8 one reaches the workspace lookup', async () => {
    const r = await vx(`run build -- 'é'`)
    expect(r.code).toBe(1)
    expect(r.stderr).not.toContain('UTF-8')
  })
})
