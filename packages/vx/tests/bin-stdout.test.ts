// The CLI's stdout reaches a pipe whole. Bun 1.4.2 drops what a pipe has
// not yet taken when `process.exit` follows a large write — 300 KB written
// then exit delivered 64 KiB, and `vx history --format json` on a
// 300-project workspace was cut mid-string at 128 KiB (2026-09-15). bin.ts
// ends stdout and exits in its callback; this spawns the real entry point
// with a verb whose JSON is far past the pipe's buffer and parses it whole.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const BIG = 2 * 1024 * 1024
let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-bin-stdout-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  const app = path.join(root, 'packages', 'app')
  await mkdir(app, { recursive: true })
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
  // One task whose description alone is past every pipe buffer.
  await writeFile(
    path.join(app, 'vx.config.mjs'),
    `export default { tasks: { build: { description: ${JSON.stringify('d'.repeat(BIG))}, exec: { command: 'true' } } } }\n`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

// The reader starts late on purpose: a pipe holds 64 KiB, so a reader that
// drains at once can take everything before the process exits and the pin
// proves nothing. With the reader asleep, the old exit path loses whatever
// the pipe could not hold; the fixed one waits for the reader.
async function vx(args: string[], readAfterMs = 500): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = Bun.sleep(readAfterMs).then(() => new Response(proc.stdout).text())
  const [text, code] = await Promise.all([out, proc.exited])
  return { code, out: text }
}

describe('bin.ts: stdout reaches a pipe whole before the process exits', () => {
  it('a JSON answer past the pipe buffer parses whole', async () => {
    const r = await vx(['show', 'app', '--format', 'json'])
    expect(r.code).toBe(0)
    expect(r.out.length).toBeGreaterThan(BIG)
    const parsed = JSON.parse(r.out) as { config: { tasks: { build: { description: string } } } }
    expect(parsed.config.tasks.build.description.length).toBe(BIG)
  }, 30_000)

  it('the exit code still passes through', async () => {
    const r = await vx(['show', 'nope'])
    expect(r.code).not.toBe(0)
  }, 30_000)
})
