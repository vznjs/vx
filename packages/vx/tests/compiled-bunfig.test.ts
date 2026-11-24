// A compiled Bun binary reads `bunfig.toml` from its working directory and
// runs its `preload` in its own process unless built with
// --no-compile-autoload-bunfig: `vx --version` in a cloned workspace ran
// that workspace's code inside vx, before any config was asked for. The
// binary is built here with the release's own flags (`compile.bun.*` in
// vx.config.ts), so the test holds the binary users install.
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const root = path.resolve(import.meta.dir, '..')
const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

/** The release command's flags, less the target, the define and the paths. */
async function releaseFlags(): Promise<string[]> {
  const config = await Bun.file(path.join(root, 'vx.config.ts')).text()
  const flags = /`bun build --compile ([^`]*?) --target=/.exec(config)?.[1]
  expect(flags).toBeDefined()
  return flags!.split(/\s+/)
}

it('a binary built with the release flags runs no workspace bunfig preload', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'vx-bunfig-bin-'))
  const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-bunfig-ws-'))
  dirs.push(out, ws)
  // Built in a copy, as run-keys.test.ts does: a compile writes its temps
  // in its working directory, which a sandboxed shard may not write.
  const copy = path.join(out, 'vx')
  await cp(path.join(root, 'src'), path.join(copy, 'src'), { recursive: true })
  await cp(path.join(root, 'package.json'), path.join(copy, 'package.json'))
  await symlink(path.join(root, 'node_modules'), path.join(copy, 'node_modules'))
  await symlink(path.join(root, '..', '..', 'node_modules'), path.join(out, 'node_modules'))
  const bin = path.join(out, 'vx-bin')
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      'build',
      '--compile',
      ...(await releaseFlags()),
      'src/bin.ts',
      '--outfile',
      bin,
    ],
    cwd: copy,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(`${build.exitCode}\n${build.stderr.toString()}`).toStartWith('0\n')
  await writeFile(path.join(ws, 'bunfig.toml'), 'preload = ["./pre.ts"]\n')
  await writeFile(path.join(ws, 'pre.ts'), 'console.error("WORKSPACE PRELOAD RAN")\n')
  const r = Bun.spawnSync({ cmd: [bin, '--version'], cwd: ws, stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode).toBe(0)
  expect(r.stdout.toString() + r.stderr.toString()).not.toContain('WORKSPACE PRELOAD RAN')
}, 120_000)
