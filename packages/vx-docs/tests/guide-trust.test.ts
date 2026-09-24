// Chapter 6, guide/trust, teaches the stale hit with a model of one task
// (demos/model/stale-hit.ts): `app#build` reads `banner.txt` without
// declaring it. The chapter may call the model a model; it may not be wrong.
// This file holds it three ways:
//
// - against a truth written out by hand, so a wrong rule cannot pass by
//   agreeing with its own render;
// - against real vx, over the same files and configs, for which keys move
//   and which runs hit, and which outputs are stale;
// - against core's own report: the frame the demo shows at step 4 is built
//   by `formatTaskBlock` over the line `parseStraceViolations` writes.
//
// Step 4 is not run for real here. It needs a sandbox, this suite runs in
// the site's sandboxed `test` task, and a sandbox cannot start inside
// another. Core's tests/sandbox-runtime.unsafe.test.ts ("the site's
// stale-hit demo, run for real") runs it and pins the same line from a real
// trace, and the chapter links that row.
//
// The chapter rows read `dist/`, which the `build` task writes.

import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { isCacheHit, planRun, run, type Logger, type TaskNode, type TaskOutcome } from '@vzn/vx'
import { parseStraceViolations } from '../../vx/src/exec/sandbox-violations.js'
import { formatTaskBlock } from '../../vx/src/orchestrator/framed-output.js'
import {
  BANNER_VERSIONS,
  REPORT_ROOT,
  SOURCE_VERSIONS,
  STALE_BANNER,
  STALE_OUTPUT,
  STALE_PROJECT,
  STALE_SOURCE,
  STALE_START,
  STALE_STEPS,
  STALE_TASK,
  STALE_TOGGLES,
  applyStaleChange,
  configSource,
  describeStaleRun,
  fileValue,
  keyCellOf,
  outputOf,
  sandboxReport,
  staleConfig,
  staleRun,
  staleRuns,
  verdictOf,
  type StaleChange,
  type StaleRun,
  type StaleState,
} from '../src/components/demos/model/stale-hit.js'
import {
  DIST,
  TOY,
  article,
  codeBlocks,
  competitorMentions,
  defining,
  diagram,
  diagrams,
  missingPage,
  missingRow,
  only,
  packagesNamed,
  page,
  pre,
  proofs,
  proseWords,
  reachableScripts,
  repoLinks,
  sectionTitles,
  siteLinks,
  tableRows,
  text,
  withoutCheckpoints,
  words,
} from './guide-page.js'

const SILENT: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
const NO_CACHE = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false }
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

// ── The truth, by hand ─────────────────────────────────────────────

const out = (source: 0 | 1, banner: 0 | 1): string =>
  `${SOURCE_VERSIONS[source]}\n${BANNER_VERSIONS[banner]}\n`

interface Truth {
  /** undefined on the first run */
  moved: boolean | undefined
  verdict: 'hit' | 'miss' | 'failed'
  stale: boolean
  output: string | undefined
  truth: string
}

const STEPS_TRUTH: Record<string, Truth> = {
  first: { moved: undefined, verdict: 'miss', stale: false, output: out(0, 0), truth: out(0, 0) },
  source: { moved: true, verdict: 'miss', stale: false, output: out(1, 0), truth: out(1, 0) },
  banner: { moved: false, verdict: 'hit', stale: true, output: out(1, 0), truth: out(1, 1) },
  sandbox: { moved: true, verdict: 'failed', stale: false, output: undefined, truth: out(1, 1) },
  declare: { moved: true, verdict: 'miss', stale: false, output: out(1, 1), truth: out(1, 1) },
}

/** After step 5, two of the demo's toggles: the sandbox off, then the file undeclared. */
const TOGGLED: StaleChange[] = ['sandbox', 'declare']
const TOGGLED_TRUTH: Truth[] = [
  { moved: true, verdict: 'miss', stale: false, output: out(1, 1), truth: out(1, 1) },
  { moved: true, verdict: 'hit', stale: true, output: out(1, 0), truth: out(1, 1) },
]

function truthOf(r: StaleRun): Truth {
  return {
    moved: r.before === undefined ? undefined : r.moved,
    verdict: r.verdict,
    stale: r.stale,
    output: r.output,
    truth: r.truth,
  }
}

/** The five steps, then `changes` applied one run at a time. */
function runsThrough(changes: readonly StaleChange[]): StaleRun[] {
  const runs = staleRuns()
  for (const c of changes) runs.push(staleRun(applyStaleChange(runs.at(-1)!.state, c), runs.at(-1)))
  return runs
}

describe('the stale-hit model', () => {
  it('walks the five steps the page names, in order', () => {
    expect(STALE_STEPS.map((s) => [s.id, s.change])).toEqual([
      ['first', undefined],
      ['source', 'edit-source'],
      ['banner', 'edit-banner'],
      ['sandbox', 'sandbox'],
      ['declare', 'declare'],
    ])
  })

  it.each(Object.keys(STEPS_TRUTH))('step %s moves, hits and goes stale as written', (id) => {
    const i = STALE_STEPS.findIndex((s) => s.id === id)
    expect(truthOf(staleRuns()[i]!)).toEqual(STEPS_TRUTH[id]!)
  })

  it('names only banner.txt as denied, and only at step 4', () => {
    expect(staleRuns().map((r) => r.denied)).toEqual([[], [], [], [STALE_BANNER], []])
  })

  it('toggled after step 5: a miss, then a stale hit on the entry step 2 stored', () => {
    const runs = runsThrough(TOGGLED)
    expect(runs.slice(5).map(truthOf)).toEqual(TOGGLED_TRUTH)
    expect(runs[6]!.key).toBe(runs[2]!.key)
    expect(runs[6]!.key).toBe(runs[1]!.key)
  })

  it("prints the config it keys on: the page's snippet evaluates to staleConfig", () => {
    for (const r of runsThrough(TOGGLED)) {
      const snippet = configSource(r.state)
      // eslint-disable-next-line typescript/no-implied-eval -- the page's snippet is the subject
      const evaluated = new Function(`return { ${snippet} }`)() as { build: unknown }
      expect(evaluated.build).toEqual(staleConfig(r.state))
    }
  })
})

// ── The model against real vx ──────────────────────────────────────

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'user.email=w@vx.local',
      '-c',
      'user.name=w',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

const projectDir = (root: string): string => path.join(root, 'packages', STALE_PROJECT)

/** The files and the config the model describes for `state`. */
async function writeState(root: string, state: StaleState): Promise<void> {
  const dir = projectDir(root)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default ${JSON.stringify({ tasks: { build: staleConfig(state) } })}\n`,
  )
  for (const file of [STALE_SOURCE, STALE_BANNER]) {
    await writeFile(path.join(dir, file), `${fileValue(state, file)}\n`)
  }
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-stale-hit-'))
  roots.push(root)
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', private: true }))
  await mkdir(projectDir(root), { recursive: true })
  await writeFile(
    path.join(projectDir(root), 'package.json'),
    JSON.stringify({ name: STALE_PROJECT, version: '0.0.0' }),
  )
  await writeState(root, STALE_START)
  // Committed, so the first key folds git's blob ids and an edit takes the
  // path a dirty file takes, as in a real checkout.
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'demo')
  return root
}

interface Seen {
  key: string
  verdict: 'hit' | 'miss'
  /** What `dist/out.txt` holds after a real run; undefined for a plan. */
  output: string | undefined
}

/** A real run of `app#build`. */
async function runOnce(root: string, cached: boolean): Promise<Seen> {
  const r = await run({
    cwd: root,
    tasks: ['build'],
    log: SILENT,
    ...(cached ? {} : { cache: NO_CACHE }),
  })
  expect(r.ok).toBe(true)
  const o = r.outcomes.find((x) => x.node.id === STALE_TASK)!
  return {
    key: o.hash!,
    verdict: isCacheHit(o.status) ? 'hit' : 'miss',
    output: await readFile(path.join(projectDir(root), STALE_OUTPUT), 'utf8'),
  }
}

/** What vx would do, without running: the key and whether the cache holds it. */
async function planOnce(root: string): Promise<Seen> {
  const plan = await planRun({ cwd: root, tasks: ['build'], log: SILENT })
  const t = plan.tasks.find((x) => x.node.id === STALE_TASK)!
  expect(['hit-local', 'miss']).toContain(t.cacheStatus)
  return { key: t.hash, verdict: t.cacheStatus === 'hit-local' ? 'hit' : 'miss', output: undefined }
}

describe('the stale-hit model against vx', () => {
  it('moves, hits and goes stale where vx does, step by step', async () => {
    const cached = await makeWorkspace()
    const fresh = await makeWorkspace()
    const model = runsThrough(TOGGLED)
    let before: Seen | undefined
    for (const [i, m] of model.entries()) {
      const label = i < STALE_STEPS.length ? `step ${i + 1}` : `toggle run ${i - 4}`
      await writeState(cached, m.state)
      await writeState(fresh, m.state)
      // The plan's key is the run's key: a planned step below is the same
      // question a real run would have asked.
      const planned = await planOnce(cached)
      // A sandboxed step cannot run in this suite (see the header), so vx is
      // asked for its plan: the key and whether the cache holds it. A miss
      // is where the sandbox would run the task, and core's unsafe row runs it.
      const seen = m.state.sandbox ? planned : await runOnce(cached, true)
      expect(seen.key).toBe(planned.key)
      expect(seen.verdict).toBe(planned.verdict)
      const truth = m.state.sandbox ? undefined : (await runOnce(fresh, false)).output
      expect({
        label,
        moved: before === undefined ? undefined : seen.key !== before.key,
        verdict: seen.verdict,
        stale: truth === undefined ? false : seen.output !== truth,
        output: seen.output,
        truth,
      }).toEqual({
        label,
        moved: m.before === undefined ? undefined : m.moved,
        // A failed run is a miss that the sandbox fails.
        verdict: m.verdict === 'failed' ? 'miss' : m.verdict,
        stale: m.stale,
        output: m.state.sandbox ? undefined : m.output,
        truth: m.state.sandbox ? undefined : m.truth,
      })
      before = seen
    }
  }, 120_000)
})

// ── The report against core's formatter ────────────────────────────

describe('the report at step 4', () => {
  it("is core's frame over the line core writes for the denied read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-stale-report-'))
    roots.push(root)
    const dir = path.join(realpathSync(root), 'packages', STALE_PROJECT)
    await mkdir(dir, { recursive: true })
    const log = path.join(root, 'strace.log')
    // What strace writes when `cat` opens the file the sandbox did not mount.
    await writeFile(
      log,
      `4242 openat(AT_FDCWD, "${STALE_BANNER}", O_RDONLY) = -1 ENOENT (No such file or directory)\n`,
    )
    const violations = await parseStraceViolations(
      log,
      { command: 'x', cwd: dir, env: {}, config: { allowRead: [] } } as never,
      { allowRead: [], denyRead: [realpathSync(root)], cwd: dir },
    )
    const step4 = staleRuns()[3]!
    const node = {
      id: STALE_TASK,
      projectName: STALE_PROJECT,
      taskName: 'build',
      config: staleConfig(step4.state),
    } as unknown as TaskNode
    const outcome: TaskOutcome = {
      node,
      status: 'failed',
      exitCode: 1,
      durationMs: 12,
      sandboxViolations: violations.length,
      sandboxViolationLines: violations.map((v) => v.line),
    }
    const frame = formatTaskBlock(node, outcome, {
      stderr: `cat: ${STALE_BANNER}: No such file or directory\n`,
    })
    expect(sandboxReport(dir, 12)).toBe(frame)
  })
})

// ── The chapter ───────────────────────────────────────────────────

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

describe('guide/trust', () => {
  const html = page('guide/trust')
  const main = article(html)
  const prose = text(main)
  const element = only(main, /<vx-stale-hit\b[^>]*>([\s\S]*?)<\/vx-stale-hit>/g)
  const staticPart = only(element, /<div class="static\b[^"]*"[^>]*>([\s\S]*)<\/div>\s*$/g)
  const table = only(staticPart, /(<table class="runs\b[\s\S]*?<\/table>)/g)

  it('tells the story in its section titles', () => {
    expect(sectionTitles(main)).toEqual([
      'A forgotten input makes a wrong hit',
      'You list the inputs; vx never guesses',
      'The sandbox turns a forgotten file into an error',
      'Four things the sandbox does not check',
      'In vx',
      'Check yourself',
    ])
  })

  it('draws three small pictures, and hosts the demo and its checkpoint', () => {
    expect(diagrams(main)).toEqual(['old-banner', 'list-not-guess', 'sandbox'])
    for (const name of diagrams(main)) {
      const figure = diagram(main, name)
      expect(figure).toMatch(/<svg\b[^>]*role="img"[^>]*aria-label="[^"]+"/)
      expect(text(only(figure, /<figcaption>([\s\S]*?)<\/figcaption>/g))).not.toBe('')
    }
    expect([...main.matchAll(/<vx-[\w-]+\b/g)].map((m) => m[0])).toEqual([
      '<vx-stale-hit',
      '<vx-checkpoint',
    ])
    expect(main).not.toContain('class="mermaid"')
  })

  it('keeps its prose short', () => {
    const n = proseWords(main)
    expect(n).toBeGreaterThan(100)
    expect(n).toBeLessThanOrEqual(350)
  })

  it('names only the four packages, and no other tool', () => {
    expect(STALE_PROJECT).toBe('app')
    const named = packagesNamed(words(withoutCheckpoints(main)))
    expect(named.filter((n) => !TOY.includes(n))).toEqual([])
    // Positive first: the reader found the chapter's own names.
    expect(named).toEqual(['app'])
    expect(competitorMentions(main)).toEqual([])
  })

  it('opens on the stale hit the demo shows at step 3', () => {
    const step3 = staleRuns()[2]!
    expect([step3.verdict, step3.moved, step3.stale]).toEqual(['hit', false, true])
    expect(configSource(STALE_START)).toContain("files: ['src/**']")
    expect(staleConfig(STALE_START)).toMatchObject({ cache: { inputs: { files: ['src/**'] } } })
    expect(prose).toContain('Its inputs list only src/**. You edit banner.txt')
    expect(prose).toContain('The key did not change, so vx handed back the old file.')
    const svg = words(only(diagram(main, 'old-banner'), /(<svg\b[\s\S]*<\/svg>)/g))
    for (const said of ['hit: old banner', 'run passes', 'but the output is wrong']) {
      expect({ said, drawn: svg.includes(said) }).toEqual({ said, drawn: true })
    }
  })

  it('ships the five runs as a static table: key, verdict, what you get, what a run writes', () => {
    const rows = tableRows(table)
    expect(rows.map((r) => [r[0], r[2], r[3], r[4]])).toEqual([
      ['1. First run', 'miss: runs', flat(out(0, 0)), flat(out(0, 0))],
      ['2. Edit src/index.ts', 'miss: runs', flat(out(1, 0)), flat(out(1, 0))],
      ['3. Edit banner.txt', 'stale hit', flat(out(1, 0)), flat(out(1, 1))],
      ['4. Turn on exec.sandbox', 'fails: sandbox violation', 'none: it failed', flat(out(1, 1))],
      ['5. Declare banner.txt', 'miss: runs', flat(out(1, 1)), flat(out(1, 1))],
    ])
    // A key that did not move shows one digest; one that moved shows two.
    expect(rows.map((r) => r[1]!.replace(/[0-9a-f]{7}/g, 'K'))).toEqual([
      'K (new)',
      'K → K',
      'K (same)',
      'K → K',
      'K → K',
    ])
  })

  it('renders what the model says, so the element and the fallback agree', () => {
    const runs = staleRuns()
    expect(tableRows(table)).toEqual(
      runs.map((r, i) => [
        `${i + 1}. ${STALE_STEPS[i]!.title}`,
        keyCellOf(r),
        verdictOf(r),
        flat(outputOf(r)),
        flat(r.truth),
      ]),
    )
    const story = only(staticPart, /<ol class="story\b[^"]*"[^>]*>([\s\S]*?)<\/ol>/g)
    expect([...story.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!))).toEqual(
      runs.map((r, i) => `${STALE_STEPS[i]!.title}. ${describeStaleRun(r)}`),
    )
  })

  it('says the stale hit and the failure plainly, in the static sentences', () => {
    const story = only(staticPart, /<ol class="story\b[^"]*"[^>]*>([\s\S]*?)<\/ol>/g)
    const items = [...story.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!))
    expect(items[2]).toBe(
      'Edit banner.txt. The key did not move. The run hits and replays an output built before ' +
        'the edit: a stale hit, on a green run.',
    )
    expect(items[3]).toBe(
      'Turn on exec.sandbox. The key moved. The run misses, and the sandbox denies the read of ' +
        'banner.txt, so the task fails and nothing is stored.',
    )
  })

  it('shows the report vx prints at step 4, for the illustrative path', () => {
    const reports = [...element.matchAll(/<pre class="report\b[^"]*"[^>]*>([\s\S]*?)<\/pre>/g)]
    expect(reports).toHaveLength(2)
    for (const r of reports) {
      expect(pre(r[1]!)).toBe(sandboxReport(`${REPORT_ROOT}/packages/${STALE_PROJECT}`, 12))
    }
    expect(pre(reports[0]![1]!)).toContain(`SANDBOX VIOLATIONS (1)`)
    expect(pre(reports[0]![1]!)).toContain(
      `openat(banner.txt) = -1 ENOENT  [/repo/packages/app/banner.txt]`,
    )
  })

  it('keeps the controls that need JavaScript hidden in the static page', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
    expect(only(element, /<div class="live\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect(only(element, /<div class="static\b[^"]*"([^>]*)>/g).trim()).toBe('')
    expect(
      [...element.matchAll(/<button\b[^>]*data-step="([^"]+)" aria-pressed="(\w+)"/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    ).toEqual(['first true', 'source false', 'banner false', 'sandbox false', 'declare false'])
    expect(
      [...element.matchAll(/<button\b[^>]*data-toggle="([^"]+)" aria-pressed="(\w+)"/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    ).toEqual(STALE_TOGGLES.map((t) => `${t.change} false`))
  })

  it('says in its caption that the keys and the path are illustrative', () => {
    const figures = [...main.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
      .map((m) => m[1]!)
      .filter((f) => f.includes('<vx-stale-hit'))
    expect(figures).toHaveLength(1)
    expect(text(only(figures[0]!, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).toBe(
      'A model of one task, not vx itself. The keys are digests the model computes, shortened ' +
        'to seven hex digits, and the path in the report is an example. Which keys move and ' +
        'which runs hit is what vx does on the same files, and the report is the one vx ' +
        'prints; tests run vx to check both.',
    )
  })

  it("loads the element's module from the page's own scripts, free of Bun, process and node:", () => {
    const names = defining(html, 'vx-stale-hit')
    expect(names).toHaveLength(1)
    // What the element module reaches from its own chunk, not the page's
    // other scripts: those are held by their own widgets' rows.
    const own = reachableScripts(`<script src="/_astro/${names[0]}"></script>`)
    for (const name of own) {
      const body = readFileSync(path.join(DIST, '_astro', name), 'utf8')
      expect({
        name,
        bun: /\bBun\./.test(body),
        process: /\bprocess\./.test(body),
        node: /["'`]node:/.test(body),
      }).toEqual({ name, bun: false, process: false, node: false })
    }
  })

  it('draws the denial the demo reports at step 4', () => {
    const step4 = staleRuns()[3]!
    expect([step4.verdict, step4.denied]).toEqual(['failed', [STALE_BANNER]])
    const svg = words(only(diagram(main, 'sandbox'), /(<svg\b[\s\S]*<\/svg>)/g))
    expect(svg).toContain('task fails: denied banner.txt — nothing saved')
    expect(prose).toContain('Reading banner.txt fails, and the error names it.')
  })

  it('names four things the sandbox does not check, in plain words', () => {
    const section = only(
      main,
      /<h2\b[^>]*>Four things the sandbox does not check<\/h2>[\s\S]*?(<ul>[\s\S]*?<\/ul>)/g,
    )
    const items = [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!))
    expect(items).toEqual([
      'Environment variables. List them in cache.inputs.env.',
      'Tools on your machine, such as the Node version.',
      'Installed packages in node_modules, including your own linked packages such as ui. This is a known gap.',
      'Other systems. It runs on Linux and macOS, and on Windows only under WSL.',
    ])
  })

  it('places the correctness checkpoint as its one check', () => {
    const checkpoint = only(main, /<vx-checkpoint\b[^>]*>([\s\S]*?)<\/vx-checkpoint>/g)
    expect(only(checkpoint, /<fieldset class="form\b[^"]*"[^>]*data-checkpoint="([^"]+)"/g)).toBe(
      'correctness',
    )
    const { rest } = proofs(main)
    // No other check than the checkpoint.
    expect([...withoutCheckpoints(rest).matchAll(/<details>/g)]).toEqual([])
  })

  it('keeps test links out of the prose, in one collapsed list that stands on real rows', () => {
    const { list, rest } = proofs(main)
    expect(repoLinks(rest)).toEqual([])
    const claims = repoLinks(list)
    expect(claims.map((c) => c.label)).toEqual([
      'vx never guesses a task’s input files',
      'This chapter’s build fails on banner.txt in a real sandbox, and passes once it is listed',
      'A failed sandboxed task is not saved',
      'A run of hits never starts the sandbox',
      'node_modules is readable without being listed',
      'So is a linked package of your own',
    ])
    expect(claims.map(missingRow).filter((m) => m !== undefined)).toEqual([])
    expect(siteLinks(rest, 'guide/trust')).toEqual([
      'learn/glossary/#cache-hit-miss-and-stale-hit',
      'learn/glossary/#hermeticity-and-sandboxing',
    ])
    const inList = siteLinks(list, 'guide/trust')
    expect(inList).toEqual([
      'guides/environment-variables/#the-two-lists',
      'guides/sandboxing/#requirements--platform-support',
    ])
    const site = siteLinks(main, 'guide/trust')
    expect(site.map(missingPage).filter((m) => m !== undefined)).toEqual([])
  })

  it('shows the last step of the demo as a config the schema defines', () => {
    const blocks = codeBlocks('trust')
    expect(blocks).toHaveLength(1)
    const declared = staleRuns().at(-1)!.state
    expect(blocks[0]).toBe(
      [
        "import { defineProject } from '@vzn/vx'",
        '',
        'export default defineProject({',
        '  tasks: {',
        '    build: {',
        '      exec: {',
        "        command: 'mkdir -p dist && cat src/index.ts banner.txt > dist/out.txt',",
        "        sandbox: { allow: { read: ['src/**', 'banner.txt'], write: ['dist/'] } },",
        '      },',
        '      cache: {',
        "        inputs: { files: ['src/**', 'banner.txt'] },",
        "        outputs: { files: ['dist/**'] },",
        '      },',
        '    },',
        '  },',
        '})',
        '',
      ].join('\n'),
    )
    // The block is the model's config at step 5, written as a project.
    expect(staleConfig(declared)).toEqual({
      exec: {
        command: 'mkdir -p dist && cat src/index.ts banner.txt > dist/out.txt',
        sandbox: { allow: { read: ['src/**', 'banner.txt'], write: ['dist/'] } },
      },
      cache: {
        inputs: { files: ['src/**', 'banner.txt'] },
        outputs: { files: ['dist/**'] },
      },
    })
    const schema = text(page('schema'))
    expect(schema).toContain('Opt-in per task — omit it and the command runs unsandboxed.')
    expect(schema).toContain(
      'An undeclared read or write fails the task, and a failed task is never cached.',
    )
  })
})
