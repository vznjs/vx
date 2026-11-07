// The `@vzn/vx` alias bin.ts registers: every `import … from '@vzn/vx'`
// a process evaluates resolves to the host's own core, not to whatever
// node_modules holds. Differential: the fixture's node_modules carries a
// FAKE `@vzn/vx`; with the alias the importer sees core's `definePlugin`,
// without it the fake.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { CORE_INDEX } from './helpers/local-workspace.js'

const CORE_ALIAS = path.resolve(import.meta.dir, '..', 'src', 'cli', 'core-alias.ts')
const CORE_CONFIG = path.resolve(import.meta.dir, '..', 'src', 'config.ts')
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-core-alias-'))
  const fake = path.join(root, 'node_modules', '@vzn', 'vx')
  await mkdir(fake, { recursive: true })
  await writeFile(
    path.join(fake, 'package.json'),
    JSON.stringify({ name: '@vzn/vx', main: 'index.js' }),
  )
  await writeFile(path.join(fake, 'index.js'), 'export const fake = true\n')
  await writeFile(
    path.join(root, 'use.mjs'),
    "import * as m from '@vzn/vx'\nconsole.log(JSON.stringify({ fake: m.fake === true, definePlugin: typeof m.definePlugin }))\n",
  )
  await writeFile(
    path.join(root, 'entry.ts'),
    `import { registerCoreAlias } from ${JSON.stringify(CORE_ALIAS)}\n` +
      `if (process.argv[2] === 'alias') registerCoreAlias(() => require(${JSON.stringify(CORE_INDEX)}), () => require(${JSON.stringify(CORE_CONFIG)}))\n` +
      `await import('./use.mjs')\n`,
  )
  // A second entry that REGISTERS the alias and then decides whether to
  // import through it. The loader prints a marker, so the question "was the
  // facade loaded" is a line of output rather than a duration.
  await writeFile(
    path.join(root, 'lazy.ts'),
    `import { registerCoreAlias } from ${JSON.stringify(CORE_ALIAS)}\n` +
      `registerCoreAlias(() => {\n` +
      `  console.log('LOADED')\n` +
      `  return require(${JSON.stringify(CORE_INDEX)})\n` +
      `}, () => require(${JSON.stringify(CORE_CONFIG)}))\n` +
      `console.log('REGISTERED')\n` +
      `if (process.argv[2] === 'import') await import('./use.mjs')\n` +
      `console.log('DONE')\n`,
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function seen(mode: 'alias' | 'plain'): Promise<{ fake: boolean; definePlugin: string }> {
  const proc = Bun.spawn({
    cmd: ['bun', 'entry.ts', mode],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(code, err).toBe(0)
  return JSON.parse(out.trim().split('\n').at(-1)!)
}

describe('registerCoreAlias', () => {
  it('serves the host core to a bare `@vzn/vx` import, over whatever node_modules holds', async () => {
    expect(await seen('alias')).toEqual({ fake: false, definePlugin: 'function' })
  })

  it('control: without the alias the importer gets the node_modules copy', async () => {
    expect(await seen('plain')).toEqual({ fake: true, definePlugin: 'undefined' })
  })

  it('does not load the façade until something actually imports `@vzn/vx`', async () => {
    // The docblock's reason for the lazy loader: "a verb that never loads a
    // plugin never loads the façade". Both rows above import through the
    // alias, so they cannot tell a lazy loader from an eager one — resolving
    // `load()` at registration, or once inside `setup`, serves the same
    // exports and passes them both. What changes is whether core's whole
    // source is transpiled for `vx --version`.
    const lazy = async (mode: 'import' | 'noimport'): Promise<string[]> => {
      const proc = Bun.spawn({
        cmd: ['bun', 'lazy.ts', mode],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code, err).toBe(0)
      return out.trim().split('\n')
    }
    // Registered, never imported: the loader must not have run.
    expect(await lazy('noimport')).toEqual(['REGISTERED', 'DONE'])
    // The control: the same entry that DOES import proves the loader is
    // reachable at all, and that it runs only once the import asks for it.
    expect(await lazy('import')).toEqual(['REGISTERED', 'LOADED', expect.any(String), 'DONE'])
  })

  // A config's `import { defineProject } from '@vzn/vx/config'`, in a
  // workspace with a node_modules and no `@vzn/vx` in it: only the bare
  // specifier was aliased, so the lock was refused ("cannot find '@vzn/vx'").
  it('serves `@vzn/vx/config` to a config too', async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-core-alias-config-'))
    try {
      Bun.spawnSync(['git', 'init', '-q'], { cwd: ws })
      await mkdir(path.join(ws, 'node_modules', 'other'), { recursive: true })
      await mkdir(path.join(ws, '.vx'))
      await writeFile(path.join(ws, '.vx', 'workspace.ts'), 'export default {}\n')
      await writeFile(
        path.join(ws, 'vx.config.ts'),
        "import { defineProject } from '@vzn/vx/config'\nexport default defineProject({ tasks: { b: { exec: { command: 'true' } } } })\n",
      )
      const r = Bun.spawnSync(['bun', BIN, 'lock'], { cwd: ws, stderr: 'pipe', stdout: 'pipe' })
      expect([r.exitCode, r.stderr.toString()]).toEqual([0, ''])
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
