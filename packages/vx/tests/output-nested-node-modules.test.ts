// A `node_modules` under an output glob's own directory is the build's
// output: Nitro writes `.output/server/node_modules/**`, Next standalone
// `.next/standalone/node_modules/**`. The A-13 guard (`**/*.js` must never
// reach installed deps) dropped them from the save too, and a hit after
// `rm -rf .output` restored a server whose imports were gone. The guard
// still holds for a glob that reaches `node_modules` only by a wildcard.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanOutputs, resolveOutputs } from '../src/cache/index.js'
import { relPosix, restorableOutput } from '../src/util/index.js'
import { PARITY_TIMEOUT as TIMEOUT, summarized } from './helpers/parity.js'
import { makeWorkspace } from './helpers/workspace.js'

const BUILT = '.output/server/node_modules/dep/index.mjs'
const INSTALLED = 'node_modules/inst/index.js'

describe('the walk', () => {
  let root: string
  const FILES = [BUILT, '.output/server/index.mjs', INSTALLED, 'src/node_modules/x.js', 'dist/a.js']
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vx-output-nested-nm-'))
    for (const f of FILES) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
      writeFileSync(path.join(root, f), f)
    }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const args = (outputs: string[]) => ({ projectDir: root, outputs, nestedProjectDirs: [] })

  it('`.output/**` saves, restores and cleans its own node_modules', async () => {
    const saved = (await resolveOutputs(args(['.output/**']))).map((f) => relPosix(root, f))
    expect(saved).toEqual(['.output/server/index.mjs', BUILT])
    expect(restorableOutput(['.output/**'])(BUILT)).toBe(true)
    await cleanOutputs(args(['.output/**']))
    expect(existsSync(path.join(root, BUILT))).toBe(false)
  })

  it('`**/*.js` beside it still never reaches installed deps (control)', async () => {
    const outputs = ['.output/**', '**/*.js']
    const saved = (await resolveOutputs(args(outputs))).map((f) => relPosix(root, f))
    expect(saved).toEqual(['.output/server/index.mjs', BUILT, 'dist/a.js'])
    const take = restorableOutput(outputs)
    expect([INSTALLED, 'src/node_modules/x.js'].map(take)).toEqual([false, false])
    await cleanOutputs(args(outputs))
    expect(FILES.filter((f) => existsSync(path.join(root, f)))).toEqual([
      INSTALLED,
      'src/node_modules/x.js',
    ])
  })
})

it(
  'a hit restores the node_modules a build wrote under its output directory',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-output-nested-nm-e2e-' })
    try {
      await writeFile(
        path.join(root, 'vx.config.mjs'),
        `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p .output/server/node_modules/dep && echo dep > ${BUILT} && echo app > .output/server/index.mjs' },
              inputs: { files: ['package.json'] }, outputs: { files: ['.output/**', '**/*.js'] }, cache: true,
            },
          },
        }\n`,
      )
      mkdirSync(path.join(root, 'node_modules/inst'), { recursive: true })
      writeFileSync(path.join(root, INSTALLED), 'installed\n')
      const first = await summarized(root, ['fixture-root#build'])
      expect(first.code).toBe(0)
      writeFileSync(path.join(root, INSTALLED), 'reinstalled\n')
      await rm(path.join(root, '.output'), { recursive: true, force: true })
      const second = await summarized(root, ['fixture-root#build'])
      expect(second.tasks.get('fixture-root#build')?.['status']).toBe('cache-hit')
      expect(readFileSync(path.join(root, BUILT), 'utf8')).toBe('dep\n')
      expect(readFileSync(path.join(root, INSTALLED), 'utf8')).toBe('reinstalled\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
