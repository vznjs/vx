// The words a user reads when a workspace file is broken, pinned whole: a
// config that throws names its own line, and a missing import names the
// specifier. A config is evaluated only by `vx lock`, so its words are the
// lock's. Core reads no manifest; @vzn/vx-migrate's suite pins its words.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** `vx <args>` over one member `p`; stderr with the root as `<root>`. */
const vx = async (files: Record<string, string | Uint8Array>, args: string[]) => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-load-msg-')))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["p"]}')
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  await mkdir(path.join(root, 'p'))
  for (const [rel, body] of Object.entries({ 'p/package.json': '{"name":"p"}', ...files })) {
    await writeFile(path.join(root, rel), body)
  }
  const proc = Bun.spawn(['bun', BIN, ...args], {
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

it('a config that throws names the error and its own line', async () => {
  expect(await vx({ 'p/vx.config.ts': "\nthrow new Error('boom')\n" }, ['lock'])).toEqual({
    code: 1,
    err: '✗ vx lock  lock not written\n\n  Project config <root>/p/vx.config.ts threw: boom (at <root>/p/vx.config.ts:2:11)',
    planned: false,
  })
})

// A config that wraps a failure (`new Error(msg, { cause })`) puts the
// reason in the cause, and vx printed only the wrapper.
it('a config that throws a wrapped error names its cause too', async () => {
  const body = "\nthrow new Error('outer', { cause: new Error('inner') })\n"
  const want = (kind: string, file: string) =>
    `✗ vx lock  lock not written\n\n  ${kind} config <root>/${file} threw: outer (at <root>/${file}:2:11); caused by: inner (at <root>/${file}:2:39)`
  expect((await vx({ 'p/vx.config.ts': body }, ['lock'])).err).toBe(
    want('Project', 'p/vx.config.ts'),
  )
  expect((await vx({ '.vx/workspace.mjs': body }, ['lock'])).err).toBe(
    want('Workspace', '.vx/workspace.mjs'),
  )
})

it('a config importing a missing file names the specifier', async () => {
  expect(
    await vx({ 'p/vx.config.ts': "import x from './nope.ts'\nexport default x\n" }, ['lock']),
  ).toEqual({
    code: 1,
    err: "✗ vx lock  lock not written\n\n  Project config <root>/p/vx.config.ts: cannot find './nope.ts'",
    planned: false,
  })
})
