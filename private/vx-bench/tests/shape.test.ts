// shape.ts is the headline benchmark's workspace (owner's spec, 2026-10-09).
// A wrong count is a wrong workload note on every bench table, and a wrong
// edge set changes what every runner is timed on, so the graph is held here.

import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command, idealOf, LEVELS, source, workspace, type Project } from '../shape.js'

const projects = workspace()
const byName = new Map(projects.map((p) => [p.name, p]))

describe('the benchmark workspace', () => {
  it('has 29 levels of 50 libs, 100 apps, 50 terminal libs and one e2e', () => {
    const count = (k: Project['kind']) => projects.filter((p) => p.kind === k).length
    expect({
      core: count('core'),
      lib: count('lib'),
      terminal: count('terminal'),
      app: count('app'),
      e2e: count('e2e'),
    }).toEqual({ core: 5, lib: 29 * 50 - 5, terminal: 50, app: 100, e2e: 1 })
    expect(idealOf(projects).length).toBe(9603)
  })

  it('depends only on lower levels, so it has no cycle', () => {
    const wrong = projects.flatMap((p) =>
      p.deps.filter((d) => byName.get(d)!.level >= p.level).map((d) => `${p.name} → ${d}`),
    )
    expect(wrong).toEqual([])
  })

  it('gives e2e every app and terminal lib, and nothing else depends on a terminal lib', () => {
    const e2e = byName.get('@bench/e2e')!
    expect(e2e.level).toBe(LEVELS + 1)
    expect(e2e.deps.length).toBe(150)
    expect(e2e.deps.every((d) => /^@bench\/(app|t15)-\d+$/.test(d))).toBe(true)
    const users = projects.filter((p) => p !== e2e && p.deps.some((d) => d.startsWith('@bench/t')))
    expect(users).toEqual([])
  })

  it('gives every lib a dependent and each core lib about a quarter of the projects', () => {
    const used = new Set(projects.flatMap((p) => p.deps))
    const unused = projects.filter((p) => p.kind !== 'e2e' && !used.has(p.name))
    expect(unused).toEqual([])
    for (let c = 1; c <= 5; c++) {
      const n = projects.filter((p) => p.deps.includes(`@bench/l1-${c}`)).length
      expect(n).toBeGreaterThan(300)
      expect(n).toBeLessThan(500)
    }
  })

  it("folds every dependency's output into a build, so an edit reaches every output downstream", () => {
    const p = byName.get('@bench/app-1')!
    const cmd = command(p, 'build')
    for (const d of p.deps) expect(cmd).toContain(`../${d.slice('@bench/'.length)}/dist/index.js`)
    expect(cmd).toContain('head -c 204800 /dev/urandom > dist/blob.bin')
    expect(command(byName.get('@bench/l1-1')!, 'build')).not.toContain('cksum')
  })

  // Every program a task starts is time every runner's cold row pays and
  // no runner controls: the commands stay as light as the workload allows.
  it('starts one program past its shell per task, five per build', () => {
    const programs = (cmd: string) => cmd.split(/&&|\|/).map((s) => s.trim().split(' ')[0])
    const app = byName.get('@bench/app-1')!
    expect(programs(command(app, 'build'))).toEqual(['sleep', 'mkdir', 'cat', 'cksum', 'head'])
    for (const t of ['lint', 'test', 'publish', 'typecheck'] as const)
      expect(programs(command(app, t))).toEqual(['sleep'])
  })

  it('builds dist/index.js with a line per dependency and a 200 KB blob', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-bench-shape-'))
    try {
      const p = byName.get('@bench/l2-1')!
      for (const d of p.deps) {
        const dist = path.join(root, d.slice('@bench/'.length), 'dist')
        await mkdir(dist, { recursive: true })
        await writeFile(path.join(dist, 'index.js'), d)
      }
      const dir = path.join(root, p.dir)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'f00.js'), source(p.name, 0))
      const cmd = command({ ...p, tasks: { build: 0 } }, 'build')
      const run = Bun.spawnSync(['sh', '-c', cmd], { cwd: dir, stderr: 'pipe' })
      expect(run.stderr.toString()).toBe('')
      expect(run.exitCode).toBe(0)
      const index = await readFile(path.join(dir, 'dist', 'index.js'), 'utf8')
      expect(index.startsWith(source(p.name, 0))).toBe(true)
      for (const d of p.deps)
        expect(index).toContain(`../${d.slice('@bench/'.length)}/dist/index.js`)
      expect((await stat(path.join(dir, 'dist', 'blob.bin'))).size).toBe(204800)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
