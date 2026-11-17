// A stale hit hides behind a sequence, not a step: an edit, a branch
// switch, a deleted output, then a run. Seeded random everyday operations
// drive the CLI as a user does, and after every run each project's
// outputs must equal what a model computes from the files on disk,
// sharing nothing with the cache: 12 seeds x 150 steps of the first
// form ran clean against the published 0.0.656 (2026-11-17), and the
// probe stays as this test.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { rng } from './helpers/rng.js'
import { addProject, gitIn, gitInit, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '../src/bin.ts')
const PROJECTS = ['a', 'b', 'c', 'd'] as const
type Project = (typeof PROJECTS)[number]
const DEPS: Record<Project, readonly Project[]> = { a: [], b: ['a'], c: ['b'], d: [] }
const NAMES = ['a.txt', 'b.txt', 'sub/c.txt', 'sub/deep/d.txt', 'with space.txt', 'ünï.txt', '.hid']

// Every source file by name, mode and bytes, each dependency's output,
// one env value; a copy of every file and a link beside it.
const command = (p: Project): string =>
  'rm -rf dist && mkdir -p dist/files && { find src -type f | LC_ALL=C sort | while read -r f; do ' +
  'echo "== $f"; if [ -x "$f" ]; then echo x; fi; cat "$f"; done; ' +
  DEPS[p].map((u) => `cat ../${u}/dist/out.txt; `).join('') +
  'echo "env=$FZ"; } > dist/out.txt && find src -type f | LC_ALL=C sort | while read -r f; do ' +
  `cp "$f" "dist/files/$(echo "$f" | LC_ALL=C tr '/ ' '__')"; done && ln -s out.txt dist/link`

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

function sources(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else out.push(r)
    }
  }
  walk('src')
  return out.sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))
}

/** A name as the bytes the shell wrote, read back the way file bodies are. */
const bytes = (s: string): string => Buffer.from(s).toString('latin1')

interface Outputs {
  out: string
  files: Record<string, string>
  link: string
  names: string[]
}

function model(root: string, fz: string): Record<Project, Outputs> {
  const memo = new Map<Project, Outputs>()
  const of = (p: Project): Outputs => {
    const hit = memo.get(p)
    if (hit !== undefined) return hit
    const dir = path.join(root, 'packages', p)
    let out = ''
    const files: Record<string, string> = {}
    for (const f of sources(dir)) {
      const full = path.join(dir, f)
      const body = readFileSync(full, 'latin1')
      out += `== ${bytes(f)}\n${(statSync(full).mode & 0o111) !== 0 ? 'x\n' : ''}${body}`
      files[f.replaceAll('/', '_').replaceAll(' ', '_')] = body
    }
    for (const u of DEPS[p]) out += of(u).out
    const made = {
      out: `${out}env=${fz}\n`,
      files,
      link: 'out.txt',
      names: ['files', 'link', 'out.txt'],
    }
    memo.set(p, made)
    return made
  }
  return Object.fromEntries(PROJECTS.map((p) => [p, of(p)])) as Record<Project, Outputs>
}

function onDisk(root: string): Record<Project, Outputs | string> {
  return Object.fromEntries(
    PROJECTS.map((p) => {
      const dist = path.join(root, 'packages', p, 'dist')
      try {
        return [
          p,
          {
            out: readFileSync(path.join(dist, 'out.txt'), 'latin1'),
            files: Object.fromEntries(
              readdirSync(path.join(dist, 'files')).map((n) => [
                n,
                readFileSync(path.join(dist, 'files', n), 'latin1'),
              ]),
            ),
            link: readlinkSync(path.join(dist, 'link')),
            names: readdirSync(dist).sort(),
          },
        ]
      } catch (e) {
        return [p, String(e)]
      }
    }),
  ) as Record<Project, Outputs | string>
}

async function drive(seed: number, steps: number): Promise<void> {
  const next = rng(seed)
  const int = (n: number): number => Math.floor(next() * n)
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!
  const root = await makeWorkspace({ prefix: 'vx-everyday-', workspaceFile: false, git: false })
  roots.push(root)
  writeFileSync(path.join(root, '.gitignore'), 'dist\n')
  for (const p of PROJECTS) {
    await addProject(root, p, {
      files: { 'src/a.txt': `${p}\n` },
      config: `export default { tasks: { build: {
        exec: { command: ${JSON.stringify(command(p))}, env: { passThrough: ['FZ'] } },
        dependsOn: [${DEPS[p].map((u) => `'packages/${u}#build'`).join(', ')}],
        inputs: { files: ['src/**'], env: ['FZ'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }\n`,
    })
  }
  gitInit(root)
  const git = gitIn(root)
  const vx = async (
    fz: string | undefined,
    ...args: string[]
  ): Promise<{ code: number; out: string }> => {
    const { FZ: _, ...env } = process.env
    const p = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: root,
      env: { ...env, NO_COLOR: '1', ...(fz === undefined ? {} : { FZ: fz }) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { code, out: out + err }
  }
  expect((await vx(undefined, 'lock')).code).toBe(0)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')

  const clean = (): boolean => git('status', '--porcelain').trim() === ''
  const op = (): string => {
    const p = pick(PROJECTS)
    const dir = path.join(root, 'packages', p)
    const files = sources(dir).map((f) => path.join(dir, f))
    const fresh = (): string => {
      const f = path.join(dir, 'src', pick(NAMES))
      mkdirSync(path.dirname(f), { recursive: true })
      return f
    }
    const k = pick([
      'edit',
      'edit',
      'edit',
      'new',
      'delete',
      'rename',
      'chmod',
      'touch',
      'samesize',
      'undo',
      'emptydir',
      'commit',
      'revert',
      'branch',
      'add',
      'stash',
      'rmdist',
      'editout',
      'rmout',
      'extraout',
      'noop',
    ] as const)
    const f = pick(files)
    if (k === 'edit') writeFileSync(f, `${next()}\n`.repeat(int(4)))
    else if (k === 'new') writeFileSync(fresh(), `${int(6)}\n`)
    else if (k === 'delete' && files.length > 1) rmSync(f)
    else if (k === 'rename') renameSync(f, fresh())
    else if (k === 'chmod') chmodSync(f, pick([0o644, 0o755]))
    else if (k === 'touch') {
      const t = Date.now() / 1000 + pick([-100_000, -5, 0, 5, 100_000])
      utimesSync(f, t, t)
    } else if (k === 'samesize') {
      const b = readFileSync(f)
      if (b.length > 0) {
        const i = int(b.length)
        b[i] = b[i] === 0x41 ? 0x42 : 0x41
        writeFileSync(f, b)
      }
    } else if (k === 'undo') {
      const b = readFileSync(f)
      writeFileSync(f, Buffer.concat([b, Buffer.from('x')]))
      writeFileSync(f, b)
    } else if (k === 'emptydir')
      mkdirSync(path.join(dir, 'src', `empty${int(3)}`), { recursive: true })
    else if (k === 'commit') {
      git('add', '-A')
      git('commit', '-q', '--allow-empty', '-m', 'c')
    } else if (k === 'revert') {
      git('checkout', '-q', '--', '.')
      git('clean', '-qfd', 'packages')
    } else if (k === 'branch' && clean()) {
      const b = pick(['two', 'feat1', 'feat2'])
      git('checkout', '-q', ...(git('branch', '--list', b).trim() === '' ? ['-b'] : []), b)
    } else if (k === 'add') git('add', '-A')
    else if (k === 'stash' && !clean()) {
      git('stash', '-q', '-u')
      git('stash', 'pop', '-q')
    } else if (k === 'rmdist') rmSync(path.join(dir, 'dist'), { recursive: true, force: true })
    else if (k === 'editout' && existsSync(path.join(dir, 'dist/out.txt')))
      writeFileSync(path.join(dir, 'dist/out.txt'), 'tampered\n', { flag: 'a' })
    else if (k === 'rmout')
      rmSync(path.join(dir, 'dist', pick(['out.txt', 'link', 'files'])), {
        recursive: true,
        force: true,
      })
    else if (k === 'extraout' && existsSync(path.join(dir, 'dist/files')))
      writeFileSync(path.join(dir, 'dist/files/extra.txt'), 'extra')
    return `${k}:${p}`
  }

  const log: string[] = []
  for (let step = 0; step < steps; step++) {
    for (let n = 1 + int(3); n > 0; n--) log.push(op())
    const fz = pick([undefined, '1', '2'])
    const r = await vx(fz, 'run', 'build', '--all')
    const at = `seed ${seed} step ${step} FZ=${fz} after ${log.slice(-9).join(' ')}`
    expect([at, r.code, r.code === 0 ? '' : r.out]).toEqual([at, 0, ''])
    expect([at, onDisk(root)]).toEqual([at, model(root, fz ?? '')])
  }
}

for (const seed of [1, 2]) {
  it(`outputs equal the model after every run of random everyday operations (seed ${seed})`, async () => {
    await drive(seed, 40)
  }, 180_000)
}
