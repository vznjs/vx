// The workspace the Turbo / Nx parity suites share: four packages with the
// dependency shape both runners' docs use for their examples —
//
//   app ─▶ ui ─▶ lib        docs (independent)
//    └────────▶ lib
//
// Every `build` writes `dist/out.txt` and prints its input; `test` and
// `lint` read only `src/**`. Committed, so a `[<ref>]` filter has a base.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { addProject, gitIn, makeWorkspace } from './workspace.js'

const BIN = path.resolve(import.meta.dir, '..', '..', 'src', 'bin.ts')

export const PARITY_TIMEOUT = 60_000

/** A `build` that leaves an output and echoes its input, plus `test` and `lint`. */
export function projectConfig(name: string, extra = ''): string {
  return `
  export default {
    tasks: {
      build: {
        description: 'build ${name}',
        exec: { command: 'mkdir -p dist && echo built-${name} > dist/out.txt && cat src/in.txt' },
        dependsOn: ['^build'],
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
      test: {
        exec: { command: 'echo test-${name}' },
        dependsOn: ['build'],
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      },
      lint: {
        exec: { command: 'echo lint-${name}' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      },
      ${extra}
    },
  }
`
}

export async function makeParityWorkspace(prefix: string): Promise<string> {
  const root = await makeWorkspace({ prefix, git: 'init' })
  await addProject(root, 'lib', {
    config: projectConfig('lib'),
    files: { 'src/in.txt': 'lib-v1\n' },
  })
  await addProject(root, 'ui', {
    config: projectConfig('ui'),
    deps: { lib: 'workspace:*' },
    files: { 'src/in.txt': 'ui-v1\n' },
  })
  await addProject(root, 'app', {
    config: projectConfig('app'),
    deps: { ui: 'workspace:*', lib: 'workspace:*' },
    files: { 'src/in.txt': 'app-v1\n' },
  })
  await addProject(root, 'docs', {
    config: projectConfig('docs'),
    files: { 'src/in.txt': 'docs-v1\n' },
  })
  await mkdir(path.join(root, 'shared'), { recursive: true })
  await writeFile(path.join(root, 'tsconfig.base.json'), '{"compilerOptions":{}}\n')
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return root
}

export interface VxResult {
  code: number
  out: string
  err: string
}

export async function vx(
  root: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

export interface DryTask {
  id: string
  project: string
  task: string
  description?: string
  hash: string
  cacheStatus: string
  deps: string[]
}

/** `vx run … --dry=json`, parsed; throws on a non-zero exit so a test reads the reason. */
export async function dry(
  root: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<DryTask[]> {
  const r = await vx(root, ['run', ...args, '--dry=json'], env)
  if (r.code !== 0)
    throw new Error(`vx run ${args.join(' ')} --dry=json exited ${r.code}: ${r.err}`)
  return (JSON.parse(r.out) as { tasks: DryTask[] }).tasks
}

/** The planned task ids, sorted — what a selection resolved to. */
export async function planned(
  root: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<string[]> {
  return (await dry(root, args, env)).map((t) => t.id).sort()
}

/** A `--summarize` run: the tasks by id, plus the exit code. */
export async function summarized(
  root: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; tasks: Map<string, Record<string, unknown>>; text: string }> {
  const file = path.join(root, `summary-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  // Before any `--`: everything after it is the task's, not vx's.
  const dash = args.indexOf('--')
  const own = dash === -1 ? args : args.slice(0, dash)
  const forwarded = dash === -1 ? [] : args.slice(dash)
  const r = await vx(root, ['run', ...own, `--summarize=${file}`, ...forwarded], env)
  const payload = JSON.parse(await Bun.file(file).text()) as {
    tasks: Array<Record<string, unknown> & { id: string }>
  }
  return { code: r.code, tasks: new Map(payload.tasks.map((t) => [t.id, t])), text: r.out + r.err }
}
