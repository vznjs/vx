// The neutral language a case is written in. It names what a user of any
// task runner asks for (a command, its order, what keys it, what it leaves
// behind) and what they can see afterwards (which commands ran, the files
// on disk, the exit code). No runner's terms appear here: each adapter
// translates a workspace into its tool's own config.

/** One task of one project. */
export interface TaskSpec {
  /** A `sh` command, run in the project's directory. */
  command: string
  /** `^build`: build in every dependency first. `lint`: this project's lint. `lib#build`: one task. */
  dependsOn?: string[]
  /** Project-relative globs that key the task. Omitted: the tool's default. */
  inputs?: string[]
  /** Environment variables whose values key the task. */
  env?: string[]
  /** Project-relative globs the task writes, stored and restored with it. Omitted: the tool's default; `[]`: none. */
  outputs?: string[]
  /** Workspace-root-relative globs that also key the task, in any directory. */
  rootInputs?: string[]
  /** Workspace-root-relative globs the task also writes, stored and restored with it. */
  rootOutputs?: string[]
  /** Shell commands, run at the workspace root, whose output keys the task. */
  runtime?: string[]
  /** `false`: never replayed from a cache. Default `true`. */
  cache?: boolean
  /** The command reads the args a run forwards (`run`'s `args`) as `"$@"`. */
  takesArgs?: boolean
  /** Seconds the command may run before the tool kills it and fails it. */
  timeout?: number
  /** How many more times a failed attempt runs before the task fails. */
  retries?: number
  /**
   * A long-running process (a dev server): never cached, and stopped by the
   * tool once nothing needs it. `ready`: text the process prints once it is
   * up; until then nothing that depends on it starts.
   */
  persistent?: true | { ready: string }
}

export interface ProjectSpec {
  /** Directory under the workspace root, or `.`: the root package itself. Default `packages/<name>`. */
  dir?: string
  /** Names of the workspace projects this one depends on (package.json `dependencies`). */
  deps?: string[]
  tasks?: Record<string, TaskSpec>
  /** Files to create, relative to the project's directory. */
  files?: Record<string, string>
}

export interface WorkspaceSpec {
  projects: Record<string, ProjectSpec>
  /** Files to create, relative to the workspace root. */
  files?: Record<string, string>
  /** Tasks ordered by an edge may write into one output tree: a tool that refuses such a pair unless told is told. */
  sharedOutputs?: boolean
}

/** What a step's run must show. Every field is optional; each one given is checked. */
export interface Expect {
  /** `0`: the run succeeds. `'fail'`: it exits non-zero. */
  exit?: 0 | 'fail'
  /** These tasks (`project#task`) ran their command. */
  ran?: string[]
  /** These did not: replayed from a cache, or not part of the run. */
  notRan?: string[]
  /** Each pair `[a, b]`: `a`'s command finished before `b`'s started. */
  order?: [string, string][]
  /** Text the run's output (stdout and stderr) must hold, replayed or live. */
  output?: string[]
  /** Workspace-relative file → its exact content, or `null`: it does not exist. */
  files?: Record<string, string | null>
  /** Workspace-relative file → text it must not hold: a stale result, where more than one fresh one is right. */
  filesNot?: Record<string, string>
  /** When this task (`project#task`) did not run its command, these files hold exactly this. */
  ifReplayed?: { task: string; files: Record<string, string | null> }
  /** What the tool reports about this task's run, through its output, files or API. */
  report?: { task: string } & ReportCheck
  /** A run that fails before any task starts (a tool refusing the workspace) also passes. */
  orRefused?: boolean
  /** The run ends within this many seconds: it does not hang. */
  within?: number
  /** When the runner exits, no process it started (a task, what a task forked) is still alive. */
  alone?: true
}

/** A stop sent to a run in flight. */
export interface Stop {
  signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT'
  /** Workspace-relative file a task creates; the signal is sent once it exists (or after 30 s). */
  when: string
  /** The runner was started with this signal ignored, as `nohup` starts it. */
  ignored?: true
}

export interface TreeCheck {
  /** These files are executable. */
  executable?: string[]
  /** Each path is a symlink to this target. */
  links?: Record<string, string>
  /** These paths are directories. */
  dirs?: string[]
  /** Nothing stands at these paths, not even a dangling link. */
  missing?: string[]
  /** Each path's permission bits (`0o755`). */
  modes?: Record<string, number>
}

/** What a tool can report about one task's run. */
export interface TaskReport {
  /** Whether this run replayed the task from a cache. */
  cache?: 'hit' | 'miss'
  /** How long the task took in this run: its command on a miss, its restore on a hit. */
  durationMs?: number
  cpuMs?: number
  peakMemoryBytes?: number
  /** Bytes of the outputs the task wrote or restored. */
  outputBytes?: number
}

/** Each metric named must be reported: `cache` exactly, the rest within `[min, max]`. */
export type ReportCheck = {
  cache?: 'hit' | 'miss'
} & { [K in Exclude<keyof TaskReport, 'cache'>]?: [number, number] }

export type Step =
  /** Run `task` in every project that declares it, or only in `projects` (and what they depend on). */
  | {
      run: string
      /** More tasks the same run asks for beside `run`, each over the same projects. */
      also?: string[]
      projects?: string[]
      /** Variables set in the runner's environment for this run only; `$ROOT` in a value is the workspace's absolute path. */
      env?: Record<string, string>
      /** Args forwarded to the requested tasks' commands (a CLI's `-- <args>`). */
      args?: string[]
      /** Workspace-relative directory the runner is started from. Default the root. */
      cwd?: string
      /** Run `task` in the projects these select, in place of `projects`. */
      select?: Selector[]
      /** Run only the selected tasks: what they depend on is not run. */
      only?: true
      /** At most this many tasks at once. */
      concurrency?: number
      /** Stop the run as Ctrl-C or a supervisor does: `signal` to the runner's process group once `when` exists. */
      stop?: Stop
      expect: Expect
    }
  /** Write files (workspace-relative); `null` deletes. */
  | { write: Record<string, string | null> }
  /** Set file modes (workspace-relative). */
  | { chmod: Record<string, number> }
  /** Make each path a symlink to its target, replacing what was there. */
  | { link: Record<string, string> }
  /** Check the tree without running anything. */
  | { check: TreeCheck }
  /** Run the package manager's install again (offline), as a user does after editing a manifest. */
  | { install: true }
  /** Commit every change to git. */
  | { commit: string }
  /** A `sh` command the user runs in the workspace root (git plumbing, a nested repository, a file's times); it must succeed. */
  | { sh: string }
  /** Change the workspace's task definitions; the tool's config is written again. */
  | { configure: (ws: WorkspaceSpec) => WorkspaceSpec }
  /** Run `task` only where the changes since `base` reach. */
  | { affected: string; base: string; expect: Expect }

/**
 * Which projects a run selects, as a user names them. A run's selection is
 * the union of its includes minus its excludes; excludes alone take from
 * every project.
 */
export interface Selector {
  /** A project name, or a `*` glob over names. */
  name?: string
  /** A workspace-relative directory, or a glob over directories: the projects there. */
  dir?: string
  /** Also take the matched projects' dependencies, their dependents, or their dependents and all those depend on. */
  with?: 'dependencies' | 'dependents' | 'dependents-and-dependencies'
  /** `false`: leave the matched projects out, keeping only what `with` adds. */
  self?: false
  /** Take what this matches out of the selection. */
  exclude?: true
}

/**
 * `correctness`: a tool that fails it leaves a wrong tree or a wrong exit
 * code. `efficiency`: one that fails it reruns work nothing asked for.
 * `data`: what the tool reports about a run (time, CPU, memory, output
 * size): measurable, unlike how its log reads.
 */
export type Kind = 'correctness' | 'efficiency' | 'data'

export type Category =
  | 'graph'
  | 'inputs'
  | 'outputs'
  | 'env'
  | 'cache'
  | 'config'
  | 'affected'
  | 'report'
  | 'failure'

/** What a case needs from a tool beyond running tasks in order. A tool without it cannot express the case. */
export type Feature =
  | 'affected'
  | 'env-inputs'
  | 'uncached-task'
  | 'filter'
  /** A selector's `with`: a project's dependencies or dependents. */
  | 'select-walk'
  /** A selector's `dir`. */
  | 'select-dir'
  /** A `*` pattern over task names in dependsOn (`lint.*`). */
  | 'task-pattern'
  /** A per-task time limit. */
  | 'timeout'
  /** Re-running a failed task before failing it. */
  | 'retries'
  /** A long-running task the tool stops when the run ends. */
  | 'persistent'
  /** Holding a persistent task's dependants until it prints a ready line. */
  | 'ready'
  /** Inputs that are a command's output (`runtime`). */
  | 'runtime-inputs'
  /** More than one task named in one run (`also`). */
  | 'multi-task'

export interface Case {
  /** `category/slug`, unique. */
  id: string
  category: Category
  kind: Kind
  /** The behaviour, one sentence, in a user's words. */
  title: string
  /** Why this outcome is right, in 3–4 sentences: the page shows it collapsed under the case. */
  why: string
  /** The vx tests or issues this case was drawn from. */
  from: string[]
  needs?: Feature[]
  /** Plays of the case, each from a fresh tree, when its outcome hangs on the order a tool
   * picks for unordered tasks: a tool that loses even once fails. */
  races?: number
  workspace: WorkspaceSpec
  steps: Step[]
}

export function defineCase(c: Case): Case {
  return c
}

/** A project's directory, workspace-relative. */
export function projectDir(name: string, p: ProjectSpec): string {
  return p.dir ?? `packages/${name}`
}
