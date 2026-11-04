// Runs one case against one tool: writes the workspace, lets the adapter
// write the tool's config, commits, then plays the steps and checks each
// run against what the case expects. Everything the tool runs (install,
// its own setup, every run) runs sandboxed in the case's directory.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Adapter } from './adapter.ts'
import { caseHome, sandboxed } from './sandbox.ts'
import {
  projectDir,
  type Case,
  type Expect,
  type ReportCheck,
  type TaskReport,
  type WorkspaceSpec,
} from './spec.ts'

export type Status = 'pass' | 'fail' | 'n/a'

export interface Outcome {
  status: Status
  /** Which step failed (1-based), and how. */
  step?: number
  detail?: string
  /** The failed run's output, trimmed. */
  log?: string
}

/** Where a run's marks go: each command appends `+id` when it starts and `-id` when it ends. */
const RAN = '.ran'

const MODULES = path.join(import.meta.dir, '..', 'node_modules')

/** The command a tool runs for `project#task`: the case's own, between the harness's marks. */
export function marked(ws: WorkspaceSpec, project: string, task: string): string {
  const p = ws.projects[project]
  const cmd = p?.tasks?.[task]?.command
  if (p === undefined || cmd === undefined) throw new Error(`no task ${project}#${task}`)
  const ran = path.posix.join(path.posix.relative(projectDir(project, p), '.'), RAN)
  const id = `${project}#${task}`
  return `printf '+%s\\n' '${id}' >> ${ran} && (${cmd}) && printf -- '-%s\\n' '${id}' >> ${ran}`
}

async function writeFiles(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    if (content === null) {
      await rm(abs, { recursive: true, force: true })
      continue
    }
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
}

/** The tree every tool starts from: package manifests, the case's files, git ignores. */
async function writeWorkspace(root: string, ws: WorkspaceSpec): Promise<void> {
  const dirs = Object.entries(ws.projects).map(([n, p]) => projectDir(n, p))
  await writeFiles(root, {
    'package.json': JSON.stringify(
      {
        name: 'conformance',
        private: true,
        packageManager: `bun@${Bun.version}`,
        workspaces: dirs,
      },
      null,
      2,
    ),
    '.gitignore': ['node_modules', '.home', RAN, '.turbo', '.nx', '.vx/cache', 'dist', ''].join(
      '\n',
    ),
    ...ws.files,
  })
  for (const [name, p] of Object.entries(ws.projects)) {
    const dir = projectDir(name, p)
    await writeFiles(root, {
      [`${dir}/package.json`]: JSON.stringify(
        {
          name,
          version: '0.0.0',
          private: true,
          dependencies: Object.fromEntries((p.deps ?? []).map((d) => [d, 'workspace:*'])),
        },
        null,
        2,
      ),
      ...Object.fromEntries(Object.entries(p.files ?? {}).map(([f, c]) => [`${dir}/${f}`, c])),
    })
  }
}

/** The tool's package and bins, linked from this package's pinned install: no registry. */
async function linkTool(root: string, adapter: Adapter): Promise<void> {
  const bin = path.join(root, 'node_modules', '.bin')
  await mkdir(bin, { recursive: true })
  const pkg = path.join(root, 'node_modules', adapter.pkg)
  await mkdir(path.dirname(pkg), { recursive: true })
  await symlink(realpathSync(path.join(MODULES, adapter.pkg)), pkg)
  for (const b of adapter.bins)
    await symlink(realpathSync(path.join(MODULES, '.bin', b)), path.join(bin, b))
}

export function check(
  expect: Expect,
  exit: number,
  out: string,
  marks: string[],
  files: Record<string, string | null>,
): string | null {
  if (expect.exit === 0 && exit !== 0) return `exited ${exit}, expected success`
  if (expect.exit === 'fail' && exit === 0) return 'succeeded, expected a failure'
  const started = marks.filter((m) => m.startsWith('+')).map((m) => m.slice(1))
  const twice = started.filter((t, i) => started.indexOf(t) !== i)
  if (twice.length > 0) return `ran ${[...new Set(twice)].join(', ')} more than once`
  const missed = (expect.ran ?? []).filter((t) => !started.includes(t))
  if (missed.length > 0) return `did not run ${missed.join(', ')}`
  const extra = (expect.notRan ?? []).filter((t) => started.includes(t))
  if (extra.length > 0) return `ran ${extra.join(', ')}, expected it replayed or left out`
  for (const [a, b] of expect.order ?? []) {
    const end = marks.indexOf(`-${a}`)
    const start = marks.indexOf(`+${b}`)
    if (end === -1 || start === -1 || end > start) return `${b} started before ${a} finished`
  }
  if (expect.ifReplayed && !started.includes(expect.ifReplayed.task))
    for (const [f, want] of Object.entries(expect.ifReplayed.files))
      if ((files[f] ?? null) !== want)
        return `${expect.ifReplayed.task} replayed and left ${f} ${files[f] === null || files[f] === undefined ? 'missing' : JSON.stringify(files[f])}, expected ${want === null ? 'none' : JSON.stringify(want)}`
  for (const [f, stale] of Object.entries(expect.filesNot ?? {}))
    if (files[f] === stale) return `${f} is ${JSON.stringify(stale)}, a stale result`
  for (const text of expect.output ?? [])
    if (!out.includes(text)) return `output lacks ${JSON.stringify(text)}`
  for (const [f, want] of Object.entries(expect.files ?? {})) {
    const got = files[f] ?? null
    if (got !== want)
      return want === null
        ? `${f} exists, expected none`
        : `${f} is ${got === null ? 'missing' : JSON.stringify(got)}, expected ${JSON.stringify(want)}`
  }
  return null
}

/** Whether `got` reports each metric `want` names, within its bounds. */
export function checkReport(want: ReportCheck, got: TaskReport | undefined): string | null {
  for (const [metric, bound] of Object.entries(want)) {
    const value = got?.[metric as keyof TaskReport]
    if (value === undefined) return `reports no ${metric}`
    if (typeof bound === 'string') {
      if (value !== bound) return `reports ${metric} ${value}, expected ${bound}`
      continue
    }
    const [min, max] = bound as [number, number]
    if (typeof value !== 'number' || value < min || value > max)
      return `reports ${metric} ${value}, expected ${min}–${max}`
  }
  return null
}

async function checkTree(
  root: string,
  want: { executable?: string[]; links?: Record<string, string> },
): Promise<string | null> {
  for (const f of want.executable ?? []) {
    const s = await stat(path.join(root, f)).catch(() => null)
    if (s === null) return `${f} is missing`
    if ((s.mode & 0o111) === 0) return `${f} is not executable`
  }
  for (const [f, target] of Object.entries(want.links ?? {})) {
    const s = await lstat(path.join(root, f)).catch(() => null)
    if (s === null) return `${f} is missing`
    if (!s.isSymbolicLink()) return `${f} is not a symlink`
    const got = await readlink(path.join(root, f))
    if (got !== target) return `${f} links to ${got}, expected ${target}`
  }
  return null
}

async function readMaybe(file: string): Promise<string | null> {
  return readFile(file, 'utf8').catch(() => null)
}

const BASE = process.env['CONFORMANCE_TMP'] ?? os.tmpdir()

export async function runCase(c: Case, adapter: Adapter): Promise<Outcome> {
  if (c.needs?.some((f) => adapter.lacks.includes(f)))
    return {
      status: 'n/a',
      detail: `needs ${c.needs.filter((f) => adapter.lacks.includes(f)).join(', ')}`,
    }
  const root = realpathSync(mkdtempSync(path.join(BASE, `conf-${adapter.name}-`)))
  try {
    return await play(c, adapter, root)
  } finally {
    if (process.env['CONFORMANCE_KEEP']) console.error(`kept ${root}`)
    else rmSync(root, { recursive: true, force: true })
  }
}

async function play(c: Case, adapter: Adapter, root: string): Promise<Outcome> {
  const sh = (argv: string[], env: Record<string, string> = {}) =>
    sandboxed(root, root, argv, { ...adapter.env, ...env })
  const setup = async (argv: string[]) => {
    const r = await sh(argv)
    if (r.exit !== 0) throw new Error(`setup \`${argv.join(' ')}\` exited ${r.exit}:\n${r.out}`)
  }
  // A tool that refuses a config when it is written (vx at `vx lock`)
  // refuses every run until the config changes: each run reads as that
  // refusal, exit 1, nothing run.
  let refused: string | null = null
  const configure = async (ws: WorkspaceSpec) => {
    refused = null
    for (const argv of await adapter.configure(root, ws, (p, t) => marked(ws, p, t))) {
      const r = await sh(argv)
      if (r.exit !== 0) {
        refused = `$ ${argv.join(' ')}\n${r.out}`
        break
      }
    }
  }
  let ws = c.workspace
  await writeWorkspace(root, ws)
  await setup([process.execPath, 'install', '--offline', '--no-progress'])
  await linkTool(root, adapter)
  await adapter.seed?.(caseHome(root))
  await configure(ws)
  await setup(['git', 'init', '-q', '-b', 'main'])
  await setup(['git', 'add', '-A'])
  await setup(['git', '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-qm', 'init'])

  for (const [i, step] of c.steps.entries()) {
    if ('write' in step) {
      await writeFiles(root, step.write)
      continue
    }
    if ('chmod' in step) {
      for (const [f, mode] of Object.entries(step.chmod)) await chmod(path.join(root, f), mode)
      continue
    }
    if ('link' in step) {
      for (const [f, target] of Object.entries(step.link)) {
        await rm(path.join(root, f), { force: true })
        await mkdir(path.dirname(path.join(root, f)), { recursive: true })
        await symlink(target, path.join(root, f))
      }
      continue
    }
    if ('check' in step) {
      const failed = await checkTree(root, step.check)
      if (failed !== null) return { status: 'fail', step: i + 1, detail: failed }
      continue
    }
    if ('commit' in step) {
      await setup(['git', 'add', '-A'])
      await setup([
        'git',
        '-c',
        'user.name=c',
        '-c',
        'user.email=c@c',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        step.commit,
      ])
      continue
    }
    if ('configure' in step) {
      ws = step.configure(ws)
      await configure(ws)
      continue
    }
    await rm(path.join(root, RAN), { force: true })
    const argv =
      'run' in step
        ? adapter.run(step.run, step.projects)
        : adapter.affected(step.affected, step.base)
    const r =
      refused === null ? await sh(argv, 'env' in step ? step.env : {}) : { exit: 1, out: refused }
    const marks = ((await readMaybe(path.join(root, RAN))) ?? '').split('\n').filter(Boolean)
    const files: Record<string, string | null> = {}
    for (const f of [
      ...Object.keys(step.expect.files ?? {}),
      ...Object.keys(step.expect.filesNot ?? {}),
      ...Object.keys(step.expect.ifReplayed?.files ?? {}),
    ])
      files[f] = await readMaybe(path.join(root, f))
    let failed = check(step.expect, r.exit, r.out, marks, files)
    if (failed === null && step.expect.report !== undefined && refused === null) {
      const { task, ...want } = step.expect.report
      const read = async (argv: string[]) => (await sh(argv)).out
      const got = await adapter.report(root, read).catch(() => ({}))
      failed = checkReport(want, (got as Record<string, TaskReport>)[task])
    }
    if (failed !== null)
      return {
        status: 'fail',
        step: i + 1,
        detail: failed,
        log: `$ ${argv.join(' ')}\n${r.out}`.slice(-4000),
      }
  }
  return { status: 'pass' }
}
