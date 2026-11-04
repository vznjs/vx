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
  /** `false`: never replayed from a cache. Default `true`. */
  cache?: boolean
}

export interface ProjectSpec {
  /** Directory under the workspace root. Default `packages/<name>`. */
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
}

export type Step =
  /** Run `task` in every project that declares it, or only in `projects` (and what they depend on). */
  | {
      run: string
      projects?: string[]
      /** Variables set in the runner's environment for this run only. */
      env?: Record<string, string>
      expect: Expect
    }
  /** Write files (workspace-relative); `null` deletes. */
  | { write: Record<string, string | null> }
  /** Set file modes (workspace-relative). */
  | { chmod: Record<string, number> }
  /** Make each path a symlink to its target, replacing what was there. */
  | { link: Record<string, string> }
  /** Check the tree without running anything: executable files, symlinks and their targets. */
  | { check: { executable?: string[]; links?: Record<string, string> } }
  /** Commit every change to git. */
  | { commit: string }
  /** Change the workspace's task definitions; the tool's config is written again. */
  | { configure: (ws: WorkspaceSpec) => WorkspaceSpec }
  /** Run `task` only where the changes since `base` reach. */
  | { affected: string; base: string; expect: Expect }

/**
 * `correctness`: a tool that fails it leaves a wrong tree or a wrong exit
 * code. `efficiency`: one that fails it reruns work nothing asked for.
 * `output`: what the run prints; never correctness.
 */
export type Kind = 'correctness' | 'efficiency' | 'output'

export type Category =
  | 'graph'
  | 'inputs'
  | 'outputs'
  | 'env'
  | 'cache'
  | 'config'
  | 'affected'
  | 'logs'
  | 'failure'

/** What a case needs from a tool beyond running tasks in order. A tool without it cannot express the case. */
export type Feature = 'affected' | 'env-inputs' | 'uncached-task' | 'filter'

export interface Case {
  /** `category/slug`, unique. */
  id: string
  category: Category
  kind: Kind
  /** The behaviour, one sentence, in a user's words. */
  title: string
  /** Why this is the correct outcome, when a tool could argue for another. */
  why?: string
  /** The vx tests or issues this case was drawn from. */
  from: string[]
  needs?: Feature[]
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
