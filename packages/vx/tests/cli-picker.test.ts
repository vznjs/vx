// Interactive picker smoke test — the TTY-gated path that CI never
// reaches naturally. IO is injected so no pty is needed.

import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { pickTask } from '../src/cli/select.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

let root: string

describe('vx run interactive picker', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-pick-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    for (const name of ['alpha', 'beta']) {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'true' }, description: '${name} build' } } }`,
      )
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists tasks and returns the numbered selection', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let printed = ''
    output.on('data', (c: Buffer) => {
      printed += c.toString()
    })
    const picking = pickTask(root, { input, output })
    // Give the listing a tick to render, then answer.
    await Bun.sleep(50)
    input.write('2\n')
    const picked = await picking
    expect(picked).toEqual({ project: 'beta', task: 'build', description: 'beta build' })
    expect(printed).toContain('alpha#build')
    expect(printed).toContain('beta#build')
  })

  it('lists a task a `project` plugin gave a config-less package', async () => {
    // The menu is what a run would run: a package with no config file
    // still has tasks when a plugin's `project` stage fills them.
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
        'gen',
        `{ project(config, ctx) {
        if (ctx.name === 'gamma') config.tasks.gen = { exec: { command: 'true' }, description: 'from plugin' }
      } }`,
      )}] }\n`,
    )
    const dir = path.join(root, 'packages', 'gamma')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'gamma' }))
    const input = new PassThrough()
    const output = new PassThrough()
    let printed = ''
    output.on('data', (c: Buffer) => {
      printed += c.toString()
    })
    const picking = pickTask(root, { input, output })
    await Bun.sleep(50)
    input.write('3\n')
    expect(await picking).toEqual({ project: 'gamma', task: 'gen', description: 'from plugin' })
    expect(printed).toContain('gamma#gen')
  })

  it('rejects an out-of-range selection with null', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const picking = pickTask(root, { input, output })
    await Bun.sleep(50)
    input.write('99\n')
    expect(await picking).toBeNull()
  })
})
