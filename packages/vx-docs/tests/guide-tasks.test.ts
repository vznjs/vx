// Chapter 2 of the Guide, "Tasks" (design/site-redo-2026-09.md, and the
// owner's "simple, visual" brief): a script that hides three jobs, a task's
// name, its inputs and outputs, and why one command per task. The inputs
// picture is the playground workspace's api#build, so it is held to that
// config. The "In vx" block is planned by vx over the four packages.

import { afterAll, describe, expect, it } from 'bun:test'
import { CONFIG_TEXTS, FILES } from '../src/playground/workspace.js'
import {
  INPUTS,
  NAME,
  OUTPUTS,
  READS_WRITES,
  SCRIPT,
  SPLIT,
} from '../src/components/guide/tasks/pictures.js'
import {
  COMPETITORS,
  codeBlocks,
  content,
  expectDiagrams,
  expectOnlyToyPackages,
  missing,
  page,
  pictures,
  plan,
  projectObject,
  proofLinks,
  proseWords,
  removeWorkspaces,
  sectionTitles,
  summaries,
  text,
  toyWorkspace,
} from './guide-opening.js'

const SLUG = 'guide/tasks'
const html = page(SLUG)
const main = content(html)
const prose = text(main)

afterAll(removeWorkspaces)

describe('chapter 2, tasks', () => {
  it('tells the story in its section titles', () => {
    expect(sectionTitles(main)).toEqual([
      'A script can hide three jobs',
      'A task is one command in one package',
      'A task reads inputs and writes outputs',
      'One command per task lets you skip the rest',
      'In vx',
      'Check yourself',
    ])
  })

  it('draws a picture for each idea', () => {
    expectDiagrams(main, [SCRIPT, NAME, READS_WRITES, SPLIT])
    expect(pictures(main)).toHaveLength(4)
  })

  it('keeps the prose to the budget', () => {
    expect(proseWords(main)).toBeLessThanOrEqual(350)
  })

  it("draws the playground workspace's api#build: its command, its files and its env", () => {
    const api = CONFIG_TEXTS['api']!
    const command = /command: '([^']+)'/.exec(api)![1]!
    expect(NAME.boxes.find((b) => b.id === 'task')).toMatchObject({
      label: 'api#build',
      sub: command,
    })
    expect(api).toContain("inputs: { files: ['src/**'], env: ['API_URL'] }")
    expect(api).toContain("outputs: { files: ['dist/**'] }")
    expect(Object.keys(FILES)).toContain('packages/api/package.json')
    expect({ inputs: INPUTS, outputs: OUTPUTS }).toEqual({
      inputs: ['src/**', 'package.json', 'API_URL'],
      outputs: ['dist/**'],
    })
    expect(READS_WRITES.arrows!.map((a) => `${a.from}→${a.to}`)).toEqual([
      ...INPUTS.map((i) => `${i}→api#build`),
      ...OUTPUTS.map((o) => `api#build→${o}`),
    ])
  })

  it("splits exactly the script's three jobs, and only the copy reads the image", () => {
    const jobs = SCRIPT.boxes.filter((b) => b.id !== 'script').map((b) => b.label)
    expect(SPLIT.boxes.find((b) => b.id === 'one')!.label).toBe(jobs.join(' && '))
    expect(SPLIT.boxes.filter((b) => b.id !== 'one').map((b) => [b.label, b.sub])).toEqual([
      ['tsc', 'skipped'],
      ['vite build', 'skipped'],
      ['cp', 'runs again'],
    ])
  })

  it('names tasks package#task, from the four packages only, and no other task runner', () => {
    expectOnlyToyPackages(main)
    expect(prose).not.toMatch(COMPETITORS)
    expect(prose).toContain('So the build of api is api#build, and the tests of ui are ui#test.')
  })

  it('keeps its proofs in one collapsed list, each one landing', () => {
    const { proofs, elsewhere } = proofLinks(main)
    expect(proofs.map((l) => l.href)).toEqual([
      '../../schema/#project-config',
      '../../schema/#exec-optional--required-for-non-group-tasks',
      '../../execution/#one-command-per-task',
      'https://github.com/vznjs/vx/blob/main/packages/vx/tests/config.test.ts',
    ])
    expect(elsewhere.map((l) => l.href)).toEqual([
      '../../learn/glossary/#task',
      '../../learn/glossary/#inputs',
      '../../learn/glossary/#outputs',
    ])
    expect(
      [...proofs, ...elsewhere].map((l) => missing(SLUG, l)).filter((m) => m !== undefined),
    ).toEqual([])
  })

  it('asks one question', () => {
    expect(summaries(main)).toEqual([
      'How we know this is true',
      'Is api/README.md an input of api#build?',
    ])
  })

  it('shows a config vx plans as utils#build, running its command, uncached', async () => {
    const ts = codeBlocks(SLUG, 'ts')
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
