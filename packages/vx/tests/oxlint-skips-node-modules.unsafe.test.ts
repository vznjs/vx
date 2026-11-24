// A sandboxed task reads only its own project, so oxlint there cannot see the
// workspace's .gitignore, and a config's `ignorePatterns` does not stop its
// walk (oxlint 1.83): it linted every file a project's node_modules links to.
// @vzn/vx-bench linted 7739 files in 299 s instead of 16 s and hit the run's
// 2m timeout. Only `--ignore-pattern` on the command line prunes the walk, and
// a command is in the task's key. Unsafe: it reads every project's config.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')
// A command naming what to lint, as the site's does, walks nothing else.
const WALKS = /(?<![\w.-])oxlint(?:\s+--[\w-]+)*\s*['"`]/g

it('every oxlint command that walks its project skips node_modules', () => {
  const configs = [
    ...new Bun.Glob('{packages,private}/*/vx.config.ts').scanSync({ cwd: repo }),
  ].sort()
  expect(configs.length).toBeGreaterThan(15)
  const walking = configs.flatMap((f) =>
    (readFileSync(path.join(repo, f), 'utf8').match(WALKS) ?? []).map(() => f),
  )
  expect(walking).toEqual([])
})

it('the law sees a walk and lets a pruned or path-naming command by', () => {
  for (const s of ["'oxlint --type-aware --type-check'", "'oxlint'"])
    expect(s.match(WALKS)).not.toBeNull()
  for (const s of [
    "'oxlint --type-aware --type-check --ignore-pattern node_modules'",
    "'oxlint --type-aware --type-check src tests'",
    "'lint.oxlint'",
  ])
    expect(s.match(WALKS)).toBeNull()
})
