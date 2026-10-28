// The laws that read git's history (the API break since the last tag, a
// PR's commits, the upgrading page's footers) on a one-commit checkout:
// a DTE worker checks out shallow, and the one task that needs history
// fetches it, commits and tags only (trees and blobs come on demand).
// A full clone was 5-7 s of every worker's warm-up (2026-10-23).
//
// Only HEAD's history and the tags are fetched, never origin's branches:
// a branch pushed during the run whose parent is HEAD made the filtered
// fetch's "repack local links" step die in git itself ("BUG:
// builtin/pack-objects.c: should_include_obj"), on every retry, three
// main runs of five on 2026-10-27.

const SHALLOW = ['rev-parse', '--is-shallow-repository']

const git = (root: string, args: string[]): { ok: boolean; out: string } => {
  const r = Bun.spawnSync(['git', ...args], {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stderr: 'pipe',
  })
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() + r.stderr.toString().trim() }
}

/**
 * Makes `root`'s checkout hold all of HEAD's commits and origin's tags. Tasks on
 * one worker may fetch at once; git takes one `shallow.lock`, so the
 * loser asks again. Throws naming git's error when it cannot.
 */
export function fetchHistory(root: string): void {
  const head = git(root, ['rev-parse', 'HEAD']).out
  let why = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    if (git(root, SHALLOW).out !== 'true') return
    const r = git(root, [
      'fetch',
      '--quiet',
      '--unshallow',
      '--tags',
      '--filter=tree:0',
      '--no-recurse-submodules',
      'origin',
      head,
    ])
    if (r.ok) return
    why = r.out
    Bun.sleepSync(200 * (attempt + 1))
  }
  if (git(root, SHALLOW).out !== 'true') return
  throw new Error(`fetching the history of a shallow checkout failed: ${why}`)
}
