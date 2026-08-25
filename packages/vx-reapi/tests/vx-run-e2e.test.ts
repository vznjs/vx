// The composition proof: a real `vx run` with `reapi({ execute: true })` —
// core placement offers tasks to the remote executor, `remote: 'only'` keeps
// install off the local disk, the dependent build's worker sees node_modules
// by reference, and the ordinary local save path tars the build's outputs.
//
// Same gating as the wire-level exec suite.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '@vzn/vx'
import { localWorkspaceSource } from '../../../tests/helpers/local-workspace.js'

const ENDPOINT = Bun.env['VX_REAPI_EXEC_ENDPOINT']
if (Bun.env['VX_REQUIRE_REAPI_EXEC'] === '1' && (ENDPOINT === undefined || ENDPOINT === '')) {
  throw new Error('VX_REQUIRE_REAPI_EXEC=1 but VX_REAPI_EXEC_ENDPOINT is unset.')
}
const armed = ENDPOINT !== undefined && ENDPOINT !== ''
const REAPI_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

const lines: string[] = []
const silentLogger = () => ({
  runStart: () => undefined,
  taskStart: () => undefined,
  taskStdout: (_n: unknown, c: string) => lines.push(`out:${c}`),
  taskStderr: (_n: unknown, c: string) => lines.push(`err:${c}`),
  taskComplete: () => undefined,
  runStatus: () => undefined,
  runEnd: () => undefined,
  status: (l: string) => lines.push(`status:${l}`),
})

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  )

describe.if(armed)('vx run with reapi({ execute: true }) — the install-as-action recipe', () => {
  it('install stays remote, build executes remotely against it, outputs land locally, reruns hit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-run-reapi-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'pkg'\n")
      await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
      await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
      await writeFile(path.join(root, 'pkg', 'src', 'app.js'), 'console.log("app")\n')
      await writeFile(
        path.join(root, 'pkg', 'vx.config.mjs'),
        `export default { tasks: {
           install: {
             exec: { command: 'mkdir -p node_modules/liba && echo from-worker > node_modules/liba/index.js', remote: 'only' },
             cache: { inputs: { files: ['package.json'] }, outputs: { files: ['node_modules/**'] } },
           },
           build: {
             exec: { command: 'cat node_modules/liba/index.js > out.txt' },
             dependsOn: ['install'],
             cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
           },
         } }`,
      )
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [`reapi({ endpoint: ${JSON.stringify(ENDPOINT)}, execute: true })`],
          `import { reapi } from ${JSON.stringify(REAPI_INDEX)}\n`,
        ),
      )
      const git = (...a: string[]) => Bun.spawnSync({ cmd: ['git', ...a], cwd: root })
      git('init', '-q')
      git('config', 'user.email', 't@vx.local')
      git('config', 'user.name', 't')
      git('config', 'commit.gpgsign', 'false')
      git('add', '-A')
      git('commit', '-qm', 'init')

      const first = await run({
        cwd: root,
        projects: ['pkg'],
        tasks: ['build'],
        log: silentLogger(),
        handleSignals: false,
      })
      if (!first.ok) {
        console.log(
          'outcomes:',
          first.outcomes.map((o) => `${o.node.id}=${o.status}:${o.exitCode}`).join(' '),
        )
        console.log(lines.slice(-25).join('\n'))
      }
      expect(first.ok).toBe(true)
      // install: remote-only — the dev machine NEVER gets node_modules…
      expect(await exists(path.join(root, 'pkg', 'node_modules'))).toBe(false)
      // …while the build, executed on a worker that grafted them, lands its
      // declared output locally through the ordinary materialise+save path.
      expect(await Bun.file(path.join(root, 'pkg', 'out.txt')).text()).toBe('from-worker\n')

      // Second run: build is a local cache hit; install re-noops off its
      // remote execution record. Nothing re-executes.
      const second = await run({
        cwd: root,
        projects: ['pkg'],
        tasks: ['build'],
        log: silentLogger(),
        handleSignals: false,
      })
      expect(second.ok).toBe(true)
      const build2 = second.outcomes.find((o) => o.node.id === 'pkg#build')
      expect(build2?.status).toBe('cache-hit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)

  it('--download=none moves no output bytes to the submitter, and converges later', async () => {
    // Phase 1's headline claim, proven end to end against a real cluster:
    // a run that wants only the verdict executes remotely and leaves every
    // output byte in the CAS. Then the SAME workspace run eagerly picks the
    // bytes up through the exec-record short-circuit — no re-execution —
    // and saves an ordinary entry, so the third run is a plain local hit.
    const root = await mkdtemp(path.join(tmpdir(), 'vx-run-reapi-dl-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'pkg'\n")
      await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
      await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
      await writeFile(path.join(root, 'pkg', 'src', 'app.js'), `console.log(${Date.now()})\n`)
      await writeFile(
        path.join(root, 'pkg', 'vx.config.mjs'),
        `export default { tasks: {
           build: {
             exec: { command: 'cat src/app.js > out.txt && echo built' },
             cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
           },
         } }`,
      )
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [`reapi({ endpoint: ${JSON.stringify(ENDPOINT)}, execute: true })`],
          `import { reapi } from ${JSON.stringify(REAPI_INDEX)}\n`,
        ),
      )
      const git = (...a: string[]) => Bun.spawnSync({ cmd: ['git', ...a], cwd: root })
      git('init', '-q')
      git('config', 'user.email', 't@vx.local')
      git('config', 'user.name', 't')
      git('config', 'commit.gpgsign', 'false')
      git('add', '-A')
      git('commit', '-qm', 'init')

      const deferred = await run({
        cwd: root,
        projects: ['pkg'],
        tasks: ['build'],
        download: 'none',
        log: silentLogger(),
        handleSignals: false,
      })
      expect(deferred.ok).toBe(true)
      const built = deferred.outcomes.find((o) => o.node.id === 'pkg#build')
      expect(built?.status).toBe('success')
      // THE claim: the declared output never reached this machine.
      expect(built?.outputs).toBe('deferred')
      expect(await exists(path.join(root, 'pkg', 'out.txt'))).toBe(false)

      // Eager re-run of the same key: the record answers, so nothing
      // re-executes on a worker, and the bytes land + save.
      const eager = await run({
        cwd: root,
        projects: ['pkg'],
        tasks: ['build'],
        log: silentLogger(),
        handleSignals: false,
      })
      expect(eager.ok).toBe(true)
      expect(await exists(path.join(root, 'pkg', 'out.txt'))).toBe(true)

      // Converged: an ordinary local entry now exists.
      const third = await run({
        cwd: root,
        projects: ['pkg'],
        tasks: ['build'],
        log: silentLogger(),
        handleSignals: false,
      })
      expect(third.outcomes.find((o) => o.node.id === 'pkg#build')?.status).toBe('cache-hit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
})
