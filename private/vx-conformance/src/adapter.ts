import type { Feature, Selector, TaskReport, WorkspaceSpec } from './spec.ts'

/** Runs a command in the case's sandbox; resolves to its output. */
export type Read = (argv: string[]) => Promise<string>

/** A task's command as the tool must run it: the case's command, with the harness's marks around it. */
export type Command = (project: string, task: string) => string

/**
 * One tool under test. An adapter only translates: the neutral workspace
 * into the tool's own config, a neutral run into the tool's own CLI. It never
 * decides an outcome.
 */
export interface Adapter {
  name: string
  /** The package whose version the report names. */
  pkg: string
  /** Bins linked into the workspace's node_modules/.bin. */
  bins: string[]
  /** What the tool's config cannot express: a case needing one is not applicable. */
  lacks: Feature[]
  /** Variables every invocation of the tool sees. */
  env: Record<string, string>
  /** Prepare the case's home (`home`) before any run: what the tool would otherwise fetch. */
  seed?(home: string): Promise<void>
  /** Write the tool's config for `ws` into `dir`. Returns the commands to run after (each an argv). */
  configure(dir: string, ws: WorkspaceSpec, command: Command): Promise<string[][]>
  /** Run `task` in every project declaring it, or in `projects` and what they depend on. */
  run(task: string, projects?: string[], opts?: RunOptions): string[]
  /** Run `task` where the changes since `base` reach. */
  affected(task: string, base: string): string[]
  /** Run `task` as `run` does, then again as files change, until stopped (SIGINT). A tool lacking `watch` has none. */
  watch?(task: string, projects?: string[]): string[]
  /** What the tool reports about its last run, per `project#task`, from its own output, files or API. */
  report(root: string, read: Read): Promise<Record<string, TaskReport>>
}

/** How a run is asked to run, beyond what it runs. */
export interface RunOptions {
  /** More tasks run beside the first, over the same projects. */
  also?: string[]
  /** At most this many tasks at once. */
  concurrency?: number
  /** The projects to run in, in place of `projects`. */
  select?: Selector[]
  /** Leave out what the selected tasks depend on. */
  only?: boolean
  /** Forwarded to the requested tasks' commands (a CLI's `-- <args>`). */
  args?: string[]
  /** Go on past a failure. */
  continue?: boolean
  /** Ignore cache entries; save fresh ones. */
  force?: boolean
  /** Read the cache, write nothing. */
  readOnlyCache?: boolean
  /** Plan only. */
  dry?: boolean
}

/** A selector in the pnpm filter grammar Turborepo, Vite Task and vx share. */
export function pnpmFilter(s: Selector): string {
  const base = s.tag ? `tag:${s.tag}` : (s.name ?? (s.with ? `{./${s.dir}}` : `./${s.dir}`))
  const caret = s.self === false ? '^' : ''
  const walked =
    s.with === 'dependencies'
      ? `${base}${caret}...`
      : s.with === 'dependents'
        ? `...${caret}${base}`
        : s.with === 'dependents-and-dependencies'
          ? `...${caret}${base}...`
          : base
  return (s.exclude ? '!' : '') + walked
}
