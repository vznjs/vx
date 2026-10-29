// The repository's own supply chain, held by law (supervisor backlog):
// every third-party action runs from a full commit SHA, never a tag a
// maintainer (or whoever takes their account) can move, and every npm
// package publishes with provenance. The binaries' attestations are
// release-provenance.unsafe.test.ts.
//
// `.unsafe`: `.github/` is outside any project a sandboxed task may read.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

function yamlFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...yamlFiles(p))
    else if (/\.ya?ml$/.test(name)) out.push(p)
  }
  return out
}

/** Every `uses:` ref that is neither local nor pinned to a 40-hex commit. */
function unpinned(text: string): string[] {
  const bad: string[] = []
  for (const m of text.matchAll(/^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/gm)) {
    const ref = m[1]!
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue
    if (!/@[0-9a-f]{40}$/.test(ref)) bad.push(ref)
  }
  return bad
}

/** Every SHA-pinned `uses:` ref whose line names no version (`# v1.2.3`). */
function unversioned(text: string): string[] {
  return [...text.matchAll(/^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+@[0-9a-f]{40})['"]?(.*)$/gm)]
    .filter((m) => !/^\s*#\s*v\d+(?:\.\d+){0,2}\s*$/.test(m[2]!))
    .map((m) => m[1]!)
}

/**
 * Every line of a `run:` script that expands a value an event or a
 * dispatcher supplies (`github.event.*`, `inputs.*`, `github.head_ref`):
 * GitHub pastes it into the script before the shell parses it, so a tag
 * or input holding `$(…)` runs (L-28). Such a value reaches a script
 * through `env:` and is quoted there.
 */
function injectable(text: string): string[] {
  const bad: string[] = []
  let runIndent = -1
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line)
    if (run !== null) {
      const rest = run[2]!.trim()
      runIndent = /^[|>]-?$/.test(rest) ? run[1]!.length : -1
      if (runIndent < 0 && TAINTED.test(rest)) bad.push(rest)
      continue
    }
    if (runIndent < 0 || line.trim() === '') continue
    if (indent <= runIndent) {
      runIndent = -1
      continue
    }
    if (TAINTED.test(line)) bad.push(line.trim())
  }
  return bad
}
const TAINTED = /\$\{\{[^}]*\b(?:github\.event\.|inputs\.|github\.head_ref)/

// Sorted: readdir order differs by filesystem, and the CI runner's put
// release.yml before auto-release.yml.
const files = yamlFiles(path.join(ROOT, '.github')).sort()
const rel = (p: string) => path.relative(ROOT, p)

interface Step {
  uses?: string
  with?: Record<string, unknown>
}
interface Job {
  permissions?: Record<string, string>
  'timeout-minutes'?: number
  steps?: Step[]
}
interface Workflow {
  permissions?: Record<string, string>
  concurrency?: { group?: string; 'cancel-in-progress'?: unknown }
  jobs: Record<string, Job>
}
const workflows = files
  .filter((f) => f.includes(`${path.sep}workflows${path.sep}`))
  .map((f) => ({ file: rel(f), doc: Bun.YAML.parse(readFileSync(f, 'utf8')) as Workflow }))
/** Every step of every workflow that runs `action`, as `file#job`. */
const stepsOf = (action: string) =>
  workflows.flatMap(({ file, doc }) =>
    Object.entries(doc.jobs).flatMap(([id, job]) =>
      (job.steps ?? [])
        .filter((s) => s.uses?.split('@')[0] === action)
        .map((step) => ({ at: `${path.basename(file)}#${id}`, step })),
    ),
  )

describe('the supply chain', () => {
  it('runs every third-party action from a full commit SHA', () => {
    const refs = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/gm)].map(
        (m) => m[1]!,
      ),
    )
    // The positive: the walk found third-party actions to judge.
    expect(refs.filter((r) => !r.startsWith('./')).length).toBeGreaterThan(5)
    expect(
      files.flatMap((f) => unpinned(readFileSync(f, 'utf8')).map((r) => `${rel(f)}: ${r}`)),
    ).toEqual([])
  })

  // A bare SHA says nothing a reviewer or an updater can check: each pin
  // names the release it is, as `# v7.0.1`.
  it('names the version of every pinned action beside its SHA', () => {
    expect(
      files.flatMap((f) => unversioned(readFileSync(f, 'utf8')).map((r) => `${rel(f)}: ${r}`)),
    ).toEqual([])
  })

  it('finds a pin with no version comment (the checker itself)', () => {
    expect(
      unversioned(
        [
          '      - uses: owner/a@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2',
          '        uses: owner/b@4d101475d8b20a2381f78447822ac1eab6504dd8',
          '      - uses: owner/c@4d101475d8b20a2381f78447822ac1eab6504dd8 # pinned',
          '      - uses: ./.github/actions/vx-runner',
        ].join('\n'),
      ),
    ).toEqual([
      'owner/b@4d101475d8b20a2381f78447822ac1eab6504dd8',
      'owner/c@4d101475d8b20a2381f78447822ac1eab6504dd8',
    ])
  })

  // A hung job holds its runner for GitHub's six hours, and a DTE run's
  // workers queue behind it.
  it('bounds every job with timeout-minutes', () => {
    const jobs = workflows.flatMap(({ file, doc }) =>
      Object.entries(doc.jobs).map(([id, job]) => [`${path.basename(file)}#${id}`, job] as const),
    )
    expect(jobs.length).toBeGreaterThan(5)
    expect(
      jobs.filter(([, job]) => typeof job['timeout-minutes'] !== 'number').map(([at]) => at),
    ).toEqual([])
  })

  it('refuses a tag, a branch or a short SHA (the checker itself)', () => {
    expect(
      unpinned(
        [
          '      - uses: actions/checkout@v4',
          '        uses: "owner/action@main"',
          '      - uses: owner/action@abc1234',
          '      - uses: owner/action@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2',
          '      - uses: ./.github/actions/vx-runner',
        ].join('\n'),
      ),
    ).toEqual(['actions/checkout@v4', 'owner/action@main', 'owner/action@abc1234'])
  })

  it('passes an event or input value to a script through env, never pasted in', () => {
    expect(
      files.flatMap((f) => injectable(readFileSync(f, 'utf8')).map((l) => `${rel(f)}: ${l}`)),
    ).toEqual([])
  })

  it('finds a pasted value in a block or a one-line script, not in env (the checker itself)', () => {
    expect(
      injectable(
        [
          '      - run: echo "${{ github.event.pull_request.title }}"',
          '      - name: x',
          '        env:',
          '          RAW: ${{ github.event.inputs.version || github.event.release.tag_name }}',
          '        run: |',
          '          set -e',
          '          V="${{ inputs.tag }}"',
          '          echo "$RAW ${{ steps.version.outputs.version }}"',
          '      - uses: owner/action@4d101475d8b20a2381f78447822ac1eab6504dd8',
          '        with:',
          '          ref: ${{ github.event.inputs.ref }}',
        ].join('\n'),
      ),
    ).toEqual(['echo "${{ github.event.pull_request.title }}"', 'V="${{ inputs.tag }}"'])
  })

  // A workflow without a top-level `permissions:` runs on the repository's
  // default token, which may write, and CI runs a PR's code (L-29).
  it('declares the token permissions of every workflow', () => {
    const workflows = files.filter((f) => f.includes(`${path.sep}workflows${path.sep}`))
    expect(workflows.length).toBeGreaterThan(3)
    expect(
      workflows.filter((f) => !/^permissions:/m.test(readFileSync(f, 'utf8'))).map(rel),
    ).toEqual([])
  })

  // A write the workflow grants reaches every job, one added later
  // included; each job names the writes it needs, as npm.yml and
  // auto-release.yml do. An OIDC token writes nothing of the repo's.
  it('grants a write to a job, never to the whole workflow', () => {
    expect(
      workflows.flatMap(({ file, doc }) =>
        Object.entries(doc.permissions ?? {})
          .filter(([scope, level]) => level === 'write' && scope !== 'id-token')
          .map(([scope]) => `${path.basename(file)}: ${scope}`),
      ),
    ).toEqual([])
  })

  // actions/checkout writes the job's token into .git/config unless told
  // not to, where every later step and every unsandboxed task reads it:
  // ci.yml's run holds contents, actions and pages write. Nothing here
  // pushes with git (tags and releases go through the API with GH_TOKEN)
  // and the repo is public, so a fetch needs no credential.
  it('leaves the job token out of every checkout', () => {
    const checkouts = stepsOf('actions/checkout')
    expect(checkouts.length).toBeGreaterThan(5)
    expect(
      checkouts
        .filter(({ step }) => step.with?.['persist-credentials'] !== false)
        .map(({ at }) => at),
    ).toEqual([])
  })

  // A second dispatch of a release workflow while the first runs races
  // it: release.yml had no group, so two runs of one tag would upload to
  // the same draft and either could publish it first. Each queues behind the one running,
  // never cancelling it halfway through a publish.
  it('runs each release workflow one at a time, never cancelled', () => {
    expect(
      workflows
        .filter(({ file }) => /(?:^|\/)(?:release|npm|auto-release)\.yml$/.test(file))
        .map(({ file, doc }) => [
          path.basename(file),
          doc.concurrency?.group,
          doc.concurrency?.['cancel-in-progress'],
        ]),
    ).toEqual([
      ['auto-release.yml', 'auto-release', false],
      ['npm.yml', 'npm-publish', false],
      ['release.yml', 'release-assets-${{ inputs.tag }}', false],
    ])
  })

  // package.json's `packageManager` is the one Bun version: setup-bun reads
  // it when no step names one. Five steps named 1.4.4 and three read the
  // file, so a bump of the file moved the release builds and left CI's
  // run and workers on the old Bun.
  it('installs the Bun package.json names, and no step names another', () => {
    const setups = stepsOf('oven-sh/setup-bun')
    expect(setups.length).toBeGreaterThan(5)
    expect(
      setups.filter(({ step }) => step.with?.['bun-version'] !== undefined).map(({ at }) => at),
    ).toEqual([])
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      packageManager?: string
    }
    expect(pkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/)
  })

  // The publish is scripts/release.ts's (`release.publish.<os>`); a workflow
  // publishes nothing itself (workflow-runner.unsafe.test.ts).
  it('publishes every npm package with provenance', () => {
    const script = readFileSync(path.join(ROOT, 'packages', 'vx', 'scripts', 'release.ts'), 'utf8')
    const publishes = [...script.matchAll(/\[npm, 'publish'[^\]]*\]/g)].map((m) => m[0])
    expect(publishes.length).toBeGreaterThan(0)
    expect(publishes.filter((p) => !p.includes("'--provenance'"))).toEqual([])
  })
})
