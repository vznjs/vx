// `npx vx`, `bunx vx`, `pnpm dlx vx` and `yarn dlx vx` run the npm package
// named `vx`, which is a stranger's, wherever @vzn/vx is not installed
// (Growth's fresh-repo trial, 2026-10-13). No text we ship spells one: a
// reader copies the line before the install. A repo-wide law, so unsafe.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
const SELF = path.relative(REPO, import.meta.path)
// The shipped record is history, not instructions.
const SKIP = /^packages\/vx\/docs\/history\//
const TEXT = /\.(md|mdx|astro|ts|tsx|js|mjs|cjs|json|ya?ml|txt|sh)$/
const RUNNERS = ['npx', 'bunx', 'pnpm dlx', 'yarn dlx', 'pnpx']
// After a word boundary, or after a `\n` escape inside a source string.
const UNSCOPED = new RegExp(
  `(?:(?<=\\\\n)|(?<![\\w@/-]))(?:${RUNNERS.join('|')}) vx(?![\\w@/-])`,
  'g',
)

it('no shipped text runs vx through a runner by its bare name', () => {
  const files = Bun.spawnSync({ cmd: ['git', 'ls-files'], cwd: REPO })
    .stdout.toString()
    .split('\n')
    .filter((f) => TEXT.test(f) && !SKIP.test(f) && f !== SELF)
  expect(files.length).toBeGreaterThan(100)
  const found: string[] = []
  for (const f of files) {
    const lines = readFileSync(path.join(REPO, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const m of line.matchAll(UNSCOPED)) found.push(`${f}:${i + 1}: ${m[0]}`)
    })
  }
  expect(found).toEqual([])
})

it('CONTROL: the law sees each runner, in prose and in a string', () => {
  const hits = (s: string) => [...s.matchAll(UNSCOPED)].map((m) => m[0])
  expect(hits('run `npx vx init`, or bunx vx.')).toEqual(['npx vx', 'bunx vx'])
  expect(hits("'npm i\\npnpm dlx vx'")).toEqual(['pnpm dlx vx'])
  expect(hits('npx @vzn/vx init; pnpm vx run; npx vx-migrate; my-npx vx')).toEqual([])
})
