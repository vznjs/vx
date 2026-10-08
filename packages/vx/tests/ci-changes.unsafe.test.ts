// ci.yml's `changes` job decides whether a pull request needs the `plugin
// packages` job (the live REAPI and nx-exec suites). A wrong "no" skips a
// suite the diff could break under a green required check, so the rows run
// the job's own script against a real merge commit, shaped like the
// `refs/pull/<n>/merge` a PR run checks out (parents: base, head).
//
// `.unsafe`: the workflow lives at the repo root, which a sandboxed project
// task may not read, and the script asks git, which a sandboxed shard lacks.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const workflow = path.resolve(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'ci.yml')

interface Step {
  id?: string
  run?: string
  shell?: string
}
interface Job {
  if?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  steps?: Step[]
}
const doc = Bun.YAML.parse(readFileSync(workflow, 'utf8')) as {
  on?: Record<string, unknown>
  true?: Record<string, unknown>
  concurrency?: Record<string, string>
  jobs: Record<string, Job>
}
const changes = doc.jobs['changes']
const diff = changes?.steps?.find((s) => s.id === 'diff')

const scratch = mkdtempSync(path.join(os.tmpdir(), 'vx-ci-changes-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: scratch,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: GIT_ENV, stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

let n = 0
// A repo whose HEAD merges a PR branch into a base that moved on since, as
// GitHub's merge ref does; `change` edits the PR branch's tree.
function mergeRef(change: (root: string) => void): string {
  const root = path.join(scratch, `r${n++}`)
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  for (const f of ['README.md', 'bun.lock', 'packages/vx/src/a.ts', 'packages/vx/docs/a.md']) {
    write(root, f, `${f}\n`)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  git(root, 'checkout', '-q', '-b', 'pr')
  change(root)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'pr')
  git(root, 'checkout', '-q', 'main')
  write(root, 'packages/vx-reapi/src/main.ts', 'main moved\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'main moved')
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr')
  return root
}

// The step as the runner runs it: `shell: bash` is `bash -eo pipefail`.
function run(cwd: string): { code: number; stderr: string; out: string } {
  const out = path.join(scratch, `out${n++}`)
  writeFileSync(out, '')
  const r = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', diff!.run!], {
    cwd,
    env: { ...GIT_ENV, GITHUB_OUTPUT: out },
    stderr: 'pipe',
  })
  return { code: r.exitCode, stderr: r.stderr.toString(), out: readFileSync(out, 'utf8') }
}

function outputs(change: (root: string) => void): string {
  const r = run(mergeRef(change))
  expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' })
  return r.out
}

describe('the changes job', () => {
  it('runs on a pull request alone, as one bash step', () => {
    expect(changes?.if).toBe("github.event_name == 'pull_request'")
    expect(diff?.shell).toBe('bash')
    expect(changes?.outputs).toEqual({
      packages: '${{ steps.diff.outputs.packages }}',
      darwin: '${{ steps.diff.outputs.darwin }}',
    })
  })

  it("skips the plugin suites for a diff they cannot read: core's tests and docs, the site, prose", () => {
    expect(
      outputs((root) => {
        write(root, 'packages/vx/tests/x.test.ts', 'x\n')
        write(root, 'packages/vx/docs/a.md', 'changed\n')
        write(root, 'packages/vx-docs/src/content/docs/a.md', 'x\n')
        write(root, 'packages/vx-bench/run.ts', 'x\n')
        write(root, 'packages/vx-plugin-examples/plugins/x.ts', 'x\n')
        write(root, 'packages/vx-otel/tests/x.test.ts', 'x\n')
        write(root, 'README.md', 'changed\n')
        write(root, 'CLAUDE.md', 'x\n')
        write(root, '.claude/skills/x/SKILL.md', 'x\n')
      }),
    ).toBe('packages=false\ndarwin=true\n')
  })

  it('skips the macOS job for a diff confined to the site, the bench and prose', () => {
    expect(
      outputs((root) => {
        write(root, 'packages/vx-docs/src/content/docs/a.md', 'x\n')
        write(root, 'packages/vx-bench/run.ts', 'x\n')
        write(root, 'README.md', 'changed\n')
        write(root, 'CLAUDE.md', 'x\n')
        write(root, 'CONTRIBUTING.md', 'x\n')
        write(root, 'SECURITY.md', 'x\n')
        write(root, '.claude/skills/x/SKILL.md', 'x\n')
      }),
    ).toBe('packages=false\ndarwin=false\n')
  })

  // Core and the plugins are where macOS diverges; one such path beside a
  // site edit runs the job.
  it.each([
    'packages/vx/src/a.ts',
    'packages/vx/tests/x.test.ts',
    'packages/vx/docs/a.md',
    'packages/vx/README.md',
    'packages/vx-otel/tests/x.test.ts',
    'packages/vx-plugin-examples/plugins/x.ts',
    'packages/vx-docs/vx.config.ts',
    'packages/vx-docs/package.json',
    'packages/vx-bench/vx.config.ts',
    'packages/vx-bench/package.json',
    'LICENSE',
    'bun.lock',
    'package.json',
    'vx.workspace.ts',
    '.github/workflows/ci.yml',
    'examples/basic/README.md',
    'scripts/x.ts',
  ])('runs the macOS job for %s', (file) => {
    expect(
      outputs((root) => {
        write(root, 'packages/vx-docs/b.md', 'x\n')
        write(root, file, 'changed\n')
      }),
    ).toMatch(/^darwin=true$/m)
  })

  // One path the plugin suites can reach turns the job on, whatever else
  // the diff holds beside it.
  it.each([
    'packages/vx/src/a.ts',
    'packages/vx/index.ts',
    'packages/vx/scripts/x.ts',
    'packages/vx/README.md',
    'packages/vx-reapi/README.md',
    'packages/vx-migrate/tests/x.test.ts',
    'packages/vx-otel/src/index.ts',
    'packages/vx-docs/vx.config.ts',
    'packages/vx-docs/package.json',
    'packages/vx-bench/vx.config.ts',
    'bun.lock',
    'package.json',
    'tsconfig.json',
    'vx.workspace.ts',
    '.gitignore',
    '.github/workflows/ci.yml',
    'examples/basic/README.md',
    'scripts/x.ts',
  ])('runs the plugin suites for %s', (file) => {
    expect(
      outputs((root) => {
        write(root, 'packages/vx/docs/b.md', 'x\n')
        write(root, file, 'changed\n')
      }),
    ).toMatch(/^packages=true$/m)
  })

  it('sees the path a move leaves, not only the one it lands on', () => {
    expect(
      outputs((root) => git(root, 'mv', 'packages/vx/src/a.ts', 'packages/vx/docs/a.ts')),
    ).toBe('packages=true\ndarwin=true\n')
  })

  it('runs everything when the merge changes nothing', () => {
    expect(outputs(() => {})).toBe('packages=true\ndarwin=true\n')
  })

  it('fails, and so runs everything, when git cannot answer', () => {
    const empty = path.join(scratch, 'no-git')
    mkdirSync(empty)
    const r = run(empty)
    expect(r.code).not.toBe(0)
    expect(r.out).toBe('')
  })
})

// A required check skipped by a workflow-level `paths` filter stays pending
// for ever; one skipped by a job-level `if` reports success. A failed or
// skipped `changes` (a push, a dispatch) must run the job, never skip it.
describe('the gating', () => {
  it('filters no trigger by path', () => {
    expect(JSON.stringify(doc.on ?? doc.true)).not.toMatch(/paths/)
  })

  it('gates the plugin and macOS jobs on changes, and runs each unless it said no', () => {
    const gated = Object.entries(doc.jobs)
      .filter(([name, j]) => name !== 'changes' && (j.if !== undefined || j.needs !== undefined))
      .map(([name, j]) => [name, j.needs, j.if])
    expect(gated).toEqual([
      [
        'packages',
        'changes',
        "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.packages == 'true') }}",
      ],
      ['binary-linux-arm64', undefined, "github.event_name != 'pull_request'"],
      [
        'core-darwin',
        'changes',
        "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.darwin == 'true') }}",
      ],
    ])
  })

  it('cancels a superseded run on a pull request only', () => {
    expect(doc.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    })
  })
})
