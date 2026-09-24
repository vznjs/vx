// Chapter 2 of the Guide, "Tasks": a script that hides three jobs, a task's
// name, its inputs and outputs, and why one command per task. The inputs
// picture is the playground workspace's api#build, so it is held to that
// config. The "In vx" block is planned by vx over the four packages.

import { afterAll, describe, expect, it } from 'bun:test'
import { CONFIG_TEXTS, FILES } from '../src/playground/workspace.js'
import * as P from '../src/components/guide/tasks/pictures.js'
import {
  chapterShape,
  content,
  page,
  plan,
  projectObject,
  removeWorkspaces,
  sourceBlocks,
  text,
  toyWorkspace,
} from './guide-page.js'

const SLUG = 'tasks'
const prose = text(content(page(`guide/${SLUG}`)))

afterAll(removeWorkspaces)

chapterShape({
  slug: SLUG,
  titles: [
    'A script can hide three jobs',
    'A task is one command in one package',
    'A task reads inputs and writes outputs',
    'One command per task lets you skip the rest',
  ],
  pictures: [P.script, P.taskName, P.readsWrites, P.split],
  rows: {
    'packages/vx/tests/config.test.ts': [
      'requires cache.inputs.files — the one declaration vx will not infer',
    ],
  },
})

describe("chapter 2's pictures hold to the workspace they draw", () => {
  it("draws the playground workspace's api#build: its command, its files and its env", () => {
    const api = CONFIG_TEXTS['api']!
    const command = /command: '([^']+)'/.exec(api)![1]!
    expect(P.taskName.boxes.find((b) => b.id === 'task')).toMatchObject({
      label: 'api#build',
      sub: command,
    })
    expect(api).toContain("inputs: { files: ['src/**'], env: ['API_URL'] }")
    expect(api).toContain("outputs: { files: ['dist/**'] }")
    expect(Object.keys(FILES)).toContain('packages/api/package.json')
    expect({ inputs: P.INPUTS, outputs: P.OUTPUTS }).toEqual({
      inputs: ['src/**', 'package.json', 'API_URL'],
      outputs: ['dist/**'],
    })
    expect(P.readsWrites.arrows!.map((a) => `${a.from}→${a.to}`)).toEqual([
      ...P.INPUTS.map((i) => `${i}→api#build`),
      ...P.OUTPUTS.map((o) => `api#build→${o}`),
    ])
  })

  it("splits exactly the script's three jobs, and only the copy reads the image", () => {
    const jobs = P.script.boxes.filter((b) => b.id !== 'script').map((b) => b.label)
    expect(P.split.boxes.find((b) => b.id === 'one')!.label).toBe(jobs.join(' && '))
    expect(P.split.boxes.filter((b) => b.id !== 'one').map((b) => [b.label, b.sub])).toEqual([
      ['tsc', 'skipped'],
      ['vite build', 'skipped'],
      ['cp', 'runs again'],
    ])
  })

  it('names tasks package#task', () => {
    expect(prose).toContain('So the build of api is api#build, and the tests of ui are ui#test.')
  })
})

describe('"In vx" on guide/tasks', () => {
  it('shows a config vx plans as utils#build, running its command, uncached', async () => {
    const ts = sourceBlocks(SLUG, 'ts')
    expect(ts).toHaveLength(1)
    const object = projectObject(ts[0]!)
    const root = await toyWorkspace(() => object)
    const planned = await plan(root, ['utils#build'])
    expect(
      planned.tasks.map((t) => ({
        id: t.node.id,
        dir: t.node.projectDir.split('/').slice(-2).join('/'),
        command: t.node.config.exec?.command,
        cache: t.cacheStatus,
      })),
    ).toEqual([{ id: 'utils#build', dir: 'packages/utils', command: 'tsc -b', cache: 'no-cache' }])
  })

  it('ends on the next problem', () => {
    expect(prose).toMatch(/You have eight tasks now\. Which must finish before which\?$/)
  })
})
