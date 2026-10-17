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

const BIN = path.resolve(import.meta.dir, 'vx-locked.ts')

export const PARITY_TIMEOUT = 60_000

/** A `build` that leaves an output and echoes its input, plus `test` and `lint`. */
function projectConfig(name: string, extra = ''): string {
  return `
  export default {
    tasks: {
      build: {
        description: 'build ${name}',
        exec: { command: 'mkdir -p dist && echo built-${name} > dist/out.txt && cat src/in.txt' },
        dependsOn: ['^build'],
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
      },
      test: {
        exec: { command: 'echo test-${name}' },
        dependsOn: ['build'],
        inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
      },
      lint: {
        exec: { command: 'echo lint-${name}' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
      },
      ${extra}
    },
  }
`
}

export async function makeParityWorkspace(prefix: string): Promise<string> {
  const root = await makeWorkspace({
    prefix,
    git: 'init',
    edges: { ui: ['lib'], app: ['ui', 'lib'] },
  })
  await addProject(root, 'lib', {
    config: projectConfig('lib'),
    files: { 'src/in.txt': 'lib-v1\n' },
  })
  await addProject(root, 'ui', {
    config: projectConfig('ui'),
    files: { 'src/in.txt': 'ui-v1\n' },
  })
  await addProject(root, 'app', {
    config: projectConfig('app'),
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
  /** Why `--affected` selected it: the file, and the dependencies it came through. */
  affected?: { kind: string; file?: string; via?: string[] }
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

/**
 * A run, then its rows as `vx last --format json` reads them back: the tasks
 * by id (`noCache` where the task declares no cache), plus the exit code.
 */
export async function summarized(
  root: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; tasks: Map<string, Record<string, unknown>>; text: string }> {
  const r = await vx(root, ['run', ...args], env)
  // The history lives in the run's cache directory.
  const at = args.indexOf('--cache-dir')
  const dir = at === -1 ? [] : ['--cache-dir', args[at + 1]!]
  const last = await vx(root, ['last', '--format', 'json', ...dir], env)
  const rows = (JSON.parse(last.out) as { tasks: Array<Record<string, unknown>> }).tasks
  const tasks = new Map(
    rows.map((t) => [
      `${String(t['project'])}#${String(t['task'])}`,
      { ...t, ...(t['cached'] === false ? { noCache: true } : {}) },
    ]),
  )
  return { code: r.code, tasks, text: r.out + r.err }
}
