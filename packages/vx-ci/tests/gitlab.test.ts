// `gitlab()` names the run's branch through `setBranch`, as `github()`
// does on Actions (2026-10-18): the default branch and a merge
// train keep the default keys, a branch or its merge request gets
// `<project path>:<branch>`, and a merge request its diff base. Each
// names the refs a remote reads (2026-10-25).
import { expect, it } from 'bun:test'
import type { BranchFacts } from '@vzn/vx'
import { gitlab } from '../src/index.js'

const GITLAB_KEYS = [
  'GITLAB_CI',
  'CI_PROJECT_PATH',
  'CI_DEFAULT_BRANCH',
  'CI_COMMIT_REF_NAME',
  'CI_COMMIT_TAG',
  'CI_MERGE_REQUEST_EVENT_TYPE',
  'CI_MERGE_REQUEST_SOURCE_BRANCH_NAME',
  'CI_MERGE_REQUEST_SOURCE_PROJECT_PATH',
  'CI_MERGE_REQUEST_DIFF_BASE_SHA',
  'CI_MERGE_REQUEST_TARGET_BRANCH_NAME',
  'CI_EXTERNAL_PULL_REQUEST_SOURCE_BRANCH_NAME',
  'CI_EXTERNAL_PULL_REQUEST_TARGET_BRANCH_NAME',
]

async function branchOf(
  env: Record<string, string>,
  options: Parameters<typeof gitlab>[0] = {},
  baseBranch?: string,
): Promise<BranchFacts | 'declined'> {
  const saved = GITLAB_KEYS.map((k) => [k, process.env[k]] as const)
  for (const k of GITLAB_KEYS) delete process.env[k]
  Object.assign(process.env, env)
  const facts: BranchFacts = {}
  try {
    const plugin = gitlab(options)
    if (plugin === undefined) return 'declined'
    await plugin.config!(baseBranch === undefined ? {} : { baseBranch }, {
      workspaceRoot: '/ws',
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

const job = (ref: string, extra: Record<string, string> = {}): Record<string, string> => ({
  GITLAB_CI: 'true',
  CI_PROJECT_PATH: 'Acme/Web/App',
  CI_DEFAULT_BRANCH: 'main',
  CI_COMMIT_REF_NAME: ref,
  ...extra,
})

it('the default branch keeps the default keys; another branch or tag gets its own scope', async () => {
  expect(await branchOf(job('main'))).toEqual({ refs: ['refs/heads/main'] })
  expect(await branchOf(job('feat-x'))).toEqual({
    scope: 'acme/web/app:feat-x',
    refs: ['refs/heads/feat-x', 'refs/heads/main'],
  })
  expect(await branchOf(job('main', { CI_COMMIT_TAG: 'main' }))).toEqual({
    scope: 'acme/web/app:main',
    refs: ['refs/tags/main', 'refs/heads/main'],
  })
})

it("a merge request names its source branch, a fork's in the fork, and its diff base", async () => {
  const mr = {
    CI_MERGE_REQUEST_EVENT_TYPE: 'merged_result',
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat-x',
    CI_MERGE_REQUEST_DIFF_BASE_SHA: 'b4se',
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release',
  }
  expect(await branchOf(job('refs/merge-requests/7/merge', mr))).toEqual({
    scope: 'acme/web/app:feat-x',
    base: 'b4se',
    refs: ['refs/heads/feat-x', 'refs/heads/release', 'refs/heads/main'],
  })
  expect(
    await branchOf(
      job('refs/merge-requests/7/merge', {
        ...mr,
        CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: 'eve/app',
      }),
    ),
  ).toEqual({
    scope: 'eve/app:feat-x',
    base: 'b4se',
    refs: ['refs/heads/feat-x', 'refs/heads/release', 'refs/heads/main'],
  })
})

// A GitHub pull request mirrored to GitLab runs as an external pull
// request pipeline: no CI_MERGE_REQUEST_* variables, and the branch it
// merges into went unread.
it('an external pull request reads the branch it merges into', async () => {
  expect(
    await branchOf(
      job('feat-x', {
        CI_EXTERNAL_PULL_REQUEST_SOURCE_BRANCH_NAME: 'feat-x',
        CI_EXTERNAL_PULL_REQUEST_TARGET_BRANCH_NAME: 'release',
      }),
    ),
  ).toEqual({
    scope: 'acme/web/app:feat-x',
    refs: ['refs/heads/feat-x', 'refs/heads/release', 'refs/heads/main'],
  })
})

it('a merge train is trusted: no scope, compared with its diff base, reading only its target', async () => {
  const train = job('refs/merge-requests/7/train', {
    CI_MERGE_REQUEST_EVENT_TYPE: 'merge_train',
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat-x',
    CI_MERGE_REQUEST_DIFF_BASE_SHA: 'b4se',
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release',
  })
  expect(await branchOf(train)).toEqual({
    trusted: true,
    base: 'b4se',
    refs: ['refs/heads/release'],
  })
  // 2026-10-25: a train reads its target only, never the default branch.
  expect(await branchOf(train, {}, 'trunk')).toMatchObject({ refs: ['refs/heads/release'] })
})

it("the workspace's baseBranch is the default branch a run reads last", async () => {
  expect(await branchOf(job('feat-x'), {}, 'trunk')).toMatchObject({
    refs: ['refs/heads/feat-x', 'refs/heads/trunk'],
  })
})

it('off GitLab CI it declines; with cacheScope: false it names nothing; an unknown option is refused', async () => {
  expect(await branchOf({ CI_PROJECT_PATH: 'a/b', CI_COMMIT_REF_NAME: 'feat' })).toBe('declined')
  expect(await branchOf(job('feat-x'), { cacheScope: false })).toEqual({})
  expect(
    branchOf(job('feat-x'), { cachescope: true } as Parameters<typeof gitlab>[0]),
  ).rejects.toThrow('gitlab()')
})
