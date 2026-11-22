// Which directories are projects: only what the workspace's globs list.
// Drawn from Turborepo's package discovery tests
// (crates/turborepo-repository/src/discovery.rs) and Nx's workspace
// e2e (e2e/nx/src/workspace.test.ts).
import { defineCase, type Case, type WorkspaceSpec } from '../src/spec.ts'

const BUILD = {
  command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
  inputs: ['src/**'],
  outputs: ['dist/**'],
}

/** Project `a`, plus `files` at the root that the workspace's globs do not list as projects. */
function notAProject(
  slug: string,
  title: string,
  why: string,
  files: Record<string, string>,
): Case {
  const workspace: WorkspaceSpec = {
    projects: { a: { tasks: { build: BUILD }, files: { 'src/a.txt': 'a\n' } } },
    files,
  }
  return defineCase({
    id: `graph/${slug}`,
    category: 'graph',
    kind: 'correctness',
    title,
    why,
    from: ['discovery-refusals', 'package-json-bom'],
    workspace,
    steps: [
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/dist/out.txt': 'a\n' } },
      },
    ],
  })
}

const SAME_NAME = '{ "name": "a", "version": "0.0.0" }\n'

export default [
  notAProject(
    'workspace-dir-without-manifest-skipped',
    'A directory the workspace globs match that has no package.json is not a project',
    'Workspaces hold folders that are not packages: notes, fixtures, a package half deleted. Without a manifest there is no project to build. A tool that fails on such a folder blocks every run until someone deletes it; the run builds the real projects.',
    { 'packages/notes/readme.md': 'not a package\n' },
  ),
  notAProject(
    'manifest-inside-a-project-not-a-project',
    'A package.json nested inside a project, outside the workspace globs, is not a second project',
    'Projects carry nested manifests: test fixtures, examples, a vendored package. Only the workspace globs say which directories are projects. A tool that finds every package.json reads the fixture, named like the project here, as a duplicate and fails a run that has one project.',
    { 'packages/a/fixtures/x/package.json': SAME_NAME },
  ),
  notAProject(
    'manifest-outside-workspace-globs-not-a-project',
    'A package.json in a root folder the workspace globs do not list is not a project',
    'A docs site or a scripts folder can hold its own package.json without being part of the workspace. The globs leave it out on purpose. A tool that picks it up anyway sees two projects named alike and fails, or runs tasks nobody declared.',
    { 'docs/package.json': SAME_NAME },
  ),
]
