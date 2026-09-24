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
import * as P from '../src/components/guide/trust/pictures.js'
import {
  DIST,
  chapterShape,
  content,
  defining,
  only,
  page,
  pre,
  prose as authored,
  reachableScripts,
  section,
  sourceBlocks,
  tableRows,
  text,
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

chapterShape({
  slug: 'trust',
  titles: [
    'A forgotten input makes a wrong hit',
    'You list the inputs; vx never guesses',
    'The sandbox turns a forgotten file into an error',
    'Four things the sandbox does not check',
  ],
  pictures: [P.oldBanner, P.listNotGuess, P.sandbox, P.unchecked],
  rows: {
    'packages/vx/tests/config.test.ts': [
      'requires cache.inputs.files — the one declaration vx will not infer',
    ],
    'packages/vx/tests/sandbox-runtime.unsafe.test.ts': [
      'the undeclared read fails with one line naming banner.txt; declaring it passes',
      'failed sandboxed task is NOT cached (re-runs next invocation)',
      'a run whose sandboxed tasks are all hits never starts the sandbox',
      'installed dependencies are readable without being declared inputs',
      'an unkeyed sibling is withheld and the read reported, with the hint (root link)',
    ],
  },
})

describe('guide/trust', () => {
  const html = page('guide/trust')
  const main = content(html)
  const prose = text(main)
  const element = only(main, /<vx-stale-hit\b[^>]*>([\s\S]*?)<\/vx-stale-hit>/g)
  const staticPart = only(element, /<div class="static\b[^"]*"[^>]*>([\s\S]*)<\/div>\s*$/g)
  const table = only(staticPart, /(<table class="runs\b[\s\S]*?<\/table>)/g)

  it('hosts the demo and its checkpoint, and no other widget', () => {
    expect([...main.matchAll(/<vx-[\w-]+\b/g)].map((m) => m[0])).toEqual([
      '<vx-stale-hit',
      '<vx-checkpoint',
    ])
  })

  it('draws the demo’s task in its one package', () => {
    expect(STALE_PROJECT).toBe('app')
    expect(P.sandbox.boxes.map((b) => b.label)).toContain(`${STALE_PROJECT}#build`)
  })

  it('opens on the stale hit the demo shows at step 3', () => {
    const step3 = staleRuns()[2]!
    expect([step3.verdict, step3.moved, step3.stale]).toEqual(['hit', false, true])
    expect(configSource(STALE_START)).toContain("files: ['src/**']")
    expect(staleConfig(STALE_START)).toMatchObject({ cache: { inputs: { files: ['src/**'] } } })
    expect(prose).toContain('Its inputs list only src/**. You edit banner.txt')
    expect(prose).toContain('The key did not change, so vx handed back the old file.')
    const drawn = [
      ...P.oldBanner.boxes.map((b) => b.label),
      ...P.oldBanner.notes!.map((n) => n.text),
    ].join(' ')
    for (const said of ['hit: old banner', 'run passes', 'but the output is wrong']) {
      expect({ said, drawn: drawn.includes(said) }).toEqual({ said, drawn: true })
    }
  })

  it('ships the five runs as a static table: key, verdict, what you get, what it should be', () => {
    const head = [
      ...only(table, /<thead\b[^>]*>([\s\S]*?)<\/thead>/g).matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g),
    ]
    expect(head.map((m) => text(m[1]!))).toEqual([
      'Step',
      'Key',
      'This run',
      'dist/out.txt',
      'Should be',
    ])
    const rows = tableRows(table)
    expect(rows.map((r) => [r[0], r[2], r[3], r[4]])).toEqual([
      ['1. First run', 'runs', flat(out(0, 0)), flat(out(0, 0))],
      ['2. Edit src/index.ts', 'runs', flat(out(1, 0)), flat(out(1, 0))],
      ['3. Edit banner.txt', 'stale hit', flat(out(1, 0)), flat(out(1, 1))],
      ['4. Turn on the sandbox', 'fails', 'nothing', flat(out(1, 1))],
      ['5. List banner.txt', 'runs', flat(out(1, 1)), flat(out(1, 1))],
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
  })

  // The page's sentences are the live region's now; the static table says
  // the same in its verdict column.
  it('says each run plainly, in the live sentence the element speaks', () => {
    expect(staleRuns().map(describeStaleRun)).toEqual([
      'The cache is empty, so the task runs and vx saves its output.',
      'The key changed, so the task runs and vx saves its output.',
      'The key did not change, so vx hands back the old file. It is wrong, and the run passes.',
      'The key changed. The sandbox hides banner.txt, so the task fails and vx saves nothing.',
      'The key changed, so the task runs and vx saves its output.',
    ])
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
    expect(element).not.toContain('data-toggle')
  })

  it('says in one line that the keys come from a model tests hold to vx', () => {
    const figures = [...main.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
      .map((m) => m[1]!)
      .filter((f) => f.includes('<vx-stale-hit'))
    expect(figures).toHaveLength(1)
    expect(text(only(figures[0]!, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).toBe(
      'The keys come from a model of this task. Tests check it against real vx.',
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
    expect(P.sandbox.notes!.map((n) => n.text)).toContain(
      `task fails: denied ${STALE_BANNER} — nothing saved`,
    )
    expect(prose).toContain('Reading banner.txt fails, and the error names it.')
  })

  it('draws four things the sandbox does not check, outside its wall, in plain words', () => {
    expect(P.UNCHECKED).toEqual([
      ['env variables', 'list in inputs.env'],
      ['your tools', 'e.g. Node version'],
      ['node_modules', 'but a linked ui is'],
      ['Windows', 'only under WSL'],
    ])
    // Each outside the sandbox's frame, inside the "not checked" one.
    const [wall, outside] = P.unchecked.frames!
    const four = P.unchecked.boxes.filter((b) => b.tone === 'warn')
    expect(four.map((b) => [b.label, b.sub])).toEqual(P.UNCHECKED)
    for (const b of four) {
      expect(b.x).toBeGreaterThan(wall!.x + wall!.w)
      expect([b.x >= outside!.x, b.x + b.w! <= outside!.x + outside!.w]).toEqual([true, true])
    }
    // The picture is the section: no list beside it.
    expect(section(main, 'four-things-the-sandbox-does-not-check')).not.toContain('<ul>')
    // The claims it draws are the ones the proof list links.
    expect(prose).toContain('node_modules is readable without being listed')
    expect(prose).toContain('An environment variable is in the key only when listed')
  })

  it('places the correctness checkpoint as its one check', () => {
    const checkpoint = only(main, /<vx-checkpoint\b[^>]*>([\s\S]*?)<\/vx-checkpoint>/g)
    expect(only(checkpoint, /<fieldset class="form\b[^"]*"[^>]*data-checkpoint="([^"]+)"/g)).toBe(
      'correctness',
    )
    // No other check than the checkpoint.
    expect(authored(section(main, 'check-yourself'))).not.toContain('<details')
  })

  it('shows the last step of the demo as a config the schema defines', () => {
    const blocks = sourceBlocks('trust')
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
