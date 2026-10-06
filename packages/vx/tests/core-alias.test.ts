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
      `if (process.argv[2] === 'alias') registerCoreAlias(() => import(${JSON.stringify(CORE_INDEX)}))\n` +
      `await import('./use.mjs')\n`,
  )
  // A second entry that REGISTERS the alias and then decides whether to
  // import through it. The loader prints a marker, so the question "was the
  // facade loaded" is a line of output rather than a duration.
  await writeFile(
    path.join(root, 'lazy.ts'),
    `import { registerCoreAlias } from ${JSON.stringify(CORE_ALIAS)}\n` +
      `registerCoreAlias(async () => {\n` +
      `  console.log('LOADED')\n` +
      `  return await import(${JSON.stringify(CORE_INDEX)})\n` +
      `})\n` +
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
})

// The binary's baked plugins: the same specifier served from a table when
// the installed package is the version baked, from disk otherwise, and a
// baked module's origin is the installed package's directory.
describe('registerBakedPlugins', () => {
  async function served(installed: string): Promise<{ where: string; origin: string | null }> {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-baked-'))
    try {
      const pkg = path.join(ws, 'node_modules', '@fixture', 'plugin')
      await mkdir(pkg, { recursive: true })
      await writeFile(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: '@fixture/plugin', version: installed, main: 'index.js' }),
      )
      await writeFile(path.join(pkg, 'index.js'), "export const where = 'disk'\n")
      await writeFile(
        path.join(ws, 'entry.ts'),
        `import { registerBakedPlugins } from ${JSON.stringify(CORE_ALIAS)}\n` +
          `registerBakedPlugins({ '@fixture/plugin': async () => ({ where: 'baked' }) }, '1.0.0')\n` +
          `const { where } = await import('@fixture/plugin')\n` +
          `const origin = globalThis[Symbol.for('vx.baked-origin')].get('@fixture/plugin')\n` +
          `console.log(JSON.stringify({ where, origin: origin?.dir ?? null }))\n`,
      )
      const proc = Bun.spawn({ cmd: ['bun', 'entry.ts'], cwd: ws, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code, err).toBe(0)
      const seen = JSON.parse(out.trim()) as { where: string; origin: string | null }
      return { ...seen, origin: seen.origin && path.relative(ws, seen.origin) }
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }

  it('serves the baked copy when the installed package is the version baked', async () => {
    expect(await served('1.0.0')).toEqual({
      where: 'baked',
      origin: path.join('node_modules', '@fixture', 'plugin'),
    })
  })

  it('loads the installed copy at any other version', async () => {
    expect(await served('1.0.1')).toEqual({ where: 'disk', origin: null })
  })
})
