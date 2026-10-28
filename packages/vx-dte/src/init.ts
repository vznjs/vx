// `vx dte init`: the whole CI of a DTE run, written from
// `dte()` itself: the run's job and its workers', never copied by hand.
// Each adapter writes its own (`DteAdapter.init`); one that starts workers
// on this machine (`local()`, `docker()`) needs none.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { UserError, type Platform } from '@vzn/vx'
import type { GithubOptions } from './github.js'
import type { GitlabOptions } from './gitlab.js'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

/** What `vx dte init` hands an adapter that writes CI files. */
export interface DteSetup {
  readonly workspaceRoot: string
  /** The workspace's directory in its repository, '' at its root: where the CI's commands run. */
  readonly dir: string
  /** The relay `dte()` names, if any. */
  readonly relay?: string
  /** `dte()`'s sizes in declared order, with the platform each names. */
  readonly sizes: readonly {
    readonly name: string
    /** Absent: as many as the work needs. */
    readonly max?: number
    readonly platform?: Platform
  }[]
  /** The workspace's package manager, by its lockfile. */
  readonly manager: PackageManager
  /** The tasks a push to the default branch runs (with `--all`) and a change request runs (with `--affected`), space separated; '' is none named yet, so the run fails until they are. */
  readonly tasks: { readonly main: string; readonly change: string }
  /** `owner/repo` (a GitLab project's full path) of the `origin` remote, if it has one. */
  readonly repository?: string
  /** The `origin` remote's host: a self-managed GitLab issues its tokens as itself. */
  readonly host?: string
}

/** What an adapter's `init` gives back: files to write (workspace-relative path to text), then lines to print. */
export interface DteInit {
  readonly files: Readonly<Record<string, string>>
  readonly next: readonly string[]
}

/** `owner/repo` of the `origin` remote and its host: what the relay's ALLOW names. */
export function originOf(root: string): { repository?: string; host?: string } {
  const r = Bun.spawnSync(['git', 'config', '--get', 'remote.origin.url'], { cwd: root })
  const url = r.exitCode === 0 ? r.stdout.toString().trim() : ''
  const m = /[:/]([^:]+?\/[^/]+?)(?:\.git)?\/?$/.exec(url.replace(/^[a-z+]+:\/\/[^/]+\//, '/'))
  // An https URL's port is its issuer's; an ssh one's is not.
  const host =
    /^https?:\/\/(?:[^@/]*@)?([^/]+)/.exec(url)?.[1] ??
    /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/.exec(url)?.[1] ??
    /^(?:[^@/:]*@)?([^/:]+):/.exec(url)?.[1]
  return {
    ...(m?.[1] === undefined ? {} : { repository: m[1] }),
    ...(host === undefined ? {} : { host }),
  }
}

const SITE = 'https://vznjs.github.io/vx/docs'
const RELAY_DOCS = 'https://vznjs.github.io/vx/docs/relay/'

/** What is left after the files: a relay that admits them, a shared cache, a commit. */
function nextSteps(relay: string | undefined, allow: string, files: readonly string[]): string[] {
  return [
    '',
    'Next:',
    relay === undefined
      ? `  1. A relay, where the run and its workers meet. Deploy your own on Cloudflare's free plan (the Deploy button) or run it with Bun or Docker: ${RELAY_DOCS}`
      : `  1. The relay at ${relay} must admit these workflows.`,
    `     Its ALLOW (a plain var, no secret): ${allow}`,
    ...(relay === undefined
      ? ["     Then name it in .vx/workspace.ts: dte({ relay: 'https://<your relay>' })"]
      : []),
    `  2. A remote cache the run and the workers share: workers hand back outputs only through it. ${SITE}/remote-cache/`,
    `  3. Commit ${files.join(', ')}, .vx/workspace.ts and the lock (vx lock), and push.`,
    `  How a run spreads over workers: ${SITE}/distributed-task-execution/`,
  ]
}

const TASKS = /^[\w@/#.:*-]+( [\w@/#.:*-]+)*$/

/**
 * Asks, in a terminal, what main runs and what a change request runs (main's
 * by default). Elsewhere none are named, and the written run fails until
 * its owner names them.
 */
export function askTasks(): { main: string; change: string } {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return { main: '', change: '' }
  const ask = (q: string, fallback: string): string => {
    const a = (prompt(q) ?? '').trim().replace(/\s+/g, ' ') || fallback
    if (a !== '' && !TASKS.test(a))
      throw new UserError(`vx dte init: ${JSON.stringify(a)} is not a list of task names`)
    return a
  }
  const main = ask('Tasks to run on main (such as build test):', '')
  const change = ask(
    `Tasks to run on a pull or merge request${main === '' ? '' : ` [${main}]`}:`,
    main,
  )
  return { main, change }
}

export function managerOf(root: string): PackageManager {
  const has = (f: string): boolean => existsSync(path.join(root, f))
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('bun.lock') || has('bun.lockb')) return 'bun'
  if (has('yarn.lock')) return 'yarn'
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm'
  throw new UserError(
    'vx dte init: no lockfile at the workspace root (bun.lock, pnpm-lock.yaml, yarn.lock, package-lock.json): workers install from it',
  )
}

/** The frozen install a fresh runner does, as shell lines. */
function installLines(manager: PackageManager): readonly string[] {
  if (manager === 'bun') return ['bun install --frozen-lockfile']
  if (manager === 'pnpm') return ['pnpm install --frozen-lockfile']
  if (manager === 'yarn') return ['corepack enable', 'yarn install --immutable']
  return ['npm ci']
}

/** How a runner calls the workspace's own vx: Yarn's PnP has no `node_modules/.bin`. */
function vxCommand(manager: PackageManager): string {
  return manager === 'yarn' ? 'yarn vx' : 'bun vx'
}

/**
 * Writes what `init` returned. A file that exists with other bytes is kept
 * (a step its owner added, such as a cache restore) unless `force`.
 */
export async function writeInit(
  root: string,
  init: DteInit,
  force: boolean,
  out: (line: string) => void,
): Promise<number> {
  const kept: string[] = []
  for (const [rel, text] of Object.entries(init.files)) {
    const at = path.join(root, rel)
    // quiet: a file that cannot be read is one to write
    const had = await readFile(at, 'utf8').catch(() => undefined)
    if (had === text) {
      out(`vx dte init: ${rel} is up to date`)
      continue
    }
    if (had !== undefined && !force) {
      kept.push(rel)
      continue
    }
    await mkdir(path.dirname(at), { recursive: true })
    await writeFile(at, text)
    out(`vx dte init: wrote ${rel}`)
  }
  if (kept.length > 0) {
    throw new UserError(
      `vx dte init: ${kept.join(', ')} already exists with other contents: compare it with vx dte init --dry, or overwrite it with --force`,
    )
  }
  for (const line of init.next) out(line)
  return 0
}

// Each action at a commit, never a tag its maintainer (or whoever takes
// their account) can move; the comment is the release, for an updater.
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1'
const SETUP_BUN = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0'
const SETUP_PNPM = 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0'

/** GitHub's hosted runner of each platform; a size naming none runs on Linux x64. */
const RUNNERS: Record<Platform, string> = {
  'linux-x64': 'ubuntu-latest',
  'linux-arm64': 'ubuntu-24.04-arm',
  'darwin-x64': 'macos-15-intel',
  'darwin-arm64': 'macos-latest',
}

/** The workers' workflow: what `dispatch` sends, as `vx dte worker` reads it. */
export function githubInit(options: GithubOptions, setup: DteSetup): DteInit {
  const workflow = options.workflow ?? 'vx-worker.yml'
  const runners = Object.fromEntries(
    setup.sizes.map((s) => [
      s.name,
      options.runsOn?.[s.name] ?? RUNNERS[s.platform ?? 'linux-x64'],
    ]),
  )
  // A workspace in a subdirectory: CI files live at the repository's root,
  // and their commands run in the workspace.
  const inDir =
    setup.dir === '' ? '' : `    defaults:\n      run:\n        working-directory: ${setup.dir}\n`
  const install = [
    ...(setup.manager === 'pnpm'
      ? [pnpmAction(setup.dir)]
      : [
          '      # Every project: only pnpm selects by a git diff, as',
          '      # `pnpm install --frozen-lockfile --filter "...[origin/main]"`',
          '      # (fetch origin/main first: the checkout is one commit).',
        ]),
    ...installLines(setup.manager).map((l) => `      - run: ${l}`),
  ]
  const text = `# Written by vx dte init from dte() in .vx/workspace.ts: the workers of a
# DTE run, which github() dispatches once per size. Run vx dte init
# again after changing the sizes.
name: vx-worker

on:
  workflow_dispatch:
    inputs:
      run: { required: true }
      relay: { required: true }
      sha: { required: true }
      size: { required: true }
      workers: { required: true }
      # The variables github({ env }) hands the workers, as a JSON object.
      env: { required: false, default: '{}' }

permissions:
  contents: read
  id-token: write

jobs:
  worker:
    # The run reads a job that failed before its worker joined by this name.
    name: \${{ matrix.worker }}
    runs-on: \${{ fromJSON('${JSON.stringify(runners)}')[inputs.size] }}
    timeout-minutes: 30
${inDir}    strategy:
      fail-fast: false
      matrix:
        worker: \${{ fromJSON(inputs.workers) }}
    env:
      VX_DTE_RUN: \${{ inputs.run }}
      VX_DTE_RELAY: \${{ inputs.relay }}
      VX_DTE_WORKER: \${{ matrix.worker }}
    steps:
      - uses: ${CHECKOUT}
        with: { ref: '\${{ inputs.sha }}', persist-credentials: false }
      - env: { HANDED: '\${{ inputs.env }}' }
        run: |
          jq -r 'to_entries[] | if (.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) and (.value | type == "string") and (.value | test("[\\r\\n]") | not) then "\\(.key)=\\(.value)" else error("env \\(.key): a name, and a string of one line") end' <<<"$HANDED" >> "$GITHUB_ENV"
      - uses: ${SETUP_BUN}
${install.join('\n')}
      - run: ${vxCommand(setup.manager)} dte worker
`
  const vx = vxCommand(setup.manager)
  const named = setup.tasks.main !== '' && setup.tasks.change !== ''
  const run = `# Written by vx dte init: the run. main runs every task and fills the cache;
# a pull request runs what it changed and its dependents. This job only
# orchestrates: every task runs on a worker (${workflow}).
name: ci

on:
  pull_request:
  push:
    branches: [main]

# A newer push to a pull request cancels its older run, and its workers.
concurrency:
  group: ci-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
  vx:
    runs-on: ubuntu-latest
    timeout-minutes: 30
${inDir}    permissions:
      contents: read
      # The relay and the workers: each side proves itself by its OIDC token.
      id-token: write
      # Dispatching and cancelling the workers.
      actions: write
    env:
      GITHUB_TOKEN: \${{ github.token }}
    steps:
      # One commit: --affected fetches its base itself.
      - uses: ${CHECKOUT}
        with: { persist-credentials: false }
      - uses: ${SETUP_BUN}
${rootInstall(setup.manager, setup.dir).join('\n')}
      - run: ${vx} lock --check
${
  named
    ? ''
    : `      # Name the tasks to run, as '${vx} run build test --affected': with
      # none named, vx fails, listing the workspace's tasks.
`
}      - run: ${vx} run \${{ github.event_name == 'pull_request' && '${both(setup.tasks.change, '--affected')}' || '${both(setup.tasks.main, '--all')}' }}
`
  const repo = setup.repository ?? '<owner>/<repo>'
  const files = { '.github/workflows/ci.yml': run, [`.github/workflows/${workflow}`]: text }
  return {
    files,
    next: nextSteps(
      setup.relay,
      `${GITHUB_ISSUER}:${repo}:ci.yml ${GITHUB_ISSUER}:${repo}:${workflow}`,
      Object.keys(files),
    ),
  }
}

/** A YAML single-quoted string, as oxfmt writes one. */
function quoted(s: string): string {
  return `'${s.replaceAll("'", "''")}'`
}

/** Tasks then a flag, either possibly none. */
function both(tasks: string, flag: string): string {
  return tasks === '' ? flag : `${tasks} ${flag}`
}

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'

/** The run's job needs vx and the plugins only: no task runs there. */
function rootInstall(manager: DteSetup['manager'], dir: string): string[] {
  if (manager === 'bun') return ["      - run: bun install --frozen-lockfile --filter './'"]
  return [
    ...(manager === 'pnpm' ? [pnpmAction(dir)] : []),
    ...installLines(manager).map((l) => `      - run: ${l}`),
  ]
}

/** pnpm's setup step, which reads the pnpm version from the workspace's `package.json`. */
function pnpmAction(dir: string): string {
  return dir === ''
    ? `      - uses: ${SETUP_PNPM}`
    : `      - uses: ${SETUP_PNPM}\n        with: { package_json_file: ${dir}/package.json }`
}

/**
 * The project's one pipeline file: the run's `vx` job on a merge request
 * or the default branch, and a job per worker size, which only a pipeline
 * the run triggers (`VX_DTE_SIZE`) runs.
 */
export function gitlabInit(options: GitlabOptions, setup: DteSetup): DteInit {
  if (setup.relay === undefined)
    throw new UserError(
      'vx dte init: gitlab() needs dte({ relay }) first, since each job asks its ID token for the relay: deploy one (https://vznjs.github.io/vx/docs/relay/) and name it',
    )
  const relay = setup.relay
  const vx = vxCommand(setup.manager)
  const named = setup.tasks.main !== '' && setup.tasks.change !== ''
  const root =
    setup.manager === 'bun'
      ? ["bun install --frozen-lockfile --filter './'"]
      : installLines(setup.manager)
  const lines = (l: readonly string[]): string => l.map((x) => `    - ${x}`).join('\n')
  // A workspace in a subdirectory: the job's commands run in it.
  const cd = setup.dir === '' ? [] : [`cd ${quoted(setup.dir)}`]
  // oven/bun has no git, which the run's snapshot and a worker's fetch need.
  const git =
    'command -v git || (apt-get update -qq && apt-get install -qq -y --no-install-recommends git)'
  const workers = setup.sizes.map((s) => {
    const tags = options.tags?.[s.name]
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')))
      throw new UserError(`vx dte init: gitlab() tags.${s.name} is a list of runner tags`)
    // A matrix takes at most 200 jobs; a wave picks its slots.
    if (s.max === undefined || s.max < 1 || s.max > 200)
      throw new UserError(
        `vx dte init: gitlab() needs workers.${s.name}.max, 1 to 200: its job is a matrix of that many slots`,
      )
    const slots = Array.from({ length: s.max }, (_, i) => quoted(String(i + 1)))
    return `
${quoted(`vx-worker ${s.name}`)}:
  extends: .vx-worker
  parallel:
    matrix:
      - VX_DTE_SLOT: [${slots.join(', ')}]
  rules: [{ if: $VX_DTE_SIZE == ${JSON.stringify(s.name)} && $VX_DTE_SLOT =~ $VX_DTE_PICK }]
${tags === undefined ? '' : `  tags: [${tags.map(quoted).join(', ')}]\n`}`
  })
  const ci = `# Written by vx dte init from dte() in .vx/workspace.ts. The vx job
# runs no task: once it is on the relay it triggers a pipeline of this
# file for each wave of workers of a size, which runs only those slots
# of that size's job.${
    named
      ? ''
      : `
# Name the tasks in the vx job, as 'build test --all': with none named,
# vx fails, listing them.`
  }
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_PIPELINE_SOURCE == "pipeline" && $VX_DTE_SIZE

# The image needs Bun; a job adds git if it lacks it. By digest: a tag
# can move under the same name.
default:
  image: oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d

vx:
  rules:
    - if: $VX_DTE_SIZE
      when: never
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      variables: { VX_TASKS: '${both(setup.tasks.change, '--affected')}' }
    - when: on_success
      variables: { VX_TASKS: '${both(setup.tasks.main, '--all')}' }
  id_tokens: { VX_DTE_TOKEN: { aud: ${relay} } }
  before_script:
${lines([git, ...cd, ...root])}
  script:
    - ${vx} lock --check
    - ${vx} run $VX_TASKS

# A worker runs at the run's commit, which its branch may have moved past.
.vx-worker:
  variables: { GIT_DEPTH: 1 }
  id_tokens: { VX_DTE_TOKEN: { aud: ${relay} } }
  before_script:
${lines([git])}
    - git fetch -q --depth 1 origin $VX_DTE_SHA
    - git checkout -q FETCH_HEAD
${lines([...cd, ...installLines(setup.manager)])}
  script: [${vx} dte worker]
${workers.join('')}`.replace(/\n+$/, '\n')
  const next = nextSteps(
    relay,
    `https://${setup.host ?? 'gitlab.com'}:${setup.repository ?? '<group>/<project>'}:.gitlab-ci.yml`,
    ['.gitlab-ci.yml'],
  )
  // A project made since GitLab 17.7 lets no one set them: every trigger is refused.
  next.splice(
    -1,
    0,
    '  4. In Settings > CI/CD > Variables: set "Minimum role to use pipeline variables" to Developer: each pipeline the run triggers takes its workers\' variables.',
  )
  return { files: { '.gitlab-ci.yml': ci }, next }
}
