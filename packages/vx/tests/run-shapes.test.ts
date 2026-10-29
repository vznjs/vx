// Run shapes other runners broke on: a task name holding `:` (split as a
// configuration), a cache directory named with shell syntax (passed
// through a shell, it ran), and a wide fan-out (a listener per task
// warned past Node's default ten, and a scheduler race ran a task twice),
// and a runtime input run from wherever the runner was started.
import { readdir, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { dry, planned, vx } from './helpers/parity.js'

const TIMEOUT = 60_000

describe('a task name holding a colon', () => {
  let root = ''
  beforeAll(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-colon-names-', edges: {} }))
    await addProject(
      root,
      '@s/a',
      `export default {
        tasks: {
          'build:esm': { exec: { command: 'echo esm' } },
          'lint:fix': { exec: { command: 'echo fixed' } },
          build: { dependsOn: ['build:esm', 'lint:fix'], exec: { command: 'echo build' } },
        },
      }
      `,
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'is addressed whole: by id, by bare name, and in a same-project dependsOn',
    async () => {
      expect(await planned(root, ['@s/a#build:esm'])).toEqual(['@s/a#build:esm'])
      expect(await planned(root, ['lint:fix', '--all'])).toEqual(['@s/a#lint:fix'])
      expect(await planned(root, ['@s/a#build'])).toEqual([
        '@s/a#build',
        '@s/a#build:esm',
        '@s/a#lint:fix',
      ])
      const r = await vx(root, ['run', '@s/a#lint:fix', '--output-logs=full'])
      expect([r.code, r.out.includes('fixed')]).toEqual([0, true])
    },
    TIMEOUT,
  )
})

describe('a cache directory named with shell syntax', () => {
  let root = ''
  beforeAll(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-cache-dir-shell-', edges: {} }))
    await addProject(root, 'a', {
      config: `export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p out && echo built > out/o.txt' },
            inputs: { files: ['src/**'] },
            cache: { outputs: { files: ['out/**'] } },
          },
        },
      }
      `,
      files: { 'src/x.txt': 'x\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'is a name, never run: a miss saves into it and a hit restores from it',
    async () => {
      const env = { VX_CACHE_DIR: 'c$(touch PWNED1)`touch PWNED2`;touch PWNED3' }
      const miss = await vx(root, ['run', 'a#build'], env)
      await rm(path.join(root, 'packages', 'a', 'out'), { recursive: true })
      const hit = await vx(root, ['run', 'a#build'], env)
      expect([miss.code, hit.code]).toEqual([0, 0])
      expect(hit.out).toContain('local 1')
      expect(await readFile(path.join(root, 'packages', 'a', 'out', 'o.txt'), 'utf8')).toBe(
        'built\n',
      )
      const all = await readdir(root, { recursive: true })
      expect(all.filter((f) => f.includes('PWNED') && !f.includes('$('))).toEqual([])
      expect(all).toContain(env.VX_CACHE_DIR)
    },
    TIMEOUT,
  )
})

describe('a runtime input', () => {
  let root = ''
  beforeAll(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-runtime-cwd-', edges: {} }))
    await addProject(root, 'a', {
      config: `export default {
        tasks: {
          build: {
            exec: { command: 'true' },
            inputs: { files: ['src/**'], runtime: ['pwd'] },
            cache: { outputs: { files: [] } },
          },
        },
      }
      `,
      files: { 'src/deep/x.txt': 'x\n' },
    })
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'runs in the project directory whatever directory vx runs from, so the key does not move',
    async () => {
      const key = async (cwd: string) => (await dry(cwd, ['a#build']))[0]!.hash
      expect(await key(path.join(root, 'packages', 'a', 'src', 'deep'))).toBe(await key(root))
    },
    TIMEOUT,
  )
})

describe('a fan-out wider than the concurrency', () => {
  const N = 80
  let root = ''
  beforeAll(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-fanout-', edges: {} }))
    const tasks = Array.from(
      { length: N },
      (_, i) => `t${i}: { exec: { command: 'echo t${i} >> ../../log.txt' } },`,
    ).join('\n')
    await addProject(
      root,
      'many',
      `export default {
        tasks: {
          ${tasks}
          all: { dependsOn: [${Array.from({ length: N }, (_, i) => `'t${i}'`).join(', ')}] },
        },
      }
      `,
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'runs each task once and warns nothing',
    async () => {
      const r = await vx(root, ['run', 'many#all', '--concurrency', '100'])
      expect([r.code, r.err]).toEqual([0, ''])
      const lines = (await readFile(path.join(root, 'log.txt'), 'utf8')).trim().split('\n')
      expect(lines.length).toBe(N)
      expect(new Set(lines).size).toBe(N)
    },
    TIMEOUT,
  )
})
