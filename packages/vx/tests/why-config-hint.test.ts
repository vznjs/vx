// `vx why` on a changed config printed only two digests and a hint with
// no next step; the hint now names the `vx show` that prints the config.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { vxSync } from './helpers/vx.js'

let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args)

const config = (cmd: string): string =>
  `export default { tasks: { build: { exec: { command: '${cmd}' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n`

describe('vx why — a config change', () => {
  it('names the vx show that prints the task config', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-why-config-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const dir = path.join(root, 'packages', 'app')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(dir, 'src', 'x.ts'), 'x\n')
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
    await writeFile(path.join(dir, 'vx.config.mjs'), config('true'))
    expect(vx(root, 'run', 'build', '--all').code).toBe(0)
    await writeFile(path.join(dir, 'vx.config.mjs'), config('true && true'))
    expect(vx(root, 'run', 'build', '--all').code).toBe(0)
    const r = vx(root, 'why', 'app#build')
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(r.out.split('\n').filter((l) => l.startsWith('  config    '))).toEqual([
      "  config    the task's evaluated config changed (its vx.config or a file it imports); `vx show app#build` prints it as it is now",
    ])
    // Three vx processes: past bun's 5 s default on a loaded macOS runner.
  }, 60_000)
})

// A lockfile plugin's part moved and the advice said only "a key plugin's
// material changed": not the file whose edit moved it. A plugin that claims
// fingerprint files is named with them.
describe('vx why — a key plugin that claims a lockfile', () => {
  it('names the file the plugin keys on', async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-why-plugin-'))
    try {
      // The part is the lockfile's bytes, read as a lockfile plugin's
      // dependency closure would be.
      const plugin = pluginSource(
        'org/deps',
        `{ fingerprint: { files: ['deps.lock'], affected: () => [] }, key: () => ({ closure: require('node:fs').readFileSync(${JSON.stringify(path.join(ws, 'deps.lock'))}, 'utf8') }) }`,
      )
      await writeFile(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeFile(path.join(ws, 'package.json'), JSON.stringify({ name: 'r', private: true }))
      await Bun.write(path.join(ws, '.vx/workspace.mjs'), localWorkspaceSource([plugin]))
      const dir = path.join(ws, 'packages', 'app')
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
      await writeFile(path.join(dir, 'src', 'x.ts'), 'x\n')
      await writeFile(path.join(dir, 'vx.config.mjs'), config('true'))
      await writeFile(path.join(ws, 'deps.lock'), 'v1\n')
      expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws }).exitCode).toBe(0)
      expect(vx(ws, 'run', 'build', '--all').code).toBe(0)
      await writeFile(path.join(ws, 'deps.lock'), 'v2\n')
      expect(vx(ws, 'run', 'build', '--all').code).toBe(0)
      const r = vx(ws, 'why', 'app#build')
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(r.out).toContain('changed  plugin  org/deps/closure')
      expect(r.out.split('\n').filter((l) => l.startsWith('  plugin    '))).toEqual([
        '  plugin    org/deps keys on deps.lock: what this task reads of it moved; that plugin decides what goes into the key',
      ])
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }, 60_000)

  // One package's two plugins (`bun()` and `npm()`) share its name: the
  // claims read last-wins named only the second's lockfile, not the one
  // the key read.
  it("names every file one package's plugins key on", async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-why-plugin-'))
    try {
      // The part is the lockfile's bytes, read as a lockfile plugin's
      // dependency closure would be.
      const plugin = pluginSource(
        'org/deps',
        `{ fingerprint: { files: ['deps.lock'], affected: () => [] }, key: () => ({ closure: require('node:fs').readFileSync(${JSON.stringify(path.join(ws, 'deps.lock'))}, 'utf8') }) }`,
      )
      await writeFile(path.join(ws, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeFile(path.join(ws, 'package.json'), JSON.stringify({ name: 'r', private: true }))
      const other = pluginSource(
        'org/deps',
        `{ fingerprint: { files: ['other.lock'], affected: () => [] } }`,
      )
      await writeFile(path.join(ws, 'other.lock'), 'o\n')
      await Bun.write(path.join(ws, '.vx/workspace.mjs'), localWorkspaceSource([plugin, other]))
      const dir = path.join(ws, 'packages', 'app')
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
      await writeFile(path.join(dir, 'src', 'x.ts'), 'x\n')
      await writeFile(path.join(dir, 'vx.config.mjs'), config('true'))
      await writeFile(path.join(ws, 'deps.lock'), 'v1\n')
      expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws }).exitCode).toBe(0)
      expect(vx(ws, 'run', 'build', '--all').code).toBe(0)
      await writeFile(path.join(ws, 'deps.lock'), 'v2\n')
      expect(vx(ws, 'run', 'build', '--all').code).toBe(0)
      const r = vx(ws, 'why', 'app#build')
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(r.out).toContain('changed  plugin  org/deps/closure')
      expect(r.out.split('\n').filter((l) => l.startsWith('  plugin    '))).toEqual([
        '  plugin    org/deps keys on deps.lock, other.lock: what this task reads of them moved; that plugin decides what goes into the key',
      ])
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }, 60_000)
})
