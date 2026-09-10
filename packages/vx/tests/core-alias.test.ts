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
})
