// A declared output that matches no files after the command exits 0 fails
// the task: an empty artifact replayed by every later hit reads as a build
// that ran (M 2026-11-22: every declared output is required).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

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

describe('a declared output that matches no files', () => {
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
          inputs: { files: ['src/**'] }, outputs: { files: ['build/**'] }, cache: true },
        uncached: { exec: { command: 'true' }, outputs: { files: ['gone/**'] } },
        partial: { exec: { command: 'echo x > partial.info' },
          inputs: { files: ['src/**'] }, outputs: { files: ['emit/**', 'partial.info'] }, cache: true },
        literal: { exec: { command: 'mkdir -p lib && echo x > lib/a.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['lib/**', 'types.d.ts'] }, cache: true },
        wspartial: { exec: { command: 'echo x > stamp.info' },
          inputs: { files: ['src/**'] },
          outputs: { files: ['stamp.info'], workspaceFiles: ['wsgone/**'] }, cache: true },
        takenback: { exec: { command: 'mkdir -p out && echo x > out/a.map' },
          inputs: { files: ['src/**'] }, outputs: { files: ['out/**', '!out/**/*.map'] }, cache: true },
        found: { exec: { command: 'mkdir -p dist && echo x > dist/a.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true },
        emptyroot: { exec: { command: 'mkdir -p void' },
          inputs: { files: ['src/**'] }, outputs: { files: ['void/**'] }, cache: true },
        dirsonly: { exec: { command: 'mkdir -p gen/a/b' },
          inputs: { files: ['src/**'] }, outputs: { files: ['gen/**'] }, cache: true },
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
      '[vx] app#lost: outputs matched no files (build/**) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern',
    ])
    // Nothing was saved: the next run runs the command again and fails again.
    expect((await runTask('lost')).status).toBe('failed')
  })

  it('fails an uncached task too', async () => {
    const r = await runTask('uncached')
    expect(r.status).toBe('failed')
    expect(r.lines).toHaveLength(1)
  })

  it('names only the pattern that matched nothing, a wildcard or a literal', async () => {
    expect((await runTask('partial')).lines).toEqual([
      expect.stringContaining('app#partial: outputs matched no files (emit/**) —'),
    ])
    expect((await runTask('literal')).lines).toEqual([
      expect.stringContaining('app#literal: outputs matched no files (types.d.ts) —'),
    ])
    expect((await runTask('wspartial')).lines).toEqual([
      expect.stringContaining('app#wspartial: outputs matched no files (wsgone/**) —'),
    ])
  })

  it('counts a file a negation takes back as no match', async () => {
    const r = await runTask('takenback')
    expect(r.status).toBe('failed')
    expect(r.lines).toEqual([expect.stringContaining('(out/**)')])
  })

  it('fails a `dir/**` whose dir the command left empty', async () => {
    const r = await runTask('emptyroot')
    expect(r.status).toBe('failed')
    expect(r.lines).toEqual([expect.stringContaining('(void/**)')])
  })

  it('passes outputs that matched, only empty directories, or none declared', async () => {
    for (const t of ['found', 'dirsonly', 'noop']) {
      const r = await runTask(t)
      expect([t, r.ok, r.lines]).toEqual([t, true, []])
    }
    expect((await runTask('found')).status).toBe('cache-hit')
  })
})
