// A process out of file descriptors (`EMFILE`) failed a restore as a
// "corrupt artifact" and a save with the bare errno: the first sent the
// reader after a cache that was fine, the second named a file that was
// fine. Each now names the limit to raise (A-39). A child under a low
// `ulimit -n` holds every descriptor it can before the call, so the
// cache's first open is refused as a full table refuses it.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const HINT = 'the process is out of file descriptors; raise the limit (ulimit -n 4096) and re-run'
const CACHE = path.resolve(import.meta.dir, '..', 'src', 'cache', 'index.ts')

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-fds-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Save `p/dist/a.js` (or restore it after a save), with the fd table full for the call. */
async function outOfFds(
  op: 'save' | 'restore' | 'open',
): Promise<{ name: string; message: string }> {
  const script = path.join(root, 'probe.ts')
  await Bun.write(
    script,
    `import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { Cache } from ${JSON.stringify(CACHE)}
const root = ${JSON.stringify(root)}
const proj = root + '/p'
mkdirSync(proj + '/dist', { recursive: true })
writeFileSync(proj + '/dist/a.js', 'x')
const cache = new Cache(root + '/cache')
const args = { hash: 'h1', projectDir: proj, outputFiles: [proj + '/dist/a.js'], entry: { taskId: 'p#b', command: 'x', durationMs: 1, stdout: '' } }
if (${JSON.stringify(op)} === 'restore') await cache.save(args)
const held = []
if (${JSON.stringify(op)} === 'open') cache.close()
try { for (;;) held.push(openSync('/dev/null', 'r')) } catch {}
// One free: the directory's own writes succeed, and SQLite's -wal or
// -shm is the open the table refuses.
if (${JSON.stringify(op)} === 'open') closeSync(held.pop())
let out
try {
  const op = ${JSON.stringify(op)}
  await (op === 'open' ? new Cache(root + '/cache') : op === 'save' ? cache.save(args) : cache.restoreOutputs('h1', proj, root))
  out = { name: 'none', message: '' }
} catch (e) {
  out = { name: e.name, message: e.message }
}
for (const fd of held) closeSync(fd)
console.log(JSON.stringify(out))
`,
  )
  const proc = Bun.spawn(
    ['sh', '-c', `ulimit -n 128 && exec "$0" "$1"`, process.execPath, script],
    {
      stdout: 'pipe',
      stderr: 'inherit',
    },
  )
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  expect(code).toBe(0)
  return JSON.parse(text)
}

describe('a process out of file descriptors', () => {
  it('fails a restore with the limit to raise, not as a corrupt artifact', async () => {
    const artifact = path.join(root, 'cache', 'h1.tar.zst')
    expect(await outOfFds('restore')).toEqual({
      name: 'UserError',
      message: `restore of h1 into ${root}/p could not open a file (EMFILE: too many open files, open '${artifact}') — ${HINT}`,
    })
  })

  it('fails a save with the limit to raise', async () => {
    const output = path.join(root, 'p', 'dist', 'a.js')
    expect(await outOfFds('save')).toEqual({
      name: 'UserError',
      message: `save of h1 could not open a file (EMFILE: too many open files, open '${output}') — ${HINT}`,
    })
  })
})

describe('opening the cache out of file descriptors', () => {
  it('names the limit, not a bare SQLite error (A-56)', async () => {
    expect(await outOfFds('open')).toEqual({
      name: 'UserError',
      message: `the cache index ${root}/cache/cache.db could not be opened (unable to open database file) — ${HINT}`,
    })
  })

  it('control: an index SQLite cannot open for another reason keeps its own error', async () => {
    const { mkdirSync } = await import('node:fs')
    const { Cache } = await import('../src/cache/index.js')
    mkdirSync(path.join(root, 'cache', 'cache.db'), { recursive: true })
    const err = await Promise.resolve()
      .then(() => new Cache(path.join(root, 'cache')))
      .then(
        () => null,
        (e: unknown) => e as Error,
      )
    expect([err?.name, err?.message.includes(HINT)]).toEqual(['SQLiteError', false])
  })
})
