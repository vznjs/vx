// A config's bare import that no node_modules provides is refused BEFORE
// the evaluation (item 239). Left to Bun, a workspace with no node_modules
// anywhere above has the package auto-installed from the npm registry
// before "cannot find" — sixteen connections and 150 ms, measured, and a
// sandbox violation on the macOS job — and a config must never download.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { unprovidedBareImports } from '../src/workspace/config-imports.js'
import { loadProjectConfig } from '../src/workspace/project-loader.js'

describe('unprovidedBareImports', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-bare-imports-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists the bare specifiers nothing above provides, once each, and nothing else', async () => {
    await mkdir(path.join(dir, 'node_modules', '@acme', 'preset'), { recursive: true })
    await mkdir(path.join(dir, 'node_modules', 'plain'), { recursive: true })
    const src = `
      import { a } from '@acme/preset'
      import sub from '@acme/preset/deep'
      import p from 'plain'
      import q from 'plain/sub/path'
      import fs from 'node:fs'
      import os from 'os'
      import { Database } from 'bun:sqlite'
      import { defineProject } from '@vzn/vx'
      import x from 'nope-pkg'
      import y from '@nope/scoped'
      import z from 'nope-pkg'
      import rel from './preset.js'
      import type { T } from 'types-only-pkg'
    `
    // Found from a nested directory too: the walk climbs.
    const from = path.join(dir, 'packages', 'app')
    await mkdir(from, { recursive: true })
    expect(unprovidedBareImports(src, from, 'ts')).toEqual(['nope-pkg', '@nope/scoped'])
  })

  it('is empty for unparseable source: the evaluation names the syntax error', () => {
    expect(unprovidedBareImports('import { from', dir, 'ts')).toEqual([])
  })
})

describe('a config importing what no node_modules provides', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-missing-import-'))
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      "import { preset } from 'nope-pkg'\nexport default { tasks: { build: { exec: { command: 'true' }, ...preset } } }\n",
    )
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is refused before the evaluation, naming the install', async () => {
    // No node_modules anywhere above (the temp dir): the shape Bun would
    // auto-install. The refusal is vx's own — its suffix is the proof it
    // came before the import, where Bun's says only "cannot find".
    let err: Error | undefined
    try {
      await loadProjectConfig(path.join(dir, 'vx.config.mjs'))
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain(
      "cannot find 'nope-pkg' — no node_modules above the config provides it",
    )
    expect(err?.message).toContain('install the workspace')
  })

  it('CONTROL: a provided package evaluates', async () => {
    const pkg = path.join(dir, 'node_modules', 'nope-pkg')
    await mkdir(pkg, { recursive: true })
    await writeFile(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'nope-pkg', main: 'index.js' }),
    )
    await writeFile(
      path.join(pkg, 'index.js'),
      "export const preset = { description: 'from the package' }\n",
    )
    const config = await loadProjectConfig(path.join(dir, 'vx.config.mjs'))
    expect(config.tasks?.['build']?.description).toBe('from the package')
  })
})
