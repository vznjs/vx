// vx run from source (the bin.ts shebang, or the npm launcher's source
// fallback on a platform with no prebuilt binary) is `bun <bin.ts>` in the
// user's directory, and Bun reads `bunfig.toml` there: a workspace's
// `preload` ran inside vx, and one that printed broke `--format json`.
// The bunfig is for the tasks' own `bun` commands, never vx's process; the
// release binary is built with --no-compile-autoload-bunfig for the same
// reason (hardening, 2026-11-24).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { BIN } from './helpers/vx.js'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-bunfig-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  await writeFile(
    path.join(root, 'pre.ts'),
    "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'preloaded'), '')\nconsole.log('PRELOAD')\n",
  )
  await writeFile(path.join(root, 'bunfig.toml'), 'preload = ["./pre.ts"]\n')
})
afterEach(() => rm(root, { recursive: true, force: true }))

it("the workspace's bunfig preload never runs inside vx", () => {
  // The file itself, not `bun <file>`: the shebang is the launch under test.
  const r = Bun.spawnSync({
    cmd: [BIN, '--version'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  expect({
    code: r.exitCode,
    out: r.stdout.toString().includes('PRELOAD'),
    ran: existsSync(path.join(root, 'preloaded')),
  }).toEqual({ code: 0, out: false, ran: false })
})

it("CONTROL: a task's own bun reads it", async () => {
  const r = Bun.spawnSync({ cmd: [process.execPath, '-e', '0'], cwd: root })
  expect([r.exitCode, existsSync(path.join(root, 'preloaded'))]).toEqual([0, true])
})
