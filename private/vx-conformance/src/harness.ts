// Runs one case against one tool: writes the workspace, lets the adapter
// write the tool's config, commits, then plays the steps and checks each
// run against what the case expects. Everything the tool runs (install,
// its own setup, every run) runs sandboxed in the case's directory: in
// bubblewrap, or for a tool that isolates itself, in that tool's own sandbox.

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
import { caseHome, sandboxed, spawnSandboxed, type SpawnOptions } from './sandbox.ts'
import {
  projectDir,
  type Case,
  type Expect,
  type ReportCheck,
  type TaskReport,
  type TreeCheck,
  type WatchExpect,
  type WatchPhase,
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

/**
 * Where an isolated task's marks go: a tool may grant it no file at the
 * workspace root, so a directory of the case's home, which every case
 * ignores, is granted instead.
 */
export const ISOLATED_RAN = '.home/marks/ran'

/** Where a supervised run lists the processes it left alive. */
const LEFT = '.left'

/** The file whose appearance stops a watch: its supervisor sends SIGINT, as Ctrl-C does. */
const STOP = '.stop-watch'

/**
 * How long a watch phase may take, and how long no task may start or end
 * before it is judged: longer than the slowest tool takes to start a task
 * after a change (Nx, through its daemon: up to 5 s on a loaded machine).
 */
const WATCH = { initialMs: 60_000, timeoutMs: 30_000, quietMs: 8_000, pollMs: 50 }

const SUPERVISE = path.join(import.meta.dir, 'supervise.ts')

const MODULES = path.join(import.meta.dir, '..', 'node_modules')

/** The command a tool runs for `project#task`: the case's own, between the harness's marks. */
export function marked(ws: WorkspaceSpec, project: string, task: string): string {
  const p = ws.projects[project]
  const cmd = p?.tasks?.[task]?.command
  if (p === undefined || cmd === undefined) throw new Error(`no task ${project}#${task}`)
  const ran = path.posix.join(
    path.posix.relative(projectDir(project, p), '.'),
    p.tasks?.[task]?.sandbox ? ISOLATED_RAN : RAN,
  )
  const id = `${project}#${task}`
  const script = `printf '+%s\\n' '${id}' >> ${ran} && (${cmd}) && printf -- '-%s\\n' '${id}' >> ${ran}`
  // Forwarded args land after the whole line: an inner shell takes them as its `$@`.
  return p.tasks?.[task]?.takesArgs ? `sh -c '${script.replaceAll("'", `'\\''`)}' sh` : script
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
  const members = Object.entries(ws.projects).filter(([n, p]) => projectDir(n, p) !== '.')
  // A project at `.` is the root package itself: its name and dependencies go in the root manifest.
  const rootProject = Object.entries(ws.projects).find(([n, p]) => projectDir(n, p) === '.')
  await writeFiles(root, {
    'package.json': JSON.stringify(
      {
        name: rootProject?.[0] ?? 'conformance',
        ...(rootProject ? { version: '0.0.0' } : {}),
        private: true,
        packageManager: `bun@${Bun.version}`,
        // A workspaces entry is a glob: a directory named with glob syntax (`[lib]`) is
        // reached as a user reaches it, by its parent's `*`.
        workspaces: [
          ...new Set(
            members.map(([n, p]) => {
              const dir = projectDir(n, p)
              return /[[*?{]/.test(dir) ? `${path.dirname(dir)}/*` : dir
            }),
          ),
        ],
        ...(rootProject?.[1].deps
          ? {
              dependencies: Object.fromEntries(rootProject[1].deps.map((d) => [d, 'workspace:*'])),
            }
          : {}),
      },
      null,
      2,
    ),
    '.gitignore': [
      'node_modules',
      '.home',
      RAN,
      LEFT,
      STOP,
      '.turbo',
      '.nx',
      '.vx/cache',
      '.moon/cache',
      'dist',
      '',
    ].join('\n'),
    ...ws.files,
    ...rootProject?.[1].files,
  })
  for (const [name, p] of members) {
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
  if (adapter.pkg === undefined) return
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
  left: string[] = [],
  timedOut = false,
  retried: string[] = [],
): string | null {
  if (timedOut)
    return `did not finish within ${expect.within === undefined ? 'the sandbox bound' : `${expect.within} s`}`
  if (expect.alone && left.length > 0) return `left running: ${left.join('; ')}`
  if (expect.orRefused && exit !== 0 && marks.length === 0) return null
  if (expect.exit === 0 && exit !== 0) return `exited ${exit}, expected success`
  if (expect.exit === 'fail' && exit === 0) return 'succeeded, expected a failure'
  const started = marks.filter((m) => m.startsWith('+')).map((m) => m.slice(1))
  // A task with retries starts again by design; its attempts are the case's to count.
  const twice = started.filter((t, i) => started.indexOf(t) !== i && !retried.includes(t))
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

async function checkTree(root: string, want: TreeCheck): Promise<string | null> {
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
  for (const d of want.dirs ?? []) {
    const s = await stat(path.join(root, d)).catch(() => null)
    if (s === null) return `${d} is missing`
    if (!s.isDirectory()) return `${d} is not a directory`
  }
  for (const f of want.missing ?? [])
    if ((await lstat(path.join(root, f)).catch(() => null)) !== null) return `${f} exists`
  for (const [f, mode] of Object.entries(want.modes ?? {})) {
    const s = await stat(path.join(root, f)).catch(() => null)
    if (s === null) return `${f} is missing`
    if ((s.mode & 0o777) !== mode)
      return `${f} has mode ${(s.mode & 0o777).toString(8)}, expected ${mode.toString(8)}`
  }
  return null
}

async function readMaybe(file: string): Promise<string | null> {
  return readFile(file, 'utf8').catch(() => null)
}

/** Who a `sh` step's commits are by. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'c',
  GIT_AUTHOR_EMAIL: 'c@c',
  GIT_COMMITTER_NAME: 'c',
  GIT_COMMITTER_EMAIL: 'c@c',
}

const BASE = process.env['CONFORMANCE_TMP'] ?? os.tmpdir()

export async function runCase(c: Case, adapter: Adapter): Promise<Outcome> {
  if (c.needs?.some((f) => adapter.lacks.includes(f)))
    return {
      status: 'n/a',
      detail: `needs ${c.needs.filter((f) => adapter.lacks.includes(f)).join(', ')}`,
    }
  return await everyPlay(c.races ?? 1, async () => {
    const box = realpathSync(mkdtempSync(path.join(BASE, `conf-${adapter.name}-`)))
    // Files outside the repository sit beside it, in the one directory the run may write.
    const root = c.workspace.outside ? path.join(box, 'repo') : box
    try {
      if (c.workspace.outside) await writeFiles(path.join(box, 'outside'), c.workspace.outside)
      return await play(c, adapter, root, box)
    } finally {
      if (process.env['CONFORMANCE_KEEP']) console.error(`kept ${box}`)
      else rmSync(box, { recursive: true, force: true })
    }
  })
}

/** `n` plays, each in a fresh tree: one that does not pass is the outcome. */
export async function everyPlay(
  n: number,
  playOnce: (i: number) => Promise<Outcome>,
): Promise<Outcome> {
  for (let i = 0; i < n; i++) {
    const o = await playOnce(i)
    if (o.status === 'pass') continue
    if (n === 1) return o
    return { ...o, detail: `play ${i + 1} of ${n}${o.detail ? `: ${o.detail}` : ''}` }
  }
  return { status: 'pass' }
}

async function play(c: Case, adapter: Adapter, root: string, box: string): Promise<Outcome> {
  const boxed = adapter.sandboxed !== false
  const sh = (argv: string[], env: Record<string, string> = {}, cwd = root) =>
    sandboxed(root, cwd, argv, { ...adapter.env, ...env }, { bind: box, boxed })
  const install = () => setup([process.execPath, 'install', '--offline', '--no-progress'])
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
  await install()
  await linkTool(root, adapter)
  await adapter.seed?.(caseHome(root))
  // A repository before the tool's own setup: what git ignores is known to it.
  await setup(['git', 'init', '-q', '-b', 'main'])
  await configure(ws)
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
    if ('install' in step) {
      await install()
      for (const argv of refused === null ? (adapter.installed ?? []) : []) {
        const r = await sh(argv)
        if (r.exit !== 0) {
          refused = `$ ${argv.join(' ')}\n${r.out}`
          break
        }
      }
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
    if ('sh' in step) {
      const r = await sh(['sh', '-c', step.sh], GIT_IDENTITY)
      if (r.exit !== 0) throw new Error(`step ${i + 1} \`${step.sh}\` exited ${r.exit}:\n${r.out}`)
      continue
    }
    if ('configure' in step) {
      ws = step.configure(ws)
      await configure(ws)
      continue
    }
    if ('watch' in step) {
      if (adapter.watch === undefined)
        throw new Error(`${adapter.name} has no watch: list it in lacks`)
      if (refused !== null)
        return { status: 'fail', step: i + 1, detail: 'refused the config', log: refused }
      const failed = await watch(
        root,
        { bind: box, boxed },
        adapter.env,
        adapter
          .watch(step.watch, step.projects)
          .map((a, j) => (j === 0 && a.startsWith('node_modules/') ? path.join(root, a) : a)),
        step.phases,
        async (next) => {
          ws = next(ws)
          await configure(ws)
          return refused
        },
        async (cmd) => {
          const r = await sh(['sh', '-c', cmd], GIT_IDENTITY)
          if (r.exit !== 0) throw new Error(`step ${i + 1} \`${cmd}\` exited ${r.exit}:\n${r.out}`)
        },
      )
      if (failed !== null) return { status: 'fail', step: i + 1, ...failed }
      continue
    }
    await rm(path.join(root, RAN), { force: true })
    await rm(path.join(root, ISOLATED_RAN), { force: true })
    await mkdir(path.dirname(path.join(root, ISOLATED_RAN)), { recursive: true })
    const cwd = 'cwd' in step && step.cwd ? path.join(root, step.cwd) : root
    await rm(path.join(root, LEFT), { force: true })
    const stop = 'stop' in step ? step.stop : undefined
    if (stop) await rm(path.join(root, stop.when), { force: true })
    if (stop?.again) await rm(path.join(root, stop.again), { force: true })
    const tool = (
      'run' in step
        ? adapter.run(step.run, step.projects, {
            ...(step.also ? { also: step.also } : {}),
            ...(step.select ? { select: step.select } : {}),
            ...(step.only ? { only: true } : {}),
            ...(step.args ? { args: step.args } : {}),
            ...(step.concurrency !== undefined ? { concurrency: step.concurrency } : {}),
            ...(step.continue ? { continue: true } : {}),
            ...(step.force ? { force: true } : {}),
            ...(step.readOnlyCache ? { readOnlyCache: true } : {}),
            ...(step.dry ? { dry: true } : {}),
          })
        : adapter.affected(step.affected, step.base)
    )
      // An adapter names its bin from the root; started elsewhere, that path is the root's.
      .map((a, j) => (j === 0 && a.startsWith('node_modules/') ? path.join(root, a) : a))
    const openStdin = 'openStdin' in step && step.openStdin
    const argv =
      stop || step.expect.alone || openStdin
        ? [
            process.execPath,
            SUPERVISE,
            JSON.stringify({
              ...(stop ? { stop } : {}),
              ...(step.expect.alone ? { left: LEFT } : {}),
              ...(openStdin ? { openStdin: true } : {}),
            }),
            ...tool,
          ]
        : tool
    const r =
      refused === null
        ? await sandboxed(
            root,
            cwd,
            argv,
            {
              ...adapter.env,
              ...('env' in step && step.env
                ? Object.fromEntries(
                    Object.entries(step.env).map(([k, v]) => [k, v.replaceAll('$ROOT', root)]),
                  )
                : {}),
            },
            {
              ...(step.expect.within === undefined ? {} : { timeoutMs: step.expect.within * 1000 }),
              hostProc: c.needs?.includes('sandbox') === true,
              bind: box,
              boxed,
            },
          )
        : { exit: 1, out: refused }
    const left: string[] = step.expect.alone
      ? JSON.parse((await readMaybe(path.join(root, LEFT))) ?? '[]')
      : []
    const marks: string[] = []
    for (const f of [RAN, ISOLATED_RAN])
      marks.push(...((await readMaybe(path.join(root, f))) ?? '').split('\n').filter(Boolean))
    const files: Record<string, string | null> = {}
    for (const f of [
      ...Object.keys(step.expect.files ?? {}),
      ...Object.keys(step.expect.filesNot ?? {}),
      ...Object.keys(step.expect.ifReplayed?.files ?? {}),
    ])
      files[f] = await readMaybe(path.join(root, f))
    let failed = check(
      step.expect,
      r.exit,
      r.out,
      marks,
      files,
      left,
      'timedOut' in r && r.timedOut === true,
      Object.entries(ws.projects).flatMap(([n, p]) =>
        Object.entries(p.tasks ?? {})
          .filter(([, t]) => (t.retries ?? 0) > 0)
          .map(([t]) => `${n}#${t}`),
      ),
    )
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

/**
 * Starts `argv` (a tool's watch) under a supervisor in the case's sandbox
 * (`box`), plays each phase against it, then stops it with SIGINT; one that
 * does not exit within 10 s is killed with its whole sandbox.
 */
async function watch(
  root: string,
  box: SpawnOptions,
  env: Record<string, string>,
  argv: string[],
  phases: WatchPhase[],
  reconfigure: (next: (ws: WorkspaceSpec) => WorkspaceSpec) => Promise<string | null>,
  shell: (cmd: string) => Promise<void>,
): Promise<{ detail: string; log: string } | null> {
  for (const f of [RAN, ISOLATED_RAN, STOP]) await rm(path.join(root, f), { force: true })
  await mkdir(path.dirname(path.join(root, ISOLATED_RAN)), { recursive: true })
  const stop = { signal: 'SIGINT', when: STOP, waitMs: 3_600_000 }
  const supervised = [process.execPath, SUPERVISE, JSON.stringify({ stop }), ...argv]
  const w = spawnSandboxed(root, root, supervised, env, box)
  let exited = false
  void w.proc.exited.then(() => (exited = true))
  const marks = async () => {
    const all: string[] = []
    for (const f of [RAN, ISOLATED_RAN])
      all.push(...((await readMaybe(path.join(root, f))) ?? '').split('\n').filter(Boolean))
    return all
  }
  const log = () => `$ ${argv.join(' ')}\n${w.out()}`.slice(-4000)
  try {
    for (const [j, phase] of phases.entries()) {
      const offset = (await marks()).length
      if (phase.write) await writeFiles(root, phase.write)
      if (phase.sh) await shell(phase.sh)
      if (phase.configure) {
        const refused = await reconfigure(phase.configure)
        if (refused !== null) return { detail: `phase ${j + 1}: refused the config`, log: refused }
      }
      const names = [
        ...Object.keys(phase.expect.files ?? {}),
        ...Object.keys(phase.expect.filesNot ?? {}),
      ]
      const failed = await awaitPhase(
        phase.expect,
        async () => ({
          marks: (await marks()).slice(offset),
          files: Object.fromEntries(
            await Promise.all(
              names.map(async (f) => [f, await readMaybe(path.join(root, f))] as const),
            ),
          ),
        }),
        {
          timeoutMs: j === 0 ? WATCH.initialMs : WATCH.timeoutMs,
          quietMs: WATCH.quietMs,
          pollMs: WATCH.pollMs,
          alive: () => !exited,
        },
      )
      if (failed !== null)
        return {
          detail: `phase ${j + 1}: ${failed === 'the watch exited' ? `the watch exited ${w.proc.exitCode}` : failed}`,
          log: log(),
        }
    }
    return null
  } finally {
    await writeFile(path.join(root, STOP), '')
    const ended = await Promise.race([
      w.proc.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ])
    if (!ended) w.kill()
    await w.proc.exited
  }
}

// A watch phase is judged by polling the marks and files the tasks leave
// until what it expects holds and the watch has gone quiet (no task started
// or ended for a while), or the time runs out. Quiet is what makes "it did
// not run" and "it ran once" mean something: a rerun a tool makes late, or
// a loop on its own output, lands inside the window.

/** What a poll sees: the marks since the phase's change, and the files the phase names. */
export interface Seen {
  marks: string[]
  files: Record<string, string | null>
}

export interface PhaseTiming {
  timeoutMs: number
  /** How long no mark may land before the phase is judged. */
  quietMs: number
  pollMs: number
  alive: () => boolean
}

/** Whether `task` started and then ended within `marks`. */
function finished(marks: string[], task: string): boolean {
  const start = marks.indexOf(`+${task}`)
  return start !== -1 && marks.indexOf(`-${task}`, start) !== -1
}

function holds(expect: WatchExpect, s: Seen): boolean {
  return (
    (expect.ran ?? []).every((t) => finished(s.marks, t)) &&
    Object.entries(expect.files ?? {}).every(([f, want]) => (s.files[f] ?? null) === want)
  )
}

export async function awaitPhase(
  expect: WatchExpect,
  seen: () => Promise<Seen>,
  t: PhaseTiming,
): Promise<string | null> {
  const start = performance.now()
  let marks = -1
  let changed = start
  for (;;) {
    if (!t.alive()) return 'the watch exited'
    const s = await seen()
    const now = performance.now()
    if (s.marks.length !== marks) {
      marks = s.marks.length
      changed = now
    }
    const ok = holds(expect, s)
    if (ok && (expect.inFlight || now - changed >= t.quietMs))
      return check(expect, 0, '', s.marks, s.files)
    if (now - start >= t.timeoutMs) {
      const after = `after ${t.timeoutMs / 1000} s`
      if (ok) return `${after}: still running tasks, never quiet`
      const unfinished = (expect.ran ?? []).find(
        (task) => s.marks.includes(`+${task}`) && !finished(s.marks, task),
      )
      const failed = check(expect, 0, '', s.marks, s.files)
      if (failed?.startsWith('did not run') || unfinished === undefined)
        return `${after}: ${failed ?? 'nothing held'}`
      return `${after}: ${unfinished} started and did not finish`
    }
    await Bun.sleep(t.pollMs)
  }
}
