// A literal output that matches no files after the command exits 0 fails
// the task, and so do outputs that matched nothing at all: an empty artifact
// replayed by every later hit reads as a build that ran (M 2026-11-23).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { defaultLogger } from '../src/report/logger.js'

let root: string

async function runTask(task: string): Promise<{ ok: boolean; status?: string; lines: string[] }> {
  const lines: string[] = []
  const summary = await run({
    cwd: root,
    tasks: [task],
    projects: ['app'],
    log: {
      runStart: () => undefined,
      taskStart: () => undefined,
      taskStdout: () => undefined,
      taskStderr: (_node: unknown, line: string) => {
        lines.push(line.trim())
      },
      taskComplete: () => undefined,
      runEnd: () => undefined,
      status: (line: string) => {
        lines.push(line)
      },
    },
    handleSignals: false,
  })
  const o = summary.outcomes.find((x) => x.node.taskName === task)
  return {
    ok: summary.ok,
    ...(o !== undefined ? { status: o.status } : {}),
    lines: lines.filter((l) => l.includes('matched no files')),
  }
}

describe('a declared literal output that matches no files', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-missing-out-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'src', 'index.js'), 'export {}\n')
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: {
        lost: { exec: { command: 'true' },
          inputs: { files: ['src/**'] }, outputs: { files: ['build/index.js'] }, cache: true },
        optional: { exec: { command: 'mkdir -p opt && echo x > opt/a.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['.next/**', 'opt/**', '*.tsbuildinfo'] }, cache: true },
        uncached: { exec: { command: 'true' }, outputs: { files: ['gone'] } },
        typo: { exec: { command: 'mkdir -p typo && echo x > typo/index.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['typo/main.js'] }, cache: true },
        wild: { exec: { command: 'true' },
          inputs: { files: ['src/**'] }, outputs: { files: ['lost1/**', 'lost2/**'] }, cache: true },
        partial: { exec: { command: 'echo x > partial.info' },
          inputs: { files: ['src/**'] }, outputs: { files: ['emit/a.js', 'emit/**', 'partial.info'] }, cache: true },
        literal: { exec: { command: 'mkdir -p lib && echo x > lib/a.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['lib/**', 'types.d.ts'] }, cache: true },
        wspartial: { exec: { command: 'echo x > stamp.info' },
          inputs: { files: ['src/**'] },
          outputs: { files: ['stamp.info'], workspaceFiles: ['wsgone'] }, cache: true },
        takenback: { exec: { command: 'mkdir -p out && echo x > out/a.map' },
          inputs: { files: ['src/**'] }, outputs: { files: ['out/**', '!out/**/*.map'] }, cache: true },
        found: { exec: { command: 'mkdir -p dist && echo x > dist/a.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true },
        emptyroot: { exec: { command: 'mkdir -p void' },
          inputs: { files: ['src/**'] }, outputs: { files: ['void/**'] }, cache: true },
        dirsonly: { exec: { command: 'mkdir -p gen/a/b' },
          inputs: { files: ['src/**'] }, outputs: { files: ['gen/**'] }, cache: true },
        slashfile: { exec: { command: 'echo x > out2' },
          inputs: { files: ['src/**'] }, outputs: { files: ['out2/'] }, cache: true },
        slashdir: { exec: { command: 'mkdir -p out3 && echo x > out3/a' },
          inputs: { files: ['src/**'] }, outputs: { files: ['out3/'] }, cache: true },
        noop: { exec: { command: 'true' },
          inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true },
      } }\n`,
    )
    await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('fails the task, names the pattern, and caches nothing', async () => {
    const first = await runTask('lost')
    expect(first.ok).toBe(false)
    expect(first.status).toBe('failed')
    expect(first.lines).toEqual([
      '[vx] app#lost: outputs matched no files (build/index.js) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern — it wrote none of its outputs: one written only sometimes (test coverage, written only with coverage on) cannot be declared, so drop it from outputs or run the command so it writes it',
    ])
    // Nothing was saved: the next run runs the command again and fails again.
    expect((await runTask('lost')).status).toBe('failed')
  })

  // A trailing slash names a folder: a file of that name is no match (M 2026-11-24).
  it('fails a trailing-slash output written as a file, saying so', async () => {
    const r = await runTask('slashfile')
    expect(r.status).toBe('failed')
    expect(r.lines).toEqual([
      expect.stringContaining(
        'app#slashfile: outputs matched no files (out2/) — the command exited 0 but never wrote it',
      ),
    ])
    expect(r.lines[0]).toContain('— a folder was declared, a file was written: out2')
    const d = await runTask('slashdir')
    expect([d.ok, d.lines]).toEqual([true, []])
  })

  it('fails an uncached task too', async () => {
    const r = await runTask('uncached')
    expect(r.status).toBe('failed')
    expect(r.lines).toHaveLength(1)
  })

  // Nx and Turbo cache whichever outputs exist; vx fails a task that wrote
  // none, and an Nx test target's coverage dir failed every run without
  // coverage. The line says what to do; a task that wrote some is not told.
  it('names only the literal that matched nothing', async () => {
    expect((await runTask('partial')).lines[0]).not.toContain('it wrote none of its outputs')
    // A mistyped path beside what it wrote is not a sometimes-output.
    expect((await runTask('typo')).lines).toEqual([
      expect.stringMatching(
        /app#typo: outputs matched no files \(typo\/main\.js\) — .*fix the pattern$/,
      ),
    ])
    expect((await runTask('partial')).lines).toEqual([
      expect.stringContaining('app#partial: outputs matched no files (emit/a.js) —'),
    ])
    expect((await runTask('literal')).lines).toEqual([
      expect.stringContaining('app#literal: outputs matched no files (types.d.ts) —'),
    ])
    expect((await runTask('wspartial')).lines).toEqual([
      expect.stringContaining('app#wspartial: outputs matched no files (wsgone) —'),
    ])
  })

  // A wildcard is optional beside one that matched (M 2026-11-23).
  it('passes a wildcard that matched nothing beside one that matched', async () => {
    for (const t of ['optional']) {
      const r = await runTask(t)
      expect([t, r.ok, r.lines.filter((l) => l.includes('task fails'))]).toEqual([t, true, []])
      expect((await runTask(t)).status).toBe('cache-hit')
    }
  })

  // A task that declares outputs writes some (M 2026-11-23).
  it('fails a task whose every wildcard matched nothing, naming them all', async () => {
    for (const [t, globs] of [
      ['wild', 'lost1/**, lost2/**'],
      ['takenback', 'out/**'],
      ['emptyroot', 'void/**'],
    ]) {
      const r = await runTask(t!)
      expect([t, r.status, r.lines]).toEqual([
        t,
        'failed',
        [expect.stringContaining(`(${globs}) —`)],
      ])
    }
  })

  // Said as a warning (the yellow `[vx]`, a dim body), as every other vx
  // warning is: written into the task's stream it printed uncoloured in a
  // focused run, red inside a frame.
  it('is a warning: tagged in colour, plain without it, never task output', async () => {
    const body =
      ' app#lost: outputs matched no files (build/index.js) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern — it wrote none of its outputs: one written only sometimes (test coverage, written only with coverage on) cannot be declared, so drop it from outputs or run the command so it writes it'
    for (const enabled of [true, false]) {
      const out: string[] = []
      const err: string[] = []
      const sink = (to: string[]) => ({
        isTTY: false,
        write: (c: string | Uint8Array) => to.push(String(c)),
      })
      await run({
        cwd: root,
        tasks: ['lost'],
        projects: ['app'],
        log: defaultLogger({ enabled }, { mode: 'focused' }, sink(out), {
          err: sink(err),
          env: {},
        }),
        handleSignals: false,
      })
      const said = err
        .join('')
        .split('\n')
        .filter((l) => l.includes('matched no files'))
      expect(said).toEqual([
        enabled ? `\x1b[1m\x1b[38;2;234;179;8m[vx]\x1b[0m\x1b[2m${body}\x1b[0m` : `[vx]${body}`,
      ])
      expect(out.join('')).not.toContain('matched no files')
    }
  })

  it('passes outputs that matched, only empty directories, or none declared', async () => {
    for (const t of ['found', 'dirsonly', 'noop']) {
      const r = await runTask(t)
      expect([t, r.ok, r.lines]).toEqual([t, true, []])
    }
    expect((await runTask('found')).status).toBe('cache-hit')
  })
})

// `**/gen/**` in app never reaches app/sub/gen when app/sub is a project of
// its own: the line said the command never wrote it and blamed a
// sometimes-written output, though it wrote app/sub/gen/x.
describe('an output glob whose only match lies in a nested project', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-missing-out-nested-'))
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n  - "packages/app/sub"\n',
    )
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'sub'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'sub', 'package.json'), JSON.stringify({ name: 'sub' }))
    await writeFile(path.join(app, 'sub', 'vx.config.mjs'), 'export default {}\n')
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: {
        gen: { exec: { command: 'mkdir -p sub/gen && echo x > sub/gen/x' },
          inputs: { files: [] }, outputs: { files: ['**/gen/**'] }, cache: true },
      } }\n`,
    )
    await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names the file and the project it lies in', async () => {
    const r = await runTask('gen')
    expect(r.status).toBe('failed')
    expect(r.lines).toEqual([
      "[vx] app#gen: outputs matched no files (**/gen/**) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern — it wrote sub/gen/x, which lies inside the project at packages/app/sub, and a project's globs never reach another project's files: let a task of that project write it, or name it in outputs.workspaceFiles",
    ])
  })
})

describe('an output glob whose only match the save never takes', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-missing-out-installed-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const app = path.join(root, 'packages', 'app')
    await mkdir(app, { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: {
        installed: { exec: { command: 'mkdir -p node_modules/p && echo x > node_modules/p/i.js' },
          inputs: { files: [] }, outputs: { files: ['**/*.js', '!d/**'] }, cache: true },
        fifo: { exec: { command: 'mkdir -p d && rm -f d/p && mkfifo d/p' },
          inputs: { files: [] }, outputs: { files: ['d/p'] }, cache: true },
        takenback: { exec: { command: 'mkdir -p node_modules/q && echo x > node_modules/q/i.cjs' },
          inputs: { files: [] }, outputs: { files: ['**/*.cjs', '!node_modules/q/**', '!d/**'] }, cache: true },
      } }\n`,
    )
    await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // The save never takes an installed file a glob reaches by wildcard alone,
  // so it saved an empty entry and passed, and every later hit restored nothing.
  it('fails a glob whose only match is one the save never takes', async () => {
    const r = await runTask('installed')
    expect([r.status, r.lines]).toEqual([
      'failed',
      [
        "[vx] app#installed: outputs matched no files (**/*.js) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern — it wrote node_modules/p/i.js, which an output never takes: vx's own files never, and node_modules only when the glob names it (node_modules/**)",
      ],
    ])
  })

  // A literal FIFO counted as written: the task passed and saved an empty
  // entry, where the same FIFO under a glob failed it.
  it('fails a literal output that is a FIFO, saying so', async () => {
    const r = await runTask('fifo')
    expect([r.status, r.lines]).toEqual([
      'failed',
      [
        '[vx] app#fifo: outputs matched no files (d/p) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern — d/p is a FIFO, socket or device, which no output holds',
      ],
    ])
  })

  it('names no file a ! entry takes back', async () => {
    const r = await runTask('takenback')
    expect(r.status).toBe('failed')
    expect(r.lines[0]).not.toContain('node_modules/q/i.cjs')
  })
})
