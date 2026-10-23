// Until 1.0 an old name just stops working (owner, 2026-10-14): no alias,
// no rename notice. So no text in the repo may still teach one; a docs
// example has to work as written today. The old → new list lives only in
// the upgrading page and each release note's Breaking changes section,
// which this law skips. History and design records keep the names they
// were written with, and tests may name an old spelling to prove it fails.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '../../..')

const OLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bVX_TASK_TIMEOUT\b/, 'VX_RUN_TIMEOUT'],
  [
    /\bVX_(RUN_)?KILL_GRACE(_MS)?\b|\brun\.killGrace\b|(?<![\w-])--kill-grace\b/,
    'nothing (the kill grace is a fixed 2 s)',
  ],
  [
    /\bVX_(RUN_)?TEARDOWN_TIMEOUT(_MS)?\b|\brun\.teardownTimeout\b|(?<![\w-])--teardown-timeout\b/,
    'nothing (the teardown bound is a fixed 3 s)',
  ],
  [/\bVX_READY_NOTICE_MS\b/, 'nothing (the ready notice is a fixed 10 s)'],
  [/\bVX_CACHE\b(?!_)/, 'VX_CACHE_POLICY'],
  [/(?<!CACHE_)\bVX_INPUT_STABILITY/, 'VX_CACHE_INPUT_STABILITY_STRATEGY / _SEVERITY'],
  [/\bVX_CONFIG_WORKER_TIMEOUT_MS\b/, 'VX_CONFIG_WORKER_TIMEOUT'],
  [/\bVX_TIMING\b/, 'VX_DEBUG_TIMING'],
  [/\bVX_DUMPABLE\b/, 'VX_DEBUG_DUMPABLE'],
  [/\bVX_REWRITTEN_INPUTS\b|\brewrittenInputs\b/, 'cache.inputStability'],
  [/(?<![\w-])--retry\b/, '--retries'],
  [/(?<![\w-])--download\b/, '--cache-download'],
  [/\bvx stats\b/, 'vx info'],
  [/\bvx migrate\b/, 'bunx @vzn/vx-migrate'],
  [/@vzn\/vx-github\b/, '@vzn/vx-ci'],
  [/\bvx\.workspace\.(ts|mts|js|mjs|cts|cjs|\*|\{)/, '.vx/workspace.ts'],
  [/\bvx-lock\.json\b/, '.vx/projects.lock.json'],
  [/\bvx cache prune\b/, 'vx cache clean'],
  [
    /(?<![\w-])--(no-)?frozen\b(?!-)|\brun\.frozen\b|\bVX_RUN_FROZEN\b/,
    'vx lock (runs read only the lock)',
  ],
  [/\.vx\/lock\.json\b/, '.vx/projects.lock.json'],
]

const SKIP = [
  /(^|\/)tests\//,
  /^packages\/vx\/docs\/(history|design)\//,
  /^packages\/vx\/docs\/STATUS\.md$/,
  /^private\/vx-docs\/src\/content\/docs\/guides\/upgrading\.md$/,
]

// A post is kept current, with no note on what changed (owner,
// 2026-10-16). The one exception shows a misspelled flag refused with
// the right one as its fix.
const NAMES_THE_RENAME: ReadonlyMap<string, string> = new Map([
  ['private/vx-docs/src/content/docs/blog/upgrade-you-can-trust.md', '--retries'],
])

const TEXT = /\.(md|mdx|ts|tsx|js|mjs|cjs|json|ya?ml|astro|sh)$/

/** A release note without its Breaking changes section, where old names belong. */
function withoutBreaking(file: string, text: string): string {
  if (!file.includes('/content/docs/releases/')) return text
  return text.replace(/^## Breaking changes\n[\s\S]*?(?=^## |(?![\s\S]))/m, '')
}

it('no text outside the breaking lists names a setting, flag or verb that stopped working', () => {
  const files = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: ROOT })
    .stdout.toString()
    .split('\0')
    .filter((f) => TEXT.test(f) && !SKIP.some((s) => s.test(f)))
  const found: string[] = []
  for (const f of files) {
    const lines = withoutBreaking(f, readFileSync(path.join(ROOT, f), 'utf8')).split('\n')
    lines.forEach((line, i) => {
      for (const [re, now] of OLD)
        if (re.test(line) && NAMES_THE_RENAME.get(f) !== now) found.push(`${f}:${i + 1} → ${now}`)
    })
  }
  expect(found).toEqual([])
})
