// Prototype: github() as a compiled binary behind a JS shim. Proves the
// binary sees the run's env, answers a hook over stdin/stdout JSON, and
// that a real `vx run` writes the same job summary through it.
import { beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { githubBranch } from '../src/cache-scope.js'
import { githubBinary } from './shim.js'

const BIN = path.join(tmpdir(), `vx-ci-proto-${process.pid}`)
const SHIM = path.resolve(import.meta.dir, 'shim.ts')

beforeAll(async () => {
  const b = Bun.spawnSync({
    cmd: ['bun', 'build', '--compile', path.join(import.meta.dir, 'main.ts'), '--outfile', BIN],
    stdout: 'ignore',
    stderr: 'pipe',
  })
  if (b.exitCode !== 0) throw new Error(b.stderr.toString())
}, 120_000)

describe('github() compiled', () => {
  it('the config hook names the branch the binary reads from the env', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-ci-proto-'))
    const event = path.join(root, 'event.json')
    await writeFile(
      event,
      JSON.stringify({
        pull_request: {
          number: 7,
          head: { ref: 'feat', repo: { full_name: 'o/r' } },
          base: { sha: 'a'.repeat(40) },
        },
      }),
    )
    const saved = { ...process.env }
    Object.assign(process.env, {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_REF: 'refs/pull/7/merge',
      GITHUB_HEAD_REF: 'feat',
    })
    try {
      const facts: unknown[] = []
      await githubBinary(BIN)!.config!(
        { baseBranch: 'main' } as never,
        {
          setBranch: (f: unknown) => facts.push(f),
          warn: () => undefined,
        } as never,
      )
      expect(facts).toEqual([await githubBranch(process.env, 'main')])
      expect(facts[0]).toHaveProperty('scope')
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a real run appends the job summary through the binary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-ci-proto-run-'))
    try {
      const summaryFile = path.join(root, 'step-summary.md')
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
      await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
      await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
      await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'x\n')
      await writeFile(
        path.join(root, 'pkg', 'vx.config.mjs'),
        `export default { tasks: {
           build: {
             exec: { command: 'cat src/in.txt > out.txt' },
             inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
           },
         } }`,
      )
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        `import { githubBinary } from ${JSON.stringify(SHIM)}
export default { plugins: [githubBinary(${JSON.stringify(BIN)}, { summaryFile: ${JSON.stringify(summaryFile)} })] }
`,
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      const r = await run({
        cwd: root,
        projects: ['pkg'],
        tasks: ['build'],
        log: { status: () => undefined, error: () => undefined } as never,
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      const md = await readFile(summaryFile, 'utf8')
      expect(md).toContain('## ✅ vx run')
      expect(md).toContain('pkg#build')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
