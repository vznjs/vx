// `./src/**` is the same entry as `src/**` — to a reader, to Turbo, to git.
// To a glob matcher fed the literal `./` it matched NOTHING, so a task keyed
// on `./src/**` folded zero inputs and an edit under it replayed the old
// outputs as a green hit (found 2026-09-10 by a probe; the first pin fails
// that way without `normalizeGlob`). Outputs took the same spelling through
// a different path (a scan, which tolerates `./`) and worked — the control.
// A bare `.` names the directory itself and is refused at load.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { loadProjectConfig } from '../src/workspace/index.js'
import { asTrees, normalizeGlob } from '../src/cache/index.js'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe('./-prefixed globs', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-dotslash-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function project(cache: string): Promise<string> {
    const dir = await addProject(
      root,
      'app',
      `
        export default { tasks: { build: {
          exec: { command: 'mkdir -p dist && cat src/a.txt gen/g.txt > dist/out.txt' },
          cache: ${cache},
        } } }
      `,
    )
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await mkdir(path.join(dir, 'gen'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a1\n')
    await writeFile(path.join(dir, 'gen', 'g.txt'), 'g1\n')
    return dir
  }
  const opts = () => ({
    cwd: root,
    tasks: ['build'],
    projects: ['app'],
    log: silent,
    handleSignals: false,
  })

  it('an input written as ./src/** keys on src: an edit under it is a miss, not a stale hit', async () => {
    const dir = await project(
      `{ inputs: { files: ['./src/**'] }, outputs: { files: ['./dist/**'] } }`,
    )
    expect((await run(opts())).outcomes.map((o) => o.status)).toEqual(['success'])
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    const r = await run(opts())
    expect(r.outcomes.map((o) => o.status)).toEqual(['success'])
    expect(await Bun.file(path.join(dir, 'dist', 'out.txt')).text()).toBe('a2\ng1\n')
  }, 30_000)

  it('a negation written as !./gen/** subtracts gen: an edit there is a hit', async () => {
    const dir = await project(
      `{ inputs: { files: ['**', '!./gen/**', '!dist/**'] }, outputs: { files: ['dist/**'] } }`,
    )
    expect((await run(opts())).outcomes.map((o) => o.status)).toEqual(['success'])
    await writeFile(path.join(dir, 'gen', 'g.txt'), 'g2\n')
    expect((await run(opts())).outcomes.map((o) => o.status)).toEqual(['cache-hit'])
  }, 30_000)

  it('outputs written as ./dist/** are captured and restored (control)', async () => {
    const dir = await project(
      `{ inputs: { files: ['src/**', 'gen/**'] }, outputs: { files: ['./dist/**'] } }`,
    )
    expect((await run(opts())).outcomes.map((o) => o.status)).toEqual(['success'])
    await rm(path.join(dir, 'dist'), { recursive: true, force: true })
    expect((await run(opts())).outcomes.map((o) => o.status)).toEqual(['cache-hit'])
    expect(await Bun.file(path.join(dir, 'dist', 'out.txt')).text()).toBe('a1\ng1\n')
  }, 30_000)

  it('normalizeGlob: inner ./ segments, doubled slashes and a trailing slash on a pattern', () => {
    expect(normalizeGlob('src/./a.ts')).toBe('src/a.ts')
    expect(normalizeGlob('src//x///b.ts')).toBe('src/x/b.ts')
    expect(normalizeGlob('././src/**')).toBe('src/**')
    expect(normalizeGlob('!./gen/./**')).toBe('!gen/**')
    expect(normalizeGlob('src/**/')).toBe('src/**/**')
    expect(normalizeGlob('src/*/')).toBe('src/*/**')
    // a literal keeps its trailing slash: asTrees makes it the tree
    expect(normalizeGlob('src/')).toBe('src/')
    expect(asTrees(['src/', 'lib/*/'])).toEqual(['src', 'src/**', 'lib/*/**'])
    expect(normalizeGlob('.')).toBe('')
  })

  it('an input written src/**/ (trailing slash on a pattern) keys on src too', async () => {
    const dir = await project(`{ inputs: { files: ['src/**/'] }, outputs: { files: ['dist/**'] } }`)
    expect((await run(opts())).outcomes.map((o) => o.status)).toEqual(['success'])
    await writeFile(path.join(dir, 'src', 'a.txt'), 'a2\n')
    expect((await run(opts())).outcomes.map((o) => o.status)).toEqual(['success'])
  }, 30_000)

  for (const [field, entry] of [
    ['inputs', "'.'"],
    ['inputs', "'./'"],
    ['outputs', "'./'"],
  ] as const) {
    it(`${field}.files ${entry} names the directory itself and is refused at load`, async () => {
      const dir = await addProject(root, 'app')
      const file = path.join(dir, 'vx.config.mjs')
      const cache =
        field === 'inputs'
          ? `{ inputs: { files: [${entry}] }, outputs: { files: ['dist/**'] } }`
          : `{ inputs: { files: ['src/**'] }, outputs: { files: [${entry}] } }`
      await writeFile(
        file,
        `export default { tasks: { build: { exec: { command: 'true' }, cache: ${cache} } } }\n`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /names the project directory itself and selects nothing/,
      )
    })
  }
})
