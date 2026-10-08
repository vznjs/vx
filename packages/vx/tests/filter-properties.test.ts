// `--filter` selection over seeded random workspaces, against an oracle
// written from cli.md's Filter DSL table rather than from filter.ts: name
// globs (`*` crosses `/`, the scope may be left out when one package
// carries the rest), `./dir` / `{dir}` / `./glob` / `.` / `//`, `tag:`,
// the four walks and `...X...`, and `!` taken after every include. Git
// forms (`[ref]`) are left to the affected suites.

import { describe, expect, it } from 'bun:test'
import { rng } from './helpers/rng.js'
import { UserError } from '../src/util/index.js'
import { applyFilters, parseFilter } from '../src/workspace/filter.js'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import type { ProjectMeta } from '../src/workspace/workspace.js'

const ROOT = '/ws'
const SCOPES = ['@s', '@acme-co', '@a.b']
const BASES = ['core', 'ui', 'ui-kit', 'app', 'a.b', 'axb', 'core-x', 'web']
const GROUPS = ['packages', 'apps', 'tools/x']
const TAGS = ['scope:web', 'scope:api', 'type:lib']

interface World {
  projects: ProjectMeta[]
  deps: Map<string, Set<string>>
  tags: Map<string, string[]>
  /** Root-relative dirs, `''` for the root project. */
  rel: Map<string, string>
}

type Rnd = () => number
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!

function world(rnd: Rnd): World {
  const n = 2 + Math.floor(rnd() * 9)
  const names: string[] = []
  const seen = new Set<string>()
  while (names.length < n) {
    const base = pick(rnd, BASES)
    const name = rnd() < 0.5 ? `${pick(rnd, SCOPES)}/${base}` : base
    if (!seen.has(name)) names.push(name)
    seen.add(name)
  }
  const rel = new Map<string, string>()
  const used = new Set<string>()
  names.forEach((name, i) => {
    let dir: string
    if (i === 0 && rnd() < 0.3) dir = ''
    else {
      const parents = [...rel.values()].filter((d) => d !== '')
      dir =
        parents.length > 0 && rnd() < 0.25
          ? `${pick(rnd, parents)}/examples/e${i}`
          : `${pick(rnd, GROUPS)}/${name.replace(/[@/]/g, '')}${i}`
    }
    rel.set(name, dir)
    used.add(dir)
  })
  const deps = new Map<string, Set<string>>()
  const projects: ProjectMeta[] = []
  const taskEdges = new Map<string, string[]>()
  const tags = new Map<string, string[]>()
  names.forEach((name, i) => {
    const own = new Set<string>()
    for (let j = 0; j < i; j++) if (rnd() < 0.3) own.add(names[j]!)
    deps.set(name, own)
    const manifest: string[] = []
    const edges: string[] = []
    for (const d of own) (rnd() < 0.5 ? manifest : edges).push(d)
    taskEdges.set(name, edges)
    tags.set(
      name,
      TAGS.filter(() => rnd() < 0.35),
    )
    const dir = rel.get(name)!
    projects.push({
      name,
      dir: dir === '' ? ROOT : `${ROOT}/${dir}`,
      packageJson: {
        name,
        dependencies: Object.fromEntries(manifest.map((d) => [d, 'workspace:*'])),
      },
      configPath: null,
    })
  })
  // Discovery order is not the dependency order.
  for (let i = projects.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[projects[i], projects[j]] = [projects[j]!, projects[i]!]
  }
  return { projects, deps, tags, rel }
}

/** `*` = any run of characters, `/` included; nothing else is special. */
function starMatch(pattern: string, s: string): boolean {
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === s
  const head = pattern.slice(0, star)
  if (!s.startsWith(head)) return false
  const rest = pattern.slice(star + 1)
  for (let k = head.length; k <= s.length; k++) if (starMatch(rest, s.slice(k))) return true
  return false
}

function closure(edges: Map<string, Set<string>>, from: string): Set<string> {
  const out = new Set<string>()
  const stack = [...(edges.get(from) ?? [])]
  while (stack.length > 0) {
    const x = stack.pop()!
    if (out.has(x)) continue
    out.add(x)
    stack.push(...(edges.get(x) ?? []))
  }
  return out
}

const WALKS = ['plain', 'deps', 'dependents', 'onlyDeps', 'onlyDependents', 'both'] as const
type Walk = (typeof WALKS)[number]

interface Spec {
  raw: string
  negate: boolean
  walk: Walk
  /** What the selector names, before the walk. */
  matched: string[]
}

/** The oracle's reading of a path selector (`./<p>`, `{<p>}`). */
function pathSelect(w: World, p: string): string[] {
  const all = [...w.rel]
  const exact = all.find(([, d]) => d === p)
  if (exact !== undefined) return [exact[0]]
  const under = all.filter(([, d]) => p === '' || d.startsWith(`${p}/`)).map(([n]) => n)
  if (under.length > 0 || !p.includes('*')) return under
  if (p.endsWith('/**')) {
    const base = p.slice(0, -3)
    return all.filter(([, d]) => d === base || d.startsWith(`${base}/`)).map(([n]) => n)
  }
  const base = p.slice(0, -2)
  return all
    .filter(([, d]) => d.startsWith(`${base}/`) && !d.slice(base.length + 1).includes('/'))
    .map(([n]) => n)
}

function nameSelect(w: World, pattern: string): string[] {
  const names = [...w.rel.keys()]
  const direct = names.filter((n) => starMatch(pattern, n))
  if (direct.length > 0) return direct
  if (pattern.includes('/')) return pattern.startsWith('@') ? [] : pathSelect(w, pattern)
  const tails = names.filter((n) => n.startsWith('@') && starMatch(pattern, n.split('/')[1]!))
  return pattern.includes('*') || tails.length === 1 ? tails : []
}

function selector(rnd: Rnd, w: World): { text: string; matched: string[] } {
  const names = [...w.rel.keys()]
  const dirs = [...w.rel.values()].filter((d) => d !== '')
  const name = pick(rnd, names)
  const r = Math.floor(rnd() * 14)
  let text: string
  switch (r) {
    case 0:
    case 1:
      text = name
      break
    case 2:
      text = name.includes('/') ? name.split('/')[1]! : pick(rnd, BASES)
      break
    case 3: {
      const a = Math.floor(rnd() * name.length)
      const b = a + Math.floor(rnd() * (name.length - a + 1))
      text = `${name.slice(0, a)}*${name.slice(b)}`
      break
    }
    case 4:
      text = pick(rnd, ['*', '@s/*', '*core*', 'a?b', 'ui-*', 'nope', 'cor'])
      break
    case 5:
      text = dirs.length > 0 ? `./${pick(rnd, dirs)}` : './packages'
      break
    case 6:
      text = dirs.length > 0 ? `{${pick(rnd, dirs)}}` : '{apps}'
      break
    case 7:
      text = `./${pick(rnd, GROUPS)}`
      break
    case 8:
      text = `./${pick(rnd, GROUPS)}/${pick(rnd, ['*', '**'])}`
      break
    case 9:
      text = dirs.length > 0 ? `./${pick(rnd, dirs)}/**` : './apps/**'
      break
    case 10:
      text = `${pick(rnd, GROUPS)}/*`
      break
    case 11:
      text = `tag:${pick(rnd, ['scope:*', 'type:lib', 'scope:web', 'nope', '*'])}`
      break
    case 12:
      text = '//'
      break
    default:
      text = '.'
  }
  let matched: string[]
  if (text.startsWith('tag:')) {
    const t = text.slice(4)
    matched = [...w.tags].filter(([, ts]) => ts.some((x) => starMatch(t, x))).map(([n]) => n)
  } else if (text === '//') {
    matched = [...w.rel].filter(([, d]) => d === '').map(([n]) => n)
  } else if (text === '.') {
    matched = pathSelect(w, '')
  } else if (text.startsWith('./')) {
    matched = pathSelect(w, text.slice(2))
  } else if (text.startsWith('{')) {
    matched = pathSelect(w, text.slice(1, -1))
  } else {
    matched = nameSelect(w, text)
  }
  return { text, matched }
}

function spec(rnd: Rnd, w: World): Spec {
  const { text, matched } = selector(rnd, w)
  // `....` is `...` + `.` as written: a suffix walk on `.` reads as a prefix one.
  const walk =
    text === '.' ? pick(rnd, ['plain', 'dependents', 'onlyDependents'] as const) : pick(rnd, WALKS)
  const body = {
    plain: text,
    deps: `${text}...`,
    dependents: `...${text}`,
    onlyDeps: `${text}^...`,
    onlyDependents: `...^${text}`,
    both: `...${text}...`,
  }[walk]
  const negate = rnd() < 0.3
  return { raw: negate ? `!${body}` : body, negate, walk, matched }
}

function expand(w: World, rdeps: Map<string, Set<string>>, s: Spec): Set<string> {
  const out = new Set<string>()
  const deps = (n: string): Set<string> => closure(w.deps, n)
  const dependents = (n: string): Set<string> => closure(rdeps, n)
  for (const m of s.matched) {
    const add = (xs: Iterable<string>): void => {
      for (const x of xs) out.add(x)
    }
    switch (s.walk) {
      case 'plain':
        out.add(m)
        break
      case 'deps':
        out.add(m)
        add(deps(m))
        break
      case 'dependents':
        out.add(m)
        add(dependents(m))
        break
      case 'onlyDeps':
        add(deps(m))
        break
      case 'onlyDependents':
        add(dependents(m))
        break
      case 'both':
        out.add(m)
        add(deps(m))
        for (const d of dependents(m)) {
          out.add(d)
          add(deps(d))
        }
    }
  }
  return out
}

function oracle(w: World, specs: Spec[]): Set<string> {
  const rdeps = new Map<string, Set<string>>()
  for (const [n, ds] of w.deps) for (const d of ds) rdeps.set(d, (rdeps.get(d) ?? new Set()).add(n))
  const includes = specs.filter((s) => !s.negate)
  const out = new Set<string>(includes.length > 0 ? [] : w.rel.keys())
  for (const s of includes) for (const n of expand(w, rdeps, s)) out.add(n)
  for (const s of specs.filter((x) => x.negate)) for (const n of expand(w, rdeps, s)) out.delete(n)
  return out
}

function select(w: World, raws: string[], noMatch?: string[]): Set<string> {
  const edges = new Map<string, string[]>()
  for (const p of w.projects) {
    const manifest = Object.keys(p.packageJson.dependencies as Record<string, string>)
    edges.set(
      p.name,
      [...w.deps.get(p.name)!].filter((d) => !manifest.includes(d)),
    )
  }
  return applyFilters({
    filters: raws.map((r) => parseFilter(r, ROOT)),
    projects: w.projects,
    graph: buildPackageGraph(w.projects, edges),
    tags: w.tags,
    ...(noMatch !== undefined ? { onNoMatch: (f) => noMatch.push(f.raw) } : {}),
  })
}

const sorted = (s: Iterable<string>): string[] => [...s].sort()

describe('--filter over random workspaces', () => {
  it('selects what the documented DSL says, in any filter order', () => {
    const rnd = rng(1031)
    for (let iter = 0; iter < 1500; iter++) {
      const w = world(rnd)
      const specs = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => spec(rnd, w))
      const raws = specs.map((s) => s.raw)
      const noMatch: string[] = []
      const got = select(w, raws, noMatch)
      const ctx = { iter, raws, dirs: Object.fromEntries(w.rel) }
      expect({ ...ctx, got: sorted(got) }).toEqual({ ...ctx, got: sorted(oracle(w, specs)) })
      expect({ ...ctx, noMatch }).toEqual({
        ...ctx,
        noMatch: specs.filter((s) => s.matched.length === 0).map((s) => s.raw),
      })
      const shuffled = [...raws].sort(() => rnd() - 0.5)
      expect({ ...ctx, shuffled, got: sorted(select(w, shuffled)) }).toEqual({
        ...ctx,
        shuffled,
        got: sorted(got),
      })
      const rdeps = new Map<string, Set<string>>()
      for (const [n, ds] of w.deps)
        for (const d of ds) rdeps.set(d, (rdeps.get(d) ?? new Set()).add(n))
      for (const s of specs.filter((x) => x.negate))
        for (const n of expand(w, rdeps, s))
          expect({ ...ctx, kept: n, has: got.has(n) }).toEqual({
            ...ctx,
            kept: n,
            has: false,
          })
    }
  })

  it('refuses a filter that names no project with a UserError quoting it', () => {
    const empty = [
      '',
      '!',
      '...',
      '!...',
      '^...',
      '...^',
      '!...^',
      '......',
      '...^...',
      'tag:',
      '!tag:',
      '...tag:',
    ]
    const refused = empty.map((raw) => {
      try {
        parseFilter(raw, ROOT)
        return { raw, error: 'none' }
      } catch (err) {
        return {
          raw,
          error:
            err instanceof UserError && err.message.includes(`"${raw}"`)
              ? 'UserError'
              : String(err),
        }
      }
    })
    expect(refused).toEqual(empty.map((raw) => ({ raw, error: 'UserError' })))
  })

  it('refuses random input only with a UserError quoting it, never a crash', () => {
    const rnd = rng(1032)
    const alphabet = [
      '.',
      '..',
      '...',
      '!',
      '^',
      '*',
      '/',
      '@',
      '{',
      '}',
      '[',
      ']',
      'tag:',
      'a',
      'ui',
      '?',
      '\\',
      '(',
      '|',
      '$',
    ]
    let accepted = 0
    for (let iter = 0; iter < 3000; iter++) {
      const w = world(rnd)
      const raw = Array.from({ length: Math.floor(rnd() * 7) }, () => pick(rnd, alphabet)).join('')
      let outcome = 'ok'
      try {
        select(w, [raw])
        accepted++
      } catch (err) {
        if (!(err instanceof UserError && err.message.includes(`"${raw}"`))) outcome = String(err)
      }
      expect({ raw, outcome }).toEqual({ raw, outcome: 'ok' })
    }
    expect(accepted).toBeGreaterThan(2000)
  })
})

it('the oracle reads its own path forms as the table does', () => {
  // Pins the oracle, not filter.ts: a wrong oracle agreeing with a wrong
  // implementation is the failure mode a generated check hides.
  const w: World = {
    projects: [],
    deps: new Map(),
    tags: new Map(),
    rel: new Map([
      ['@s/kit', 'packages/kit'],
      ['demo', 'packages/kit/examples/e1'],
      ['web', 'apps/web'],
      ['root', ''],
    ]),
  }
  expect({
    exactDir: pathSelect(w, 'packages/kit'),
    under: sorted(pathSelect(w, 'packages')),
    star: pathSelect(w, 'packages/*'),
    globstar: sorted(pathSelect(w, 'packages/kit/**')),
    dot: pathSelect(w, ''),
    scopeLess: nameSelect(w, 'kit'),
    dirFallback: nameSelect(w, 'apps/*'),
    escaped: nameSelect(w, 'r.ot'),
  }).toEqual({
    exactDir: ['@s/kit'],
    under: ['@s/kit', 'demo'],
    star: ['@s/kit'],
    globstar: ['@s/kit', 'demo'],
    dot: ['root'],
    scopeLess: ['@s/kit'],
    dirFallback: ['web'],
    escaped: [],
  })
})
