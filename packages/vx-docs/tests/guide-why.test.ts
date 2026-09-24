// Chapter 1 of the Guide, "Why orchestrate?" (design/site-redo-2026-09.md,
// and the owner's "simple, visual" brief): four packages, the shell loop and
// its three failures, each a picture, then the same work orchestrated. The
// pictures are numbers and statuses someone typed (why/pictures.ts), so each
// is held to the rule it illustrates, computed from the four packages. The
// "In vx" command is held to the CLI's parser and to what vx plans for it.

import { afterAll, describe, expect, it } from 'bun:test'
import { parseRunArgs } from '../../vx/src/cli/run.js'
import type { Lane, Picture } from '../src/components/guide/diagram.js'
import {
  COMPARE,
  LOOP_CORES,
  ONE_AT_A_TIME,
  ORCHESTRATED,
  PACKAGES,
  REBUILD_ALL,
  SECONDS,
  WRONG_ORDER,
} from '../src/components/guide/why/pictures.js'
import {
  COMPETITORS,
  TOY,
  codeBlocks,
  content,
  expectDiagrams,
  expectOnlyToyPackages,
  missing,
  packageNames,
  page,
  pictures,
  plan,
  proofLinks,
  proseWords,
  removeWorkspaces,
  sectionTitles,
  text,
  summaries,
  toyWorkspace,
} from './guide-opening.js'

const SLUG = 'guide/why'
const html = page(SLUG)
const main = content(html)
const prose = text(main)

afterAll(removeWorkspaces)

const LOOP_ORDER = ['utils', 'ui', 'api', 'app']
const PICTURES: Picture[] = [PACKAGES, WRONG_ORDER, REBUILD_ALL, ONE_AT_A_TIME, ORCHESTRATED]

/** Everything that uses `pkg`, directly or through another package, and `pkg`. */
function reachedBy(pkg: string): Set<string> {
  const reached = new Set([pkg])
  for (const p of reached) {
    for (const [user, uses] of Object.entries(TOY)) if (uses.includes(p)) reached.add(user)
  }
  return reached
}

/** Each bar lasts what the package takes, and no two bars of a lane overlap. */
function expectLane(lane: Lane): void {
  const bars = [...lane.bars].sort((a, b) => a.start - b.start)
  for (const [i, b] of bars.entries()) {
    expect({ label: b.label, took: b.end - b.start }).toEqual({
      label: b.label,
      took: SECONDS[b.label]!,
    })
    if (i > 0) expect(b.start).toBeGreaterThanOrEqual(bars[i - 1]!.end)
  }
}

describe('chapter 1, why orchestrate', () => {
  it('tells the story in its section titles', () => {
    expect(sectionTitles(main)).toEqual([
      'Four packages, one loop',
      'The wrong order breaks the build',
      'Every run rebuilds everything',
      'One build at a time leaves cores idle',
      'An orchestrator fixes all three',
      'In vx',
      'Check yourself',
    ])
  })

  it('draws a picture for each step: the packages, three failures, the fix', () => {
    expectDiagrams(main, PICTURES)
    expect(pictures(main)).toHaveLength(PICTURES.length)
  })

  it('keeps the prose to the budget', () => {
    expect(proseWords(main)).toBeLessThanOrEqual(350)
  })

  it('draws the four packages as the model wires them', () => {
    const arrows = PACKAGES.arrows!.map((a) => `${a.from}→${a.to}`).sort()
    const uses = Object.entries(TOY).flatMap(([p, deps]) => deps.map((d) => `${d}→${p}`))
    expect(arrows).toEqual(uses.sort())
  })

  it('opens with a loop in an order that works', () => {
    expect(codeBlocks(SLUG, 'sh')[0]).toBe(
      `for p in ${LOOP_ORDER.join(' ')}; do (cd packages/$p && npm run build); done\n`,
    )
    expect(
      LOOP_ORDER.every((p, i) => TOY[p]!.every((d) => LOOP_ORDER.slice(0, i).includes(d))),
    ).toBe(true)
  })

  it('fails exactly the builds alphabetical order leaves without a built dependency', () => {
    const order = Object.keys(TOY).sort()
    const built = new Set<string>()
    const expected = order.map((p, i) => {
      const ok = TOY[p]!.every((d) => built.has(d))
      if (ok) built.add(p)
      return `${i + 1}. ${p} ${ok ? 'builds ok' : 'fails danger'}`
    })
    expect(WRONG_ORDER.boxes.map((b) => `${b.label} ${b.sub} ${b.variant}`)).toEqual(expected)
    expect(expected.filter((e) => e.includes(' fails '))).toHaveLength(3)
  })

  it('marks as wasted exactly the rebuilds a change to app cannot reach', () => {
    const reached = reachedBy('app')
    expect(REBUILD_ALL.boxes.map((b) => [b.label, b.sub])).toEqual(
      LOOP_ORDER.map((p) => [p, reached.has(p) ? 'new result' : 'same again']),
    )
  })

  it('draws the loop on one core, the others idle for the whole run', () => {
    const [first, ...rest] = LOOP_CORES
    expect(first!.bars.map((b) => b.label)).toEqual(LOOP_ORDER)
    expectLane(first!)
    expect(first!.bars[0]!.start).toBe(0)
    const end = first!.bars.at(-1)!.end
    for (const lane of rest) {
      expect(lane.bars).toEqual([{ start: 0, end, label: 'idle', variant: 'muted' }])
    }
  })

  it('draws the orchestrated run by the rules, and says both finish times', () => {
    const [loop, ...cores] = COMPARE
    expect(loop!.bars.map((b) => b.label)).toEqual([...LOOP_ORDER, ...LOOP_ORDER])
    expectLane(loop!)
    let at = 0
    for (const b of loop!.bars) {
      expect(b.start).toBe(at)
      at = b.end
    }
    const reached = reachedBy('app')
    expect(loop!.bars.slice(4).map((b) => b.variant === 'danger')).toEqual(
      LOOP_ORDER.map((p) => !reached.has(p)),
    )
    for (const lane of cores) expectLane(lane)
    const bars = cores.flatMap((l) => l.bars).sort((a, b) => a.start - b.start)
    const first = bars.slice(0, 4)
    expect(first.map((b) => b.label).sort()).toEqual(Object.keys(TOY).sort())
    const end = (p: string): number => first.find((b) => b.label === p)!.end
    // Each build starts the moment the builds of the packages it uses finish.
    for (const b of first) expect(b.start).toBe(Math.max(0, ...TOY[b.label]!.map(end)))
    const done = Math.max(...first.map((b) => b.end))
    expect(bars.slice(4).map((b) => [b.label, b.start])).toEqual([...reached].map((p) => [p, done]))
    const finish = Math.max(...bars.map((b) => b.end))
    expect({ loop: at, orchestrated: finish }).toEqual({ loop: 32, orchestrated: 17 })
    expect(ORCHESTRATED.notes!.map((n) => n.text).slice(0, 2)).toEqual([
      `the loop: ${at} s`,
      `an orchestrator: ${finish} s`,
    ])
  })

  it('names only the four packages, and no other task runner', () => {
    // Chapter 1 names packages as plain words: in its pictures' boxes, and in
    // code spans that hold one name.
    const boxes = PICTURES.flatMap((p) => p.boxes)
      .map((b) => b.label.replace(/^\d+\. /, ''))
      .filter((l) => l !== 'idle')
    const spans = [...main.matchAll(/<code>([a-z][\w-]*)<\/code>/g)].map((m) => m[1]!)
    const named = [...new Set([...boxes, ...spans])].sort()
    expect(named).toEqual(['api', 'app', 'ui', 'utils'])
    expectOnlyToyPackages(main, named)
    expect(packageNames(main).filter((n) => !(n in TOY))).toEqual([])
    expect(prose).not.toMatch(COMPETITORS)
  })

  it('keeps its proofs in one collapsed list, each one landing', () => {
    const { proofs, elsewhere } = proofLinks(main)
    expect(proofs.map((l) => l.href)).toEqual([
      '../../cli/#selection',
      '../../schema/#dependson-optional',
      '../../schema/#cache-optional',
    ])
    expect(proofs.map((l) => missing(SLUG, l)).filter((m) => m !== undefined)).toEqual([])
    expect(elsewhere).toEqual([])
  })

  it('asks one question', () => {
    expect(summaries(main)).toEqual([
      'How we know this is true',
      'You change one line in ui. Which builds have new work to do?',
    ])
    expect(prose).toContain('ui, and app, which uses it. Not utils or api.')
    expect([...reachedBy('ui')].sort()).toEqual(['app', 'ui'])
  })

  it('shows the command the CLI parses as every package, and vx plans it with no order and no cache', async () => {
    const sh = codeBlocks(SLUG, 'sh')
    expect(sh).toHaveLength(2)
    expect(sh[1]).toBe('vx run build --all\n')
    const args = parseRunArgs(sh[1]!.trim().split(' ').slice(2))
    expect({ error: args.error, tasks: args.tasks, all: args.all }).toEqual({
      error: undefined,
      tasks: ['build'],
      all: true,
    })
    // Nothing declared but the command: the four builds, no edge, no cache.
    const root = await toyWorkspace(() => "{ tasks: { build: { exec: { command: 'tsc -b' } } } }")
    const planned = await plan(root, args.tasks)
    const seen = planned.tasks.map(
      (t) => `${t.node.id} [${t.node.deps.join(',')}] ${t.cacheStatus}`,
    )
    expect(seen.sort((a, b) => a.localeCompare(b))).toEqual(
      ['api', 'app', 'ui', 'utils'].map((p) => `${p}#build [] no-cache`),
    )
  })

  it('ends on the next problem', () => {
    expect(prose).toMatch(/you need a precise word for one piece of work\.$/)
  })
})
