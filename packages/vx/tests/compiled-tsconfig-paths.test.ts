// A compiled Bun binary ignores tsconfig.json at run time unless built with
// --compile-autoload-tsconfig: a config importing a `paths` alias loaded from
// source (`bun src/bin.ts`, the npm launcher's fallback) and refused from the
// release binary with `cannot find '@tools/shared'`. vx follows such an alias
// as a config import (D-26, D-27), so the binary must load it. Built with the
// release's own flags (`compile.bun.*` in vx.config.ts).
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const root = path.resolve(import.meta.dir, '..')
const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function releaseFlags(): Promise<string[]> {
  const config = await Bun.file(path.join(root, 'vx.config.ts')).text()
  const flags = /`bun build --compile ([^`]*?) --target=/.exec(config)?.[1]
  expect(flags).toBeDefined()
  return flags!.split(/\s+/)
}

it('a binary built with the release flags loads a config through a tsconfig paths alias', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'vx-tsconfig-bin-'))
  const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-tsconfig-ws-'))
  dirs.push(out, ws)
  // Built in a copy: a compile writes its temps in its working directory.
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

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@tools/*': ['./tools/*'] } } }),
    'tools/shared.ts': "export const command = 'true'\n",
    '.vx/workspace.mjs': 'export default {}\n',
    'packages/a/package.json': JSON.stringify({ name: 'a' }),
    'packages/a/vx.config.ts': `import { command } from '@tools/shared'
export default { tasks: { build: { exec: { command } } } }
`,
  }
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(ws, rel)), { recursive: true })
    await writeFile(path.join(ws, rel), body)
  }
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws })
  const r = Bun.spawnSync({ cmd: [bin, 'lock'], cwd: ws, stdout: 'pipe', stderr: 'pipe' })
  expect(`${r.exitCode}\n${r.stdout.toString()}${r.stderr.toString()}`).toStartWith('0\n')
}, 120_000)
