import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { applyFilters, parseFilter } from '../src/workspace/filter.js'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import type { ProjectMeta } from '../src/workspace/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

// A directory name holding glob metacharacters is still a literal directory
// to the key and the cache: git's pathspec match tries the literal path
// first, and outputs are scanned from inside the project dir, so `[abc]` is
// never read as a character class that also matches the sibling
// `packages/a`. The path FILTER keeps `Bun.Glob`'s alphabet, but a path that
// names a project directory is that directory first (item 664), so
// `./packages/[abc]` selects it; only a bracket path naming no directory is
// read as a glob. (A bracket INSIDE a task glob is literal: item 667.)
const bracketProjects = (root: string): ProjectMeta[] => [
  { name: 'a', dir: path.join(root, 'packages', 'a'), configPath: null },
  { name: 'br', dir: path.join(root, 'packages', '[abc]'), configPath: null },
]

describe('a project directory named packages/[abc]', () => {
  let root: string
  const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-ws-brackets-' })
    const dir = await addProject(root, 'br', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'cat src/in.txt > out.txt' },
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
            },
          },
        }
      `,
      files: { 'src/in.txt': 'v1' },
    })
    await rename(dir, path.join(root, 'packages', '[abc]'))
    await addProject(root, 'a', { files: { 'src/in.txt': 'a1' } })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('its inputs key the task, its outputs restore, and a sibling matching the class changes nothing', async () => {
    const out = path.join(root, 'packages', '[abc]', 'out.txt')
    const statuses = async (): Promise<string[]> =>
      (await run({ cwd: root, tasks: ['build'], projects: ['br'], log: quiet })).outcomes.map(
        (o) => `${o.node.id} ${o.status}`,
      )

    expect(await statuses()).toEqual(['br#build success'])
    await rm(out)
    expect(await statuses()).toEqual(['br#build cache-hit'])
    expect(await readFile(out, 'utf8')).toBe('v1')

    await writeFile(path.join(root, 'packages', 'a', 'src', 'in.txt'), 'a2')
    expect(await statuses()).toEqual(['br#build cache-hit'])

    await writeFile(path.join(root, 'packages', '[abc]', 'src', 'in.txt'), 'v2')
    expect(await statuses()).toEqual(['br#build success'])
    expect(await readFile(out, 'utf8')).toBe('v2')
  }, 30_000)

  it('a path filter with the brackets escaped selects it, and only it', async () => {
    const projects = bracketProjects(root)
    const graph = buildPackageGraph(projects)
    const select = (f: string): string[] =>
      [...applyFilters({ filters: [parseFilter(f, root)], projects, graph })].sort()
    expect(select('./packages/\\[abc\\]')).toEqual(['br'])
    expect(select('./packages')).toEqual(['a', 'br'])
  })

  // A path that names a project directory literally is that directory, as
  // git reads a pathspec (item 664; before it the form compiled as a glob and
  // selected the sibling the class matches).
  it('the unescaped `./packages/[abc]` selects the directory it names, not the sibling `a`', async () => {
    const projects = bracketProjects(root)
    const graph = buildPackageGraph(projects)
    const select = (f: string): string[] =>
      [...applyFilters({ filters: [parseFilter(f, root)], projects, graph })].sort()
    expect(select('./packages/[abc]')).toEqual(['br'])
    expect(select('{packages/[abc]}')).toEqual(['br'])
    // CONTROL: a bracket path that names no directory is still a glob.
    expect(select('./packages/[ab]')).toEqual(['a'])
  })
})
