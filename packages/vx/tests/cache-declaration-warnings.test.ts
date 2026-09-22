// A cache block whose globs match NOTHING is the quiet stale hit: an input
// set that resolves to no files keeps the key still while the source moves,
// and an output set that resolves to no files saves an artifact a later hit
// "restores". Both are said once, on the miss, on the run's status line.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/index.js'

let root: string

async function gitInit(dir: string): Promise<void> {
  await Bun.spawn(['git', 'init', '-q'], { cwd: dir }).exited
}

function logger(lines: string[]) {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: (line: string) => {
      lines.push(line)
    },
  }
}

async function runTask(task: string): Promise<string[]> {
  const lines: string[] = []
  const summary = await run({
    cwd: root,
    tasks: [task],
    projects: ['app'],
    log: logger(lines),
    handleSignals: false,
  })
  expect(summary.ok).toBe(true)
  return lines.filter((l) => l.includes('matched no files'))
}

describe('cache declarations that match nothing', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-decl-warn-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'src', 'index.js'), 'export {}\n')
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: {
        // Both globs against directories that do not exist.
        lost: { exec: { command: 'true' },
          cache: { inputs: { files: ['lib/**'] }, outputs: { files: ['build/**'] } } },
        // The control: matching inputs, matching outputs.
        found: { exec: { command: 'mkdir -p dist && echo x > dist/a.js' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } },
        // A deliberate cached no-op: empty outputs say nothing.
        noop: { exec: { command: 'true' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } },
        // Root-anchored outputs that match nothing. The warning counts
        // BOTH output arrays on each side — declared and resolved — and
        // every fixture above declares only \`files\`, so a task whose
        // whole output declaration is root-anchored went unwarned.
        wslost: { exec: { command: 'true' },
          cache: { inputs: { files: ['src/**'] },
            outputs: { files: [], workspaceFiles: ['nowhere/**'] } } },
        // The other side of the sum: \`files\` matches nothing but the
        // root-anchored glob DOES match, so the outputs are not empty and
        // there is nothing to warn about.
        wsfound: { exec: { command: 'mkdir -p ../../shared && echo x > ../../shared/a.js' },
          cache: { inputs: { files: ['src/**'] },
            outputs: { files: ['build/**'], workspaceFiles: ['shared/**'] } } },
      } }\n`,
    )
    await gitInit(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('an input glob and an output glob that match nothing are each named once, on the miss only', async () => {
    const first = await runTask('lost')
    expect(first).toEqual([
      "[vx] app#lost: cache.inputs matched no files (lib/**) — the key will not change when this project's source does",
      '[vx] app#lost: cache.outputs matched no files (build/**) — an empty artifact is saved; a later hit restores nothing',
    ])
    // The hit says nothing: the warning belongs to the run that saved.
    expect(await runTask('lost')).toEqual([])
  })

  it('a hit with no rows is up-to-date while its globs still match nothing, and wipes a stray', async () => {
    // The warned entry holds no rows. Before item 589 its every hit
    // extracted the empty artifact and reported a restore; now the hit is
    // a no-op when the globs match nothing — and still a clean when a
    // stray sits under them, which strict ownership requires.
    const outcomes = async (): Promise<Record<string, boolean | undefined>> => {
      const summary = await run({
        cwd: root,
        tasks: ['lost'],
        projects: ['app'],
        log: logger([]),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      return Object.fromEntries(summary.outcomes.map((o) => [o.node.taskName, o.restored]))
    }
    await outcomes()
    expect(await outcomes()).toEqual({ lost: false })
    const stray = path.join(root, 'packages', 'app', 'build', 'stray.js')
    await mkdir(path.dirname(stray), { recursive: true })
    await writeFile(stray, 'x')
    expect(await outcomes()).toEqual({ lost: true })
    expect(await Bun.file(stray).exists()).toBe(false)
  })

  it('the output warning blames the sandbox only when there IS one', async () => {
    // `app#lost` is not sandboxed, so the cause clause added for sandboxed
    // tasks with no write grant (item 444) must not appear here. The
    // clause's own rows live in `sandbox-runtime.unsafe.test.ts`, which
    // needs a real sandbox; this is the half that runs everywhere.
    const lines = await runTask('lost')
    const out = lines.find((l) => l.includes('cache.outputs'))
    expect(out).toBeDefined()
    expect(out).not.toContain('exec.sandbox.allow.write')
  })

  it('counts BOTH output arrays, declared and resolved', async () => {
    // Declared only as workspaceFiles, matching nothing: the warning names
    // the root-anchored glob. Reading only `outputs.files` on the declared
    // side leaves this task silent about an empty artifact.
    expect((await runTask('wslost')).filter((l) => l.includes('cache.outputs'))).toEqual([
      '[vx] app#wslost: cache.outputs matched no files (nowhere/**) — an empty artifact is saved; a later hit restores nothing',
    ])
    // And the resolved side: `files` matched nothing, but the root-anchored
    // glob did, so the artifact is NOT empty and nothing is said. Reading
    // only `outputFiles` here would warn about a task that saved outputs.
    expect((await runTask('wsfound')).filter((l) => l.includes('cache.outputs'))).toEqual([])
  })

  it('matching globs and a deliberate empty output list say nothing (control)', async () => {
    expect(await runTask('found')).toEqual([])
    expect(await runTask('noop')).toEqual([])
  })
})
