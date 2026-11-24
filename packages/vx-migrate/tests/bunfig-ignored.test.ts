// `npx @vzn/vx-migrate` and `pnpm dlx` start bin.ts by its shebang in the
// user's repo, where Bun read the repo's `bunfig.toml`: its `preload` ran
// inside vx-migrate, and one that printed broke `--dry --format json`. As
// core's bin.ts: the bunfig is the tasks' (hardening, 2026-11-24).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root = ''
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-bunfig-'))
  await writeFile(
    path.join(root, 'pre.ts'),
    "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'preloaded'), '')\n",
  )
  await writeFile(path.join(root, 'bunfig.toml'), 'preload = ["./pre.ts"]\n')
})
afterEach(() => rm(root, { recursive: true, force: true }))

it("the repo's bunfig preload never runs inside vx-migrate", () => {
  // The file itself, not `bun <file>`: the shebang is the launch under test.
  const r = Bun.spawnSync({
    cmd: [BIN, '--help'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  expect([r.exitCode, existsSync(path.join(root, 'preloaded'))]).toEqual([0, false])
})
