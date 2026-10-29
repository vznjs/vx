// `github()` names the run's branch through `setBranch`: the default
// branch keeps the default keys, a branch (a PR's head included) gets
// `<owner>/<repo>:<branch>`, the scope a laptop on that branch reads, and
// a pull request its base commit.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { BranchFacts } from '@vzn/vx'
import { github } from '../src/index.js'

let dir: string
let eventPath: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-gh-scope-'))
  eventPath = path.join(dir, 'event.json')
  await writeFile(
    eventPath,
    JSON.stringify({ repository: { default_branch: 'main', full_name: 'vznjs/vx' } }),
  )
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const ACTIONS_KEYS = [
  'GITHUB_ACTIONS',
  'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REPOSITORY',
  'GITHUB_EVENT_PATH',
  'GITHUB_EVENT_NAME',
]

async function branchOf(
  env: Record<string, string>,
  options: Parameters<typeof github>[0] = {},
  baseBranch?: string,
): Promise<BranchFacts> {
  const saved = ACTIONS_KEYS.map((k) => [k, process.env[k]] as const)
  for (const k of ACTIONS_KEYS) delete process.env[k]
  Object.assign(process.env, env)
  const facts: BranchFacts = {}
  try {
    // Off Actions the factory is undefined: nothing to name.
    await github(options)?.config!(baseBranch === undefined ? {} : { baseBranch }, {
      workspaceRoot: dir,
      warn: () => {},
      setBranch: (f) => Object.assign(facts, f),
    })
    return facts
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
const scopeOf = async (
  env: Record<string, string>,
  options: Parameters<typeof github>[0] = {},
): Promise<string | undefined> => (await branchOf(env, options)).scope

const actions = (ref: string, name: string): Record<string, string> => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: ref,
  GITHUB_REF_NAME: name,
  GITHUB_REPOSITORY: 'vznjs/vx',
  GITHUB_EVENT_PATH: eventPath,
})

async function event(payload: object): Promise<string> {
  const file = path.join(dir, `event-${Math.random()}.json`)
  await writeFile(
    file,
    JSON.stringify({ repository: { default_branch: 'main', full_name: 'vznjs/vx' }, ...payload }),
  )
  return file
}

it('a push to the default branch keeps the default keys', async () => {
  expect(await branchOf(actions('refs/heads/main', 'main'))).toEqual({ refs: ['refs/heads/main'] })
})

it("a pull request writes to its head branch's scope, as a push to it does, and names its base", async () => {
  const file = await event({
    pull_request: {
      number: 42,
      head: { ref: 'feat/x', repo: { full_name: 'vznjs/vx' } },
      base: { sha: 'abc123' },
    },
  })
  const pr = {
    ...actions('refs/pull/42/merge', '42/merge'),
    GITHUB_HEAD_REF: 'feat/x',
    GITHUB_BASE_REF: 'release',
    GITHUB_EVENT_PATH: file,
  }
  expect(await branchOf(pr)).toEqual({
    scope: 'vznjs/vx:feat/x',
    base: 'abc123',
    refs: ['refs/heads/feat/x', 'refs/heads/release', 'refs/heads/main'],
  })
  expect(await branchOf(actions('refs/heads/feat/x', 'feat/x'))).toEqual({
    scope: 'vznjs/vx:feat/x',
    refs: ['refs/heads/feat/x', 'refs/heads/main'],
  })
  expect(await branchOf(actions('refs/heads/feat/x', 'feat/x'), {}, 'trunk')).toMatchObject({
    refs: ['refs/heads/feat/x', 'refs/heads/trunk'],
  })
})

it("a fork's pull request writes the fork's scope", async () => {
  const file = await event({
    pull_request: { number: 3, head: { ref: 'main', repo: { full_name: 'Eve/vx' } } },
  })
  const pr = {
    ...actions('refs/pull/3/merge', '3/merge'),
    GITHUB_HEAD_REF: 'main',
    GITHUB_EVENT_PATH: file,
  }
  expect(await scopeOf(pr)).toBe('eve/vx:main')
})

it('another branch or tag writes to its own scope', async () => {
  expect(await scopeOf(actions('refs/heads/feat/x', 'feat/x'))).toBe('vznjs/vx:feat/x')
  expect(await scopeOf(actions('refs/tags/v1.0', 'v1.0'))).toBe('vznjs/vx:v1.0')
  expect(await scopeOf(actions('refs/heads/a+b', 'a+b'))).toBe('vznjs/vx:a_b')
})

// These events run with the default branch's ref on a PR's behalf; a
// workflow that checks out the PR's head there wrote the default keys.
it("an event that runs in main's context for a pull request is the PR's", async () => {
  const on = async (name: string, payload: object): Promise<string | undefined> =>
    scopeOf({
      ...actions('refs/heads/main', 'main'),
      GITHUB_EVENT_PATH: await event(payload),
      GITHUB_EVENT_NAME: name,
    })
  expect([
    await on('pull_request_target', { pull_request: { number: 7, head: { ref: 'b7' } } }),
    await on('pull_request_target', {}),
    await on('issue_comment', { issue: { number: 9, pull_request: { url: 'x' } } }),
    await on('workflow_run', {
      workflow_run: { event: 'pull_request', head_branch: 'b5', pull_requests: [{ number: 5 }] },
    }),
    await on('workflow_run', { workflow_run: { event: 'pull_request', pull_requests: [] } }),
    // CONTROLS: the same events with no PR behind them keep the default keys.
    await on('issue_comment', { issue: { number: 9 } }),
    await on('workflow_run', { workflow_run: { event: 'push', pull_requests: [] } }),
    await on('push', {}),
  ]).toEqual([
    'vznjs/vx:b7',
    'pr-target',
    'pr-9',
    'vznjs/vx:b5',
    'pr-target',
    undefined,
    undefined,
    undefined,
  ])
})

// A workflow_run a pull request started names the PR's head as its scope,
// so it reads that branch first, then the branch the PR merges into, as
// the PR's own runs do. Before: it read only GITHUB_REF, main's.
it('a workflow_run a pull request started reads its head branch, then its base', async () => {
  expect(
    await branchOf({
      ...actions('refs/heads/main', 'main'),
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_EVENT_PATH: await event({
        repository: { default_branch: 'main', full_name: 'vznjs/vx' },
        workflow_run: {
          event: 'pull_request',
          head_branch: 'b5',
          pull_requests: [{ number: 5, base: { ref: 'release' } }],
        },
      }),
    }),
  ).toEqual({
    scope: 'vznjs/vx:b5',
    refs: ['refs/heads/b5', 'refs/heads/release', 'refs/heads/main'],
  })
})

// Owner, 2026-10-18: a merge queue builds what is about to land on main,
// so it reads and writes the default keys; its queue branch is a scope
// nobody reads. 2026-10-25: it reads its base branch only.
it("a merge queue's run is trusted: no scope, compared with the queue's base, reading only it", async () => {
  const sha = 'a'.repeat(40)
  const ref = `refs/heads/gh-readonly-queue/release/pr-7-${sha}`
  const queue = async (payload: object) =>
    branchOf(
      {
        ...actions(ref, `gh-readonly-queue/release/pr-7-${sha}`),
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_EVENT_PATH: await event(payload),
      },
      {},
      'trunk',
    )
  expect(
    await queue({
      merge_group: { base_sha: 'b4se', base_ref: 'refs/heads/release', head_ref: ref },
    }),
  ).toEqual({ trusted: true, base: 'b4se', refs: ['refs/heads/release'] })
  // No base_ref in the event: the queue ref names it.
  expect(await queue({ merge_group: { base_sha: 'b4se' } })).toEqual({
    trusted: true,
    base: 'b4se',
    refs: ['refs/heads/release'],
  })
})

// Anyone who can push can name a branch like a queue ref, so only a
// `merge_group` run is the queue's (the cache server renames only its
// ref, b6c9f3478). Before: a push to such a branch named no scope, the
// trusted keys, and read only the base it never writes.
it("a push to a branch named like a queue ref is not the queue's run", async () => {
  const name = `gh-readonly-queue/release/pr-7-${'a'.repeat(40)}`
  expect(
    await branchOf({
      ...actions(`refs/heads/${name}`, name),
      GITHUB_EVENT_NAME: 'push',
    }),
  ).toEqual({
    scope: `vznjs/vx:${name}`,
    refs: [`refs/heads/${name}`, 'refs/heads/main'],
  })
})

it('an unknown default branch gets its own scope', async () => {
  expect(
    await scopeOf({
      ...actions('refs/heads/main', 'main'),
      GITHUB_EVENT_PATH: path.join(dir, 'none'),
    }),
  ).toBe('vznjs/vx:main')
})

it('outside Actions, or with cacheScope: false, names nothing', async () => {
  expect(await branchOf({ GITHUB_REF: 'refs/pull/1/merge' })).toEqual({})
  expect(await branchOf(actions('refs/pull/1/merge', '1/merge'), { cacheScope: false })).toEqual({})
})
