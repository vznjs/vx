// The words a user reads when a workspace file is broken, pinned whole: a
// config that throws names its own line, a missing import names the
// specifier, an unparseable manifest names its file, and a manifest saved
// with a byte-order mark (Windows editors) is read as if it had none. A
// config is evaluated only by `vx lock`, so its words are the lock's.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const LOCKED_BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const RUN = ['run', 'build', '--all', '--dry']
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** `vx <args>` over one member `p`; stderr with the root as `<root>`. */
const vx = async (files: Record<string, string | Uint8Array>, args: string[], bin = BIN) => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-load-msg-')))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["p"]}')
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  await mkdir(path.join(root, 'p'))
  for (const [rel, body] of Object.entries({ 'p/package.json': '{"name":"p"}', ...files })) {
    await writeFile(path.join(root, rel), body)
  }
  const proc = Bun.spawn(['bun', bin, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', VX_LOCK_REVIEW_FILES: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, err: err.replaceAll(root, '<root>').trim(), planned: out.includes('p#build') }
}

const TASK = "export default { tasks: { build: { exec: { command: 'echo' } } } }\n"

it('a config that throws names the error and its own line', async () => {
  expect(await vx({ 'p/vx.config.ts': "\nthrow new Error('boom')\n" }, ['lock'])).toEqual({
    code: 1,
    err: 'vx: Error: boom\n    at <root>/p/vx.config.ts:2:11',
    planned: false,
  })
})

it('a config importing a missing file names the specifier', async () => {
  expect(
    await vx({ 'p/vx.config.ts': "import x from './nope.ts'\nexport default x\n" }, ['lock']),
  ).toEqual({
    code: 1,
    err: "vx lock: .vx/projects.lock.json not written: Project config <root>/p/vx.config.ts: cannot find './nope.ts'",
    planned: false,
  })
})

it('an unparseable manifest names its file', async () => {
  expect(await vx({ 'p/package.json': '{"name":"p",}' }, RUN)).toEqual({
    code: 1,
    err: 'vx: failed to parse <root>/p/package.json: JSON Parse error: Property name must be a string literal',
    planned: false,
  })
})

it('a manifest saved with a byte-order mark reads as one without', async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"name":"p"}')])
  expect(await vx({ 'p/package.json': bom, 'p/vx.config.ts': TASK }, RUN, LOCKED_BIN)).toEqual({
    code: 0,
    err: '',
    planned: true,
  })
})
