// The home guard (tests/helpers/home-guard.ts) fails a test process that
// added a store to the real home. This repository's own store is no
// fixture's: on a DTE agent the vx running the suite writes it beside a
// sandboxed shard, which cannot read `.git` to name it, and the guard failed
// the shard (2026-10-22).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'

const GUARD = path.resolve(import.meta.dir, 'helpers/home-guard.ts')
let home: string
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'vx-home-guard-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Exit code of a test process that writes a store holding `project`'s entry. */
async function guarded(project: string): Promise<number> {
  const file = path.join(home, 'writes-store.test.ts')
  await writeFile(
    file,
    `import ${JSON.stringify(GUARD)}\n` +
      `import { Database } from 'bun:sqlite'\n` +
      `import { mkdirSync } from 'node:fs'\n` +
      `import { it } from 'bun:test'\n` +
      `it('writes a store', () => {\n` +
      `  const dir = ${JSON.stringify(path.join(home, '.vx/0123456789abcdef/cache'))}\n` +
      `  mkdirSync(dir, { recursive: true })\n` +
      `  const db = new Database(dir + '/store.db')\n` +
      `  db.run('CREATE TABLE entries (hash TEXT, project TEXT)')\n` +
      `  db.run('INSERT INTO entries VALUES (?, ?)', ['h', ${JSON.stringify(project)}])\n` +
      `  db.close()\n` +
      `})\n`,
  )
  const p = Bun.spawn({
    cmd: [process.execPath, 'test', file],
    cwd: home,
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return await p.exited
}

it("passes a store holding only this repository's projects", async () => {
  expect(await guarded('@vzn/vx')).toBe(0)
})

it("fails a store holding a fixture's project", async () => {
  expect(await guarded('app')).toBe(1)
})
