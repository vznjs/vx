// auto-release.yml's one step, the `release.auto` task: release a commit
// whose CI went green on main. It tags it with the next version and creates
// the GitHub release, both from the Conventional Commits since the last tag
// (release-notes.ts), then dispatches release.yml and npm.yml: a release
// created with the workflow token fires no `release` event in other
// workflows, so the two that build and publish it are started explicitly.
// npm.yml runs as itself, which is what its npm Trusted Publishers are
// registered to, so the publish needs no token.
//
// A commit is released only when the last release is its ancestor, so a
// slow run can never publish an older tree under a higher version; one
// already tagged is skipped.
//
//   VX_RELEASE_SHA=<sha> GH_TOKEN=… GITHUB_REPOSITORY=owner/repo bun scripts/auto-release.ts

import { commitsBetween, nextVersion, releaseNotes } from './release-notes.ts'

/** `git <args>`: whether it exited 0, and its stdout. */
export type Git = (args: readonly string[]) => { ok: boolean; out: string }

export type Decision = { release: false; reason: string } | { release: true; last: string }

export function decideRelease(sha: string, git: Git): Decision {
  const tags = git(['tag', '--points-at', sha])
    .out.split('\n')
    .filter((t) => t.startsWith('v'))
  if (tags.length > 0) {
    return {
      release: false,
      reason: `${sha} is already tagged (${tags.join(' ')}); nothing to release`,
    }
  }
  const last =
    git(['tag', '-l', 'v*', '--sort=v:refname']).out.split('\n').filter(Boolean).at(-1) ?? ''
  if (last !== '' && !git(['merge-base', '--is-ancestor', last, sha]).ok) {
    return {
      release: false,
      reason: `${last} is not an ancestor of ${sha} — a newer commit is already released; skipping`,
    }
  }
  return { release: true, last }
}

/** The workflows a release dispatches, with the inputs each declares. */
export function dispatches(
  version: string,
): Array<{ workflow: string; inputs: Record<string, string> }> {
  return [
    { workflow: 'release.yml', inputs: { tag: `v${version}` } },
    { workflow: 'npm.yml', inputs: { version, ref: `v${version}` } },
  ]
}

const git: Git = (args) => {
  const r = Bun.spawnSync({ cmd: ['git', ...args], stdout: 'pipe', stderr: 'inherit' })
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() }
}

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

async function main(): Promise<void> {
  const sha = env('VX_RELEASE_SHA')
  const decision = decideRelease(sha, git)
  if (!decision.release) {
    console.log(decision.reason)
    return
  }
  const { last } = decision
  const commits = commitsBetween(last, sha)
  const version = nextVersion(last, commits)
  const repo = env('GITHUB_REPOSITORY')
  const token = env('GH_TOKEN')
  const api = async (route: string, body: unknown): Promise<void> => {
    const res = await fetch(`https://api.github.com/repos/${repo}/${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`POST ${route}: ${res.status} ${res.statusText}\n${await res.text()}`)
    }
  }
  console.log(`releasing ${sha} as v${version} (after ${last || 'no tag'})`)
  await api('releases', {
    tag_name: `v${version}`,
    target_commitish: sha,
    name: `v${version}`,
    body: releaseNotes(commits),
  })
  for (const { workflow, inputs } of dispatches(version)) {
    await api(`actions/workflows/${workflow}/dispatches`, { ref: 'main', inputs })
  }
  console.log(`released v${version} — assets: release.yml, npm: npm.yml`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    process.exitCode = 1
  }
}
