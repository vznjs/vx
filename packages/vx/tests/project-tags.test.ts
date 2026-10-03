// Project `tags` end to end: `--filter tag:<pattern>` (and Nx's
// `--projects tag:`) selects by the staged config's tags, a `project`
// plugin's included; an unknown tag fails as an unknown name does; `vx
// show` lists them; and a tag is in no cache key.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dry, PARITY_TIMEOUT, planned, vx } from './helpers/parity.js'
import { pluginSource } from './helpers/plugin.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const config = (tags: string, command = 'echo build') => `export default {
  ${tags}
  tasks: {
    build: {
      exec: { command: '${command}' },
      dependsOn: ['^build'],
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
}
`

let root: string

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-tags-' })
  // app -> ui -> lib; docs standalone.
  await addProject(root, 'lib', { config: config("tags: ['type:lib'],") })
  await addProject(root, 'ui', {
    config: config("tags: ['scope:web', 'type:lib'],"),
    deps: { lib: 'workspace:*' },
  })
  await addProject(root, 'app', {
    config: config("tags: ['scope:web', 'type:app'],"),
    deps: { ui: 'workspace:*' },
  })
  await addProject(root, 'docs', { config: config('') })
  // A `project` plugin gives docs a tag its config does not carry.
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'tagger',
        `{ project(config, ctx) { if (ctx.name === 'docs') config.tags = ['type:docs'] } }`,
      ),
    ]),
  )
}, PARITY_TIMEOUT)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('--filter tag:<pattern>', () => {
  it(
    'selects the projects carrying the tag, and composes with the DSL',
    async () => {
      expect(await planned(root, ['build', '--filter', 'tag:scope:web'])).toEqual([
        'app#build',
        'lib#build',
        'ui#build',
      ])
      expect(
        await planned(root, ['build', '--filter', 'tag:type:*', '--exclude-dependencies']),
      ).toEqual(['app#build', 'docs#build', 'lib#build', 'ui#build'])
      expect(
        await planned(root, ['build', '--filter', '!tag:type:lib', '--exclude-dependencies']),
      ).toEqual(['app#build', 'docs#build'])
      expect(
        await planned(root, ['build', '--filter', '...^tag:type:lib', '--exclude-dependencies']),
      ).toEqual(['app#build', 'ui#build'])
      // Nx's spelling reaches the same selector.
      expect(
        await planned(root, ['build', '--projects', 'tag:type:app', '--exclude-dependencies']),
      ).toEqual(['app#build'])
    },
    PARITY_TIMEOUT,
  )

  it(
    'sees a tag a `project` plugin gave',
    async () => {
      expect(await planned(root, ['build', '--filter', 'tag:type:docs'])).toEqual(['docs#build'])
    },
    PARITY_TIMEOUT,
  )

  it(
    'an unknown tag fails as an unknown name does, naming the nearest tag',
    async () => {
      const r = await vx(root, ['run', 'build', '--filter', 'tag:scope:wbe', '--dry=json'])
      expect(r.code).toBe(1)
      expect(r.err).toContain(
        'no projects matched filter(s): tag:scope:wbe. Did you mean tag:scope:web?',
      )
      const far = await vx(root, ['run', 'build', '--filter', 'tag:zzzzzz', '--dry=json'])
      expect(far.err).toContain(
        'no projects matched filter(s): tag:zzzzzz. Tags: scope:web, type:app, type:docs, type:lib',
      )
    },
    PARITY_TIMEOUT,
  )
})

describe('vx show lists tags', () => {
  it(
    'in the list, both formats, and in one project',
    async () => {
      const json = await vx(root, ['show', '--format', 'json'])
      expect(json.code).toBe(0)
      const rows = JSON.parse(json.out) as { name: string; tags: string[] }[]
      expect(Object.fromEntries(rows.map((r) => [r.name, r.tags]))).toEqual({
        app: ['scope:web', 'type:app'],
        docs: ['type:docs'],
        lib: ['type:lib'],
        ui: ['scope:web', 'type:lib'],
      })
      const pretty = await vx(root, ['show'])
      expect(pretty.out).toMatch(/^app\s+packages\/app\s+1 task {2}\[scope:web, type:app\]$/m)
      const one = await vx(root, ['show', 'ui'])
      expect(one.out.split('\n').slice(0, 2)).toEqual([
        'ui — packages/ui',
        '  tags: scope:web, type:lib',
      ])
    },
    PARITY_TIMEOUT,
  )
})

describe('a tag is in no cache key', () => {
  it(
    'editing tags leaves every key where it was; editing the command moves it',
    async () => {
      const hashes = async () =>
        Object.fromEntries((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      const before = await hashes()
      await addProject(root, 'lib', { config: config("tags: ['renamed', 'more'],") })
      // The edit is read: the selector sees the new tag.
      expect(await planned(root, ['build', '--filter', 'tag:renamed'])).toEqual(['lib#build'])
      expect(await hashes()).toEqual(before)
      // CONTROL: the same edit path moves a key when the task changes.
      await addProject(root, 'lib', { config: config("tags: ['renamed'],", 'echo other') })
      const after = await hashes()
      expect(after['lib#build']).not.toBe(before['lib#build'])
      await addProject(root, 'lib', { config: config("tags: ['type:lib'],") })
    },
    PARITY_TIMEOUT,
  )
})
