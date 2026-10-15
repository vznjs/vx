// The words a user reads when a member's package.json is broken, pinned
// whole: an unparseable manifest names its file, and one saved with a
// byte-order mark (Windows editors) reads as if it had none (core's until
// M, 2026-10-14, when manifests left core).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** `vx-migrate --dry` over one member `p`; stderr with the root as `<root>`. */
const migrate = async (manifest: string | Uint8Array) => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-load-msg-')))
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["p"]}')
  await mkdir(path.join(root, 'p'))
  await writeFile(path.join(root, 'p', 'package.json'), manifest)
  const proc = Bun.spawn([process.execPath, '--no-install', BIN, '--dry'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, err: err.replaceAll(root, '<root>').trim(), planned: out.includes('build: {') }
}

it('an unparseable manifest names its file', async () => {
  expect(await migrate('{"name":"p",}')).toEqual({
    code: 1,
    err: 'vx-migrate: failed to parse <root>/p/package.json: JSON Parse error: Property name must be a string literal',
    planned: false,
  })
})

it('a manifest saved with a byte-order mark reads as one without', async () => {
  const bom = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    ...new TextEncoder().encode('{"name":"p","scripts":{"build":"echo"}}'),
  ])
  expect(await migrate(bom)).toEqual({ code: 0, err: '', planned: true })
})
