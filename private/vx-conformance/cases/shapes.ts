// Workspaces many cases share. Commands are plain POSIX sh, so every tool
// runs the same bytes.
import type { ProjectSpec, TaskSpec, WorkspaceSpec } from '../src/spec.ts'

/** Concatenates the project's src/*.txt (sorted) into dist/out.txt. */
export const CONCAT = 'mkdir -p dist && cat src/*.txt > dist/out.txt'

/** The build every project in a chain runs: its dependencies' dist/out.txt, then its own sources. */
export function chainBuild(deps: string[]): TaskSpec {
  const upstream = deps.map((d) => `../${d}/dist/out.txt`).join(' ')
  return {
    command: `mkdir -p dist && cat ${upstream} src/*.txt > dist/out.txt`,
    dependsOn: ['^build'],
    inputs: ['src/**'],
    outputs: ['dist/**'],
  }
}

/** A project whose build is {@link chainBuild} over `deps`, with one source file. */
export function chainProject(
  name: string,
  deps: string[] = [],
  extra: Partial<ProjectSpec> = {},
): ProjectSpec {
  return {
    deps,
    tasks: { build: chainBuild(deps), ...extra.tasks },
    files: { 'src/a.txt': `${name}\n`, ...extra.files },
    ...(extra.dir ? { dir: extra.dir } : {}),
  }
}

/** lib ← ui ← app, and docs on its own: the shape most graph cases ask about. */
export function fourProjects(): WorkspaceSpec {
  return {
    projects: {
      lib: chainProject('lib'),
      ui: chainProject('ui', ['lib']),
      app: chainProject('app', ['lib', 'ui']),
      docs: chainProject('docs'),
    },
  }
}

/** One project `a` with one cached task `build`. */
export function one(
  task: TaskSpec,
  files: Record<string, string> = { 'src/a.txt': 'a\n' },
): WorkspaceSpec {
  return { projects: { a: { tasks: { build: task }, files } } }
}

export const out = (p: string) => `packages/${p}/dist/out.txt`
