// The site's terminal samples are pasted from real runs, and a sample
// drifts the day the output changes: the old troubleshooting `vx why` block
// and the agents page's diff entry showed `a853d874…` where vx prints the
// whole blob id, and a previous run that never happened (2026-10-23). Each
// sample here is the output of the run the page describes, on one fixture.
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { TaskOutcome } from '../src/graph/outcome.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { formatFrameClose, formatFrameOpen } from '../src/report/framed-output.js'
import { BIN } from './helpers/vx.js'

const SRC = path.resolve(import.meta.dir, '..', 'src')
const GUIDES = path.resolve(import.meta.dir, '../../../private/vx-docs/src/content/docs/docs')
// The pages show a developer's terminal: CI's own CI=true would pick the
// CI output view.
const { CI: _ci, GITHUB_ACTIONS: _gha, ...HOST_ENV } = process.env
const ENV = {
  ...HOST_ENV,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  NO_COLOR: '1',
}
// An `ansi` sample is pasted with vx's colours (2026-10-26: never
// plain white output on the site), so it is compared escape for escape.
const { NO_COLOR: _nc, ...UNCOLOURED } = ENV
const COLOUR = { ...UNCOLOURED, FORCE_COLOR: '1' }
let root = ''

function vx(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root, env: ENV })
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

function vxColour(...args: string[]): { code: number | null; stderr: string } {
  const r = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root, env: COLOUR })
  return { code: r.exitCode, stderr: r.stderr.toString() }
}

/** The fenced block after the one whose line is `command`. */
function printed(page: string, command: string): string {
  const at = page.indexOf(`\n${command}\n`)
  expect(at).toBeGreaterThan(-1)
  const after = page.indexOf('```', page.indexOf('```', at) + 3)
  return /```[^\n]*\n([\s\S]*?)\n```/.exec(page.slice(after))![1]!
}

function git(...args: string[]): void {
  expect(Bun.spawnSync({ cmd: ['git', ...args], cwd: root, env: ENV }).exitCode).toBe(0)
}

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
/** A coloured sample's text, to hold against a run with colour off. */
const plain = (text: string): string => text.replace(SGR, '')

/** What changes run to run: the run id, the times, the keys. */
function stable(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<run>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<time>')
    .replace(/\bkey [0-9a-f]{16}\b/g, 'key <key>')
    .trimEnd()
}

/** The fenced block holding `marker`, its opening `$ ` line dropped, dedented. */
function sample(page: string, marker: string): string {
  const at = page.indexOf(marker)
  expect(at).toBeGreaterThan(-1)
  const open = page.lastIndexOf('```', at)
  const body = /```[^\n]*\n([\s\S]*?)\n\s*```/.exec(page.slice(open))![1]!
  const lines = body.split('\n')
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length))
  return lines
    .map((l) => l.slice(indent))
    .filter((l, i) => i > 0 || !l.startsWith('$ '))
    .join('\n')
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-site-transcripts-'))
  await mkdir(path.join(root, '.vx'))
  await mkdir(path.join(root, 'packages/app/src'), { recursive: true })
  await writeFile(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  await writeFile(
    path.join(root, 'packages/app/vx.config.mjs'),
    `export default {
  name: '@demo/app',
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cat src/a.ts > dist/a.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
}
`,
  )
  await writeFile(path.join(root, 'packages/app/src/a.ts'), '1\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'one')
  expect(vx('lock').code).toBe(0)
  expect(vx('run', '@demo/app#build').code).toBe(0)
  await writeFile(path.join(root, 'packages/app/src/a.ts'), '2\n')
  expect(vx('run', '@demo/app#build').code).toBe(0)
})

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

describe('the guides show what vx prints', () => {
  it("the agents page's roots sample has vx why --format json's shape", () => {
    const page = readFileSync(path.join(GUIDES, '..', 'docs', 'agents.mdx'), 'utf8')
    const block = /jq '\.roots'\n```\n\n```json\n([\s\S]*?)\n```/.exec(page)![1]!
    const roots = JSON.parse(block) as { chain: string[]; entries: Record<string, string>[] }[]
    const why = JSON.parse(vx('why', '@demo/app#build', '--format', 'json').stdout) as {
      diff: { entries: Record<string, string>[] }
    }
    expect(Object.keys(roots[0]!).sort()).toEqual(['chain', 'entries'])
    const entry = roots[0]!.entries[0]!
    expect(Object.keys(entry).sort()).toEqual(Object.keys(why.diff.entries[0]!).sort())
    // vx prints the whole blob id, never a short one (the 2026-10-23 drift).
    expect(entry['before']).toMatch(/^[0-9a-f]{40}$/)
    expect(entry['after']).toMatch(/^[0-9a-f]{40}$/)
  })

  it("the agents page's refusal line is what --dry --format json prints", () => {
    const page = readFileSync(path.join(GUIDES, '..', 'docs', 'agents.mdx'), 'utf8')
    const line = /^\{"ok":false.*\}$/m.exec(page)![0]
    const run = vx('run', 'biuld', '--all', '--dry', '--format', 'json')
    expect(run.code).toBe(1)
    expect(run.stdout.trim()).toBe(line)
  })

  // On the page's own shop (ui, web, admin, api), so the suggestion is a
  // project the reader has.
  it("running tasks' filter typo is what vx prints", async () => {
    const page = readFileSync(path.join(GUIDES, 'running-tasks.mdx'), 'utf8')
    const shop = await mkdtemp(path.join(os.tmpdir(), 'vx-site-shop-'))
    try {
      await mkdir(path.join(shop, '.vx'))
      await writeFile(path.join(shop, '.vx/workspace.mjs'), 'export default {}\n')
      for (const name of ['ui', 'web', 'admin', 'api']) {
        await mkdir(path.join(shop, 'packages', name), { recursive: true })
        await writeFile(
          path.join(shop, 'packages', name, 'vx.config.mjs'),
          `export default {
  name: '@demo/${name}',
  tasks: { build: { exec: { command: 'true' } } },
}
`,
        )
      }
      const at = (...cmd: string[]) => Bun.spawnSync({ cmd, cwd: shop, env: COLOUR })
      expect(at('git', 'init', '-q', '-b', 'main').exitCode).toBe(0)
      expect(at('git', 'add', '-A').exitCode).toBe(0)
      expect(at('git', 'commit', '-qm', 'one').exitCode).toBe(0)
      expect(at(process.execPath, BIN, 'lock').exitCode).toBe(0)
      const run = at(process.execPath, BIN, 'run', 'build', '--filter', '@demo/wbe')
      expect(run.exitCode).toBe(1)
      expect(printed(page, 'vx run build --filter @demo/wbe')).toBe(run.stderr.toString().trim())
    } finally {
      await rm(shop, { recursive: true, force: true })
    }
  })
})

// The Guides' one-task pages, on a two-project fixture: ui, and web, whose
// build waits on ui's. Each page's command block is followed by the block
// vx prints for it.
describe('the one-task guides show what vx prints', () => {
  let two = ''
  let locked = ''
  const run = (...args: string[]) => {
    const r = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: two, env: ENV })
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  }
  const runColour = (...args: string[]) => {
    const r = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: two, env: COLOUR })
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  }
  const sh = (...args: string[]) =>
    expect(Bun.spawnSync({ cmd: args, cwd: two, env: ENV }).exitCode).toBe(0)
  const guide = (rel: string) => readFileSync(path.join(GUIDES, rel), 'utf8')
  const config = (name: string, dependsOn: string) => `export default {
  name: '@demo/${name}',
  tasks: {
    build: {
      dependsOn: [${dependsOn}],
      exec: { command: 'mkdir -p dist && cat src/index.ts > dist/index.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
}
`

  beforeAll(async () => {
    two = await mkdtemp(path.join(os.tmpdir(), 'vx-site-guides-'))
    await mkdir(path.join(two, '.vx'))
    await writeFile(path.join(two, '.vx/workspace.mjs'), 'export default {}\n')
    await writeFile(path.join(two, '.gitignore'), 'dist\n')
    for (const [name, dep] of [
      ['ui', ''],
      ['web', "'@demo/ui#build'"],
    ] as const) {
      await mkdir(path.join(two, `packages/${name}/src`), { recursive: true })
      await writeFile(path.join(two, `packages/${name}/vx.config.ts`), config(name, dep))
      await writeFile(path.join(two, `packages/${name}/src/index.ts`), '1\n')
    }
    sh('git', 'init', '-q', '-b', 'main')
    const lock = runColour('lock')
    expect(lock.code).toBe(0)
    locked = (lock.stdout + lock.stderr).trim()
    sh('git', 'add', '-A')
    sh('git', 'commit', '-qm', 'one')
    expect(run('run', 'build', '--all').code).toBe(0)
    sh('git', 'checkout', '-qb', 'feature')
    await writeFile(path.join(two, 'packages/ui/src/index.ts'), '2\n')
  })

  afterAll(async () => {
    if (two !== '') await rm(two, { recursive: true, force: true })
  })

  it("the workspace page's vx lock line", () => {
    const page = readFileSync(path.join(GUIDES, '..', 'docs', 'workspace.mdx'), 'utf8')
    expect(printed(page, 'vx lock')).toBe(locked)
  })

  it('check-the-lock: a drifted config, then a current lock', async () => {
    const page = readFileSync(path.join(GUIDES, '..', 'docs', 'ci.mdx'), 'utf8')
    const file = path.join(two, 'packages/ui/vx.config.ts')
    await writeFile(file, config('ui', '').replace("'src/**'", "'src/**', 'package.json'"))
    const drift = runColour('lock', '--check')
    await writeFile(file, config('ui', ''))
    const ok = runColour('lock', '--check')
    expect(drift.code).toBe(1)
    expect(printed(page, 'vx lock --check')).toBe(drift.stderr.trim())
    expect(ok.code).toBe(0)
    expect(page).toContain(`\n${(ok.stdout + ok.stderr).trim()}\n`)
  })

  it('why-a-task-missed: a changed file, then a changed upstream', () => {
    expect(run('run', 'build', '--all').code).toBe(0)
    const page = guide('caching/why-a-task-missed.mdx')
    // The page shows the coloured screen: its panels, as a terminal draws them.
    for (const task of ['@demo/ui#build', '@demo/web#build']) {
      const r = runColour('why', task)
      expect(r.code).toBe(0)
      expect(stable(plain(printed(page, `vx why ${task}`)))).toBe(stable(plain(r.stdout)))
    }
  })
})

// The newcomer guides, on a workspace as `vx init` leaves it: a bun()
// lockfile plugin, so '^build' follows package.json, and two pipelines.
// A run's rows carry times, CPU and memory, so those lines are held
// with their figures blanked; the rest are held as printed.
describe('the newcomer guides show what vx prints', () => {
  let ws = ''
  const at = (cwd: string, env: Record<string, string | undefined>, args: string[]) => {
    const r = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd, env })
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
  }
  const run = (...args: string[]) => at(ws, ENV, args)
  const runColour = (...args: string[]) => at(ws, COLOUR, args)
  const sh = (...args: string[]) => Bun.spawnSync({ cmd: args, cwd: ws, env: ENV }).exitCode
  const guide = (rel: string) => readFileSync(path.join(GUIDES, rel), 'utf8')
  /** A line with its timings, CPU and memory blanked and its spacing folded. */
  const loose = (line: string) =>
    plain(line)
      .replace(/[~+−-]?\d+(?:\.\d+)?(?:ms|s|%|[KMG]?B)(?=[\s)]|$)/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
  /** Each line of the sample is a line vx printed, and the sample keeps vx's colours. */
  const holds = (sample: string, out: string) => {
    expect(sample).toContain(String.fromCharCode(27))
    const printedLines = out.split('\n').map(loose)
    for (const line of sample.split('\n').filter((l) => plain(l).trim() !== ''))
      expect(printedLines).toContain(loose(line))
  }
  const plan = (text: string) =>
    stable(plain(text))
      .split('\n')
      .map((l) => l.replace(/ +~[\d.]+m?s/g, ' ~<t>').trimEnd())
      .join('\n')
  const config = (test: string) => `export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cp src/index.ts dist/index.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
    test: { exec: { command: "${test}" } },
    e2e: { exec: { command: 'sleep 5' } },
  },
}
`
  const ui = () => path.join(ws, 'packages/ui/vx.config.mjs')

  beforeAll(async () => {
    ws = await mkdtemp(path.join(os.tmpdir(), 'vx-site-newcomer-'))
    await mkdir(path.join(ws, '.vx'))
    await mkdir(path.join(ws, 'node_modules/@vzn'), { recursive: true })
    await symlink(
      path.resolve(import.meta.dir, '..', '..', 'vx-lockfile'),
      path.join(ws, 'node_modules/@vzn/vx-lockfile'),
    )
    await writeFile(
      path.join(ws, '.vx/workspace.mjs'),
      `import { bun } from '@vzn/vx-lockfile'

export default {
  plugins: [bun()],
  pipelines: {
    pr: { tasks: ['build', 'test'], affected: true },
    main: { tasks: ['build', 'test'] },
  },
}
`,
    )
    await writeFile(path.join(ws, '.gitignore'), 'node_modules\ndist\n')
    await writeFile(
      path.join(ws, 'package.json'),
      '{ "name": "demo", "private": true, "workspaces": ["packages/*"] }\n',
    )
    const web = { '@demo/ui': 'workspace:*' }
    await writeFile(
      path.join(ws, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          '': { name: 'demo' },
          'packages/ui': { name: '@demo/ui', version: '1.0.0' },
          'packages/web': { name: '@demo/web', version: '1.0.0', dependencies: web },
        },
        packages: {
          '@demo/ui': ['@demo/ui@workspace:packages/ui'],
          '@demo/web': ['@demo/web@workspace:packages/web'],
        },
      }),
    )
    for (const [name, test] of [
      ['ui', "echo 'expected 2, got 1' && exit 1"],
      ['web', 'sleep 1 && echo ok'],
    ] as const) {
      await mkdir(path.join(ws, `packages/${name}/src`), { recursive: true })
      await writeFile(
        path.join(ws, `packages/${name}/package.json`),
        JSON.stringify({
          name: `@demo/${name}`,
          version: '1.0.0',
          ...(name === 'web' ? { dependencies: web } : {}),
        }),
      )
      await writeFile(path.join(ws, `packages/${name}/vx.config.mjs`), config(test))
      await writeFile(path.join(ws, `packages/${name}/src/index.ts`), '1\n')
    }
    expect(sh('git', 'init', '-q', '-b', 'main')).toBe(0)
    expect(run('lock').code).toBe(0)
    expect(sh('git', 'add', '-A')).toBe(0)
    expect(sh('git', 'commit', '-qm', 'one')).toBe(0)
  })

  afterAll(async () => {
    if (ws !== '') await rm(ws, { recursive: true, force: true })
  })

  it('caching: an output that matched nothing fails the task', async () => {
    const page = readFileSync(path.join(GUIDES, '..', 'docs', 'caching.mdx'), 'utf8')
    await writeFile(
      ui(),
      config("echo 'expected 2, got 1' && exit 1").replace("'dist/**'", "'dist/main.js'"),
    )
    expect(run('lock').code).toBe(0)
    const r = runColour('run', '@demo/ui#build')
    expect(sh('git', 'checkout', '-q', '--', '.')).toBe(0)
    expect(run('lock').code).toBe(0)
    expect(r.code).toBe(1)
    // The page runs vite; the fixture copies a file. vx's own lines are held.
    const own = printed(page, 'vx run @demo/ui#build')
      .split('\n')
      .filter((l) => /^(?:\[vx\]|└─)/.test(plain(l)))
    expect(own.length).toBe(2)
    holds(own.join('\n'), r.out)
  })

  it('run-a-pipeline: pr on a branch runs what the change reaches', async () => {
    const page = guide('ci/run-a-pipeline.mdx')
    // The page's history has timed web's test once: ui's fails.
    expect(run('run', 'test', '--all').code).toBe(1)
    expect(run('run', 'build', '--all').code).toBe(0)
    expect(sh('git', 'checkout', '-qb', 'feature')).toBe(0)
    await writeFile(path.join(ws, 'packages/web/src/index.ts'), '2\n')
    expect(sh('git', 'commit', '-qam', 'web')).toBe(0)
    const r = run('pipeline', 'pr', '--dry')
    expect(sh('git', 'checkout', '-q', 'main')).toBe(0)
    expect(r.code).toBe(0)
    expect(plan(printed(page, 'vx pipeline pr --dry'))).toBe(plan(r.out))
  })

  it('fix-a-lock-conflict: a run refuses the merged lock, vx lock writes it again', async () => {
    const page = readFileSync(path.join(GUIDES, '..', 'docs', 'ci.mdx'), 'utf8')
    const edit = async (file: string) => {
      await writeFile(
        ui(),
        config("echo 'expected 2, got 1' && exit 1").replace("'src/**'", `'src/**', '${file}'`),
      )
      expect(run('lock').code).toBe(0)
      expect(sh('git', 'commit', '-qam', file)).toBe(0)
    }
    expect(sh('git', 'checkout', '-qb', 'other')).toBe(0)
    await edit('tsconfig.json')
    expect(sh('git', 'checkout', '-q', 'main')).toBe(0)
    await edit('README.md')
    expect(sh('git', 'merge', '-q', 'other')).not.toBe(0)
    const refused = runColour('run', 'build', '--all')
    expect(refused.code).toBe(1)
    expect(printed(page, 'vx run build --all')).toBe(refused.out.trim())
    expect(sh('git', 'checkout', '--theirs', 'packages/ui/vx.config.mjs')).toBe(0)
    const locked = runColour('lock')
    expect(locked.code).toBe(0)
    expect(sample(page, 'project configs →')).toBe(locked.out.trim())
  })
})

describe("the caching page's verdict table", () => {
  it('every row is a verdict vx why can print', async () => {
    const page = readFileSync(path.join(GUIDES, '..', 'docs', 'caching.mdx'), 'utf8')
    const at = page.indexOf('Every verdict')
    const table = page.slice(at, page.indexOf('</Deeper>', at))
    const rows = [...table.matchAll(/^- (`+) ?(.+?) ?\1<br\/>/gm)].map((m) => m[2]!)
    expect(rows.length).toBeGreaterThan(10)
    // Every string literal under history/ and the why verb, its `${…}`
    // parts as any text.
    const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const files = [
      ...(await readdir(path.join(SRC, 'history'))).map((f) => path.join(SRC, 'history', f)),
      path.join(SRC, 'cli', 'why.ts'),
    ]
    const literals: RegExp[] = []
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(
        /'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
      )) {
        // An interpolated group reads `(…)` on the page, as site-samples' pin has it.
        const raw = (m[1] ?? m[2]!)
          .replace(/\\(.)/g, '$1')
          .replace(/\([^()]*\$\{[^}]*\}[^()]*\)/g, '(…)')
        if (raw.replace(/\$\{[^{}]*\}/g, '').length > 24)
          literals.push(
            new RegExp(
              `^${raw
                .split(/\$\{[^{}]*\}/)
                .map(escape)
                .join('.+')}$`,
            ),
          )
      }
    }
    // The changed verdict lists what moved after its literal prefix.
    expect(readFileSync(path.join(SRC, 'cli', 'why.ts'), 'utf8')).toContain(
      '`cache key changed: ${',
    )
    const unknown = rows
      .filter((r) => !r.startsWith('cache key changed: '))
      .filter((r) => {
        return !literals.some((re) => re.test(r))
      })
    expect(unknown).toEqual([])
  })
})

// The sandbox needs bwrap, so the guide's two failures are rendered by the
// frame renderer from the records the sandbox writes: strace's
// `access(<abs>) = -1 ENOENT  [<abs>]` and sandbox-runtime's `mkdir(<abs>) =
// a write no grant covers  [<abs>]`. Pasted from a real `vite build` run
// (2026-11-23); the tabs once left out the frame's lines and the write's path.
describe("the sandboxing guide's failures", () => {
  const command = 'vite build'
  const node = {
    id: '@demo/web#build',
    projectName: '@demo/web',
    taskName: 'build',
    config: { exec: { command } },
  } as unknown as TaskNode
  // The live frame a terminal shows for one task: its opening line, the
  // tool's output as it streamed, then the violations and the close.
  const frame = (records: string[], fix: Record<string, string[]>, stderr: string): string =>
    [
      formatFrameOpen(node),
      stderr,
      formatFrameClose(node, {
        node,
        status: 'failed',
        exitCode: 1,
        durationMs: 12,
        sandbox: { violations: records.length, lines: records, fix },
      } as TaskOutcome),
    ].join('\n')
  const page = readFileSync(path.join(GUIDES, '..', 'docs', 'sandboxing.mdx'), 'utf8')
  // The page shows a recorded coloured run: compared without its colours,
  // its typed command line, and with the run's own duration made stable.
  const tab = (title: string): string =>
    plain(sample(page.slice(page.indexOf(title)), 'vx run @demo/web#build'))
      .replace(/^\$ vx run @demo\/web#build\n\n/, '')
      .replace(/\(\d+ms\)/g, '(12ms)')
  const web = '/repo/packages/web'

  it('are the frames vx draws', () => {
    expect(page).toContain(`command: '${command}'`)
    expect(tab('title="1. The build passes, and vx fails it"')).toBe(
      frame(
        [
          `access(${web}/vite.config.js) = -1 ENOENT  [${web}/vite.config.js]`,
          `access(${web}/package.json) = -1 ENOENT  [${web}/package.json]`,
        ],
        {
          read: ['package.json', 'vite.config.js'],
          inputs: ['package.json', 'vite.config.js'],
        },
        [
          'vite v7.3.0 building client environment for production...',
          'transforming...',
          '✓ 3 modules transformed.',
          'rendering chunks...',
          'computing gzip size...',
          'dist/index.html                0.14 kB │ gzip: 0.13 kB',
          'dist/assets/index-CFD2rREh.js  0.78 kB │ gzip: 0.44 kB',
          '✓ built in 115ms',
        ].join('\n'),
      ),
    )
    expect(tab('title="2. Grant the config, key it, run again"')).toBe(
      frame(
        [
          `mkdir(${web}/node_modules/.vite-temp) = a write no grant covers  [${web}/node_modules/.vite-temp]`,
        ],
        { write: ['node_modules/.vite-temp/'] },
        [
          `failed to load config from ${web}/vite.config.js`,
          'error during build:',
          `Error: ENOENT: no such file or directory, mkdir '${web}/node_modules/.vite-temp'`,
        ].join('\n'),
      ),
    )
  })

  it('the write record is the one the sandbox writes', () => {
    expect(readFileSync(path.join(SRC, 'sandbox', 'violations.ts'), 'utf8')).toContain(
      'line: `${syscall}(${raw}) = a write no grant covers  [${abs}]`',
    )
  })
})

// The quickstart's two terminal lines, from the run its steps make: a root
// project, run twice, then a source edit.
describe("the quickstart's output", () => {
  it('the second run is up-to-date, and vx why names the edited file', async () => {
    const page = readFileSync(path.resolve(GUIDES, '..', 'quickstart.mdx'), 'utf8')
    const hit = /```ansi title="second run"\n(?:.*\n)*?(.*└─.*)\n/.exec(page)![1]!
    const verdict = plain(/```ansi\n(?:.*\n)*?(.*verdict.*)\n/.exec(page)![1]!)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-site-quickstart-'))
    try {
      await mkdir(path.join(dir, '.vx'))
      await mkdir(path.join(dir, 'src'))
      // What `vx init` leaves in a repo you already have: its lockfile's
      // plugin, which names the root project from its package.json.
      await mkdir(path.join(dir, 'node_modules/@vzn'), { recursive: true })
      await symlink(
        path.resolve(import.meta.dir, '..', '..', 'vx-lockfile'),
        path.join(dir, 'node_modules/@vzn/vx-lockfile'),
      )
      await writeFile(
        path.join(dir, '.vx/workspace.mjs'),
        "import { bun } from '@vzn/vx-lockfile'\n\nexport default { plugins: [bun()] }\n",
      )
      await writeFile(path.join(dir, '.gitignore'), 'node_modules\n')
      await writeFile(path.join(dir, 'package.json'), '{ "name": "my-app", "private": true }\n')
      await writeFile(
        path.join(dir, 'bun.lock'),
        JSON.stringify({
          lockfileVersion: 1,
          workspaces: { '': { name: 'my-app' } },
          packages: {},
        }),
      )
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/main.js dist/' },
      inputs: { files: ['src/**', 'tsconfig.json'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
}
`,
      )
      await writeFile(path.join(dir, 'src/main.js'), '1\n')
      await writeFile(path.join(dir, 'tsconfig.json'), '{}\n')
      const at = (...cmd: string[]) =>
        Bun.spawnSync({ cmd, cwd: dir, env: ENV }).stdout.toString() as string
      at('git', 'init', '-q', '-b', 'main')
      at('git', 'add', '-A')
      at('git', 'commit', '-qm', 'one')
      const run = (...args: string[]) => at(process.execPath, BIN, ...args)
      const runColour = (...args: string[]) =>
        Bun.spawnSync({
          cmd: [process.execPath, BIN, ...args],
          cwd: dir,
          env: COLOUR,
        }).stdout.toString() as string
      run('lock')
      run('run', 'build')
      const ms = (t: string) => t.replace(/\(\d+ms\)/g, '(<ms>)')
      expect(ms(runColour('run', 'build')).split('\n')).toContain(ms(hit))
      await writeFile(path.join(dir, 'src/main.js'), '2\n')
      run('run', 'build')
      const why = runColour('why', 'build')
      expect(plain(why).split('\n')).toContain(verdict)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// The CLI reference's samples (docs/cli.md), from the run they describe on
// a lib/app fixture: the page showed `vx why`'s and `vx last`'s old
// layouts and a `vx run ci` that no longer exists, in plain white, until
// 2026-11-22. Each `sh` command block is followed by the `ansi` block vx
// prints for it; what changes run to run (ids, times, keys, sizes) is
// masked on both sides.
describe("the CLI reference's samples", () => {
  const CLI = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')
  let dir = ''
  const out: Record<string, string> = {}
  const config = (name: string, deps: string) => `export default {
  name: '${name}',${name === 'app' ? "\n  tags: ['scope:web']," : ''}
  tasks: {
    build: {${name === 'app' ? "\n      description: 'compile the app'," : ''}
      dependsOn: [${deps}],
      exec: { command: 'mkdir -p dist && cp src/index.ts dist/index.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'test -f dist/index.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: [] },
      cache: true,
    },${name === 'lib' ? "\n    lint: { exec: { command: 'true' } }," : ''}
  },
}
`
  const at = (...cmd: string[]) =>
    expect(Bun.spawnSync({ cmd, cwd: dir, env: ENV }).exitCode).toBe(0)
  const vxIn = (label: string, ...args: string[]) => {
    const r = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: dir, env: COLOUR })
    out[label] = plain(r.stdout.toString() + r.stderr.toString())
  }
  /** The `ansi` block after the `sh` block whose one line is `command`, from `from` on. */
  const sampleAfter = (command: string, from = 0): string => {
    const at = CLI.indexOf(`\`\`\`sh\n${command}\n\`\`\`\n\n\`\`\`ansi\n`, from)
    expect(at).toBeGreaterThan(-1)
    return plain(/```ansi\n([\s\S]*?)\n```/.exec(CLI.slice(at))![1]!)
  }
  /** What a run cannot repeat: ids, clocks, keys, sizes, timings, paths. */
  const mask = (text: string): string =>
    stable(text)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}\b/g, '<id>')
      .replace(/\b[0-9a-f]{16}\b/g, '<key>')
      .replace(/[+−-]?\d+(?:\.\d+)?(?:ms|s|%|B|KB|MB|GB)(?!\w)/g, '<n>')
      .replace(/~?<n>/g, '<n>')
      // The summary's spread drops a figure equal to one it already shows,
      // and all of it when the tasks took the same time (report/summary.ts).
      .replace(/( <n>)(?: · (?:max|avg|min) <n>)+/g, '$1')
      .replace(/@ [0-9a-f]{8}(\+dirty)?/g, '@ <sha>')
      .replace(/\b\d+ workers\b/g, '<n> workers')
      .replace(/\/home\/me\/demo|\/\S*vx-cli-[^/\s]+/g, '<root>')
      .replace(/ +/g, ' ')
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-cli-'))
    await mkdir(path.join(dir, '.vx'))
    await writeFile(path.join(dir, '.vx/workspace.mjs'), 'export default {}\n')
    await writeFile(path.join(dir, '.gitignore'), 'dist\n')
    for (const [name, deps] of [
      ['lib', ''],
      ['app', "'lib#build'"],
    ] as const) {
      await mkdir(path.join(dir, `packages/${name}/src`), { recursive: true })
      await writeFile(path.join(dir, `packages/${name}/vx.config.mjs`), config(name, deps))
      await writeFile(path.join(dir, `packages/${name}/src/index.ts`), `export const ${name} = 1\n`)
    }
    at('git', 'init', '-q', '-b', 'main')
    vxIn('lock', 'lock')
    vxIn('lock --check', 'lock', '--check')
    at('git', 'add', '-A')
    at('git', 'commit', '-qm', 'one')
    vxIn('run1', 'run', 'build', '--all')
    vxIn('run2', 'run', 'build', '--all')
    vxIn('dry', 'run', 'build', 'test', '--all', '--dry')
    vxIn('show', 'show')
    vxIn('show app#build', 'show', 'app#build')
    at('git', 'checkout', '-qb', 'feat')
    await writeFile(path.join(dir, 'packages/lib/src/index.ts'), 'export const lib = 2\n')
    vxIn('affected', 'run', 'build', 'lint', '--affected=main', '--dry')
    vxIn('run3', 'run', 'build', '--all')
    vxIn('why', 'why', 'app#build')
    vxIn('last', 'last')
    vxIn('last --list', 'last', '--list')
  })

  afterAll(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  it('vx lock, vx show and vx why print what the page shows', () => {
    for (const [command, label] of [
      ['vx lock', 'lock'],
      ['vx show', 'show'],
      ['vx show app#build', 'show app#build'],
      ['vx why app#build', 'why'],
    ] as const)
      expect(mask(sampleAfter(command))).toBe(mask(out[label]!))
    expect(mask(sampleAfter('vx lock --check'))).toBe(mask(out['lock --check']!))
  })

  it('vx run, its plans, and vx last print what the page shows', () => {
    const first = CLI.indexOf('```sh\nvx run build --all\n```')
    expect(mask(sampleAfter('vx run build --all'))).toBe(mask(out['run1']!))
    expect(mask(sampleAfter('vx run build --all', first + 1))).toBe(mask(out['run2']!))
    expect(mask(sampleAfter('vx run build test --all --dry'))).toBe(mask(out['dry']!))
    expect(mask(sampleAfter('vx run build lint --affected=main --dry'))).toBe(
      mask(out['affected']!),
    )
    expect(mask(sampleAfter('vx last'))).toBe(mask(out['last']!))
    expect(mask(sampleAfter('vx last --list'))).toBe(mask(out['last --list']!))
  })
})

// The running patterns' samples were run on a phone: a 60-column terminal,
// where vx drops the columns a phone cannot show. Each run here is in a pty
// that wide, its live redraws replayed to the final screen. The pages run
// vite and vitest; the fixture runs shell, so vx's own lines are held.
describe('the running patterns show what vx prints at phone width', () => {
  let ws = ''
  const ESC = String.fromCharCode(27)
  /** The screen a live run leaves: cursor-up, erase-line and erase-below replayed. */
  const settle = (raw: string): string => {
    const lines = ['']
    let row = 0
    const token = new RegExp(
      `${ESC}\\[(\\d*)A|${ESC}\\[2?K|${ESC}\\[J|\\n|[^${ESC}\\n]+|${ESC}\\[[0-9;:]*m|${ESC}`,
      'g',
    )
    for (const m of raw.replace(/\r/g, '').matchAll(token)) {
      const t = m[0]
      if (t === '\n') {
        row++
        if (row === lines.length) lines.push('')
      } else if (t.startsWith(`${ESC}[`) && t.endsWith('A'))
        row = Math.max(0, row - Number(m[1] || 1))
      else if (t === `${ESC}[2K` || t === `${ESC}[K`) lines[row] = ''
      else if (t === `${ESC}[J`) {
        lines[row] = ''
        lines.length = row + 1
      } else lines[row] += t
    }
    return lines.join('\n')
  }
  const phone = async (...args: string[]) => {
    let out = ''
    const decoder = new TextDecoder()
    const p = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: ws,
      env: UNCOLOURED,
      terminal: { cols: 60, rows: 50, data: (_t, d) => void (out += decoder.decode(d)) },
    })
    const code = await p.exited
    return { code, out: settle(out) }
  }
  const sh = (...args: string[]) => Bun.spawnSync({ cmd: args, cwd: ws, env: ENV }).exitCode
  const vxSync = (...args: string[]) =>
    Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: ws, env: ENV }).exitCode
  const guide = (rel: string) => readFileSync(path.join(GUIDES, rel), 'utf8')
  /** The ansi block after `marker` on the page. */
  const block = (page: string, marker: string) => {
    const at = page.indexOf(marker)
    expect(at).toBeGreaterThan(-1)
    const open = page.indexOf('```ansi\n', at)
    return page.slice(open + 8, page.indexOf('\n```', open + 8))
  }
  // A figure is a time, a size or a usual time; the critical-path mark
  // follows timing, which a fixture's shell does not share with vitest.
  const loose = (line: string) =>
    plain(line)
      .replace(/[~+−-]?\d+(?:\.\d+)?(?:ms|s|%|[KMG]?B)(?=[\s)]|$)/g, '<n>')
      .replace(/◆/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  /** vx's own lines of a sample: its tables, summaries and frame edges, not the tool's. */
  const own = (sample: string) =>
    sample
      .split('\n')
      .filter((l) =>
        /^(?: {2}(?:Plan|Tasks|tasks|predicted)\b| {12}\S|\[vx\]|└─|┌─.* > failed)/.test(plain(l)),
      )
  const holds = (sample: string, out: string) => {
    expect(sample).toContain(ESC)
    const lines = own(sample)
    expect(lines.length).toBeGreaterThan(0)
    const printedLines = out.split('\n').map(loose)
    for (const line of lines) expect(printedLines).toContain(loose(line))
  }
  const config = (name: string, tasks: string) => `export default {
  name: '@demo/${name}',
  tasks: {
${tasks}
  },
}
`
  const build = (deps: boolean, command: string) => `    build: {
${deps ? "      dependsOn: ['^build'],\n" : ''}      exec: { command: '${command}' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },`
  const app = (name: string, deps: boolean) =>
    config(
      name,
      `${build(deps, 'mkdir -p dist && cp ../ui/dist/index.js dist/')}
    test: { exec: { command: 'sleep 1' } },${name === 'web' ? "\n    e2e: { exec: { command: 'sleep 30' } }," : ''}`,
    )
  const write = (rel: string, text: string) => writeFile(path.join(ws, rel), text)

  beforeAll(async () => {
    ws = await mkdtemp(path.join(os.tmpdir(), 'vx-site-phone-'))
    await mkdir(path.join(ws, '.vx'))
    await mkdir(path.join(ws, 'node_modules/@vzn'), { recursive: true })
    await symlink(
      path.resolve(import.meta.dir, '..', '..', 'vx-lockfile'),
      path.join(ws, 'node_modules/@vzn/vx-lockfile'),
    )
    await write(
      '.vx/workspace.mjs',
      `import { bun } from '@vzn/vx-lockfile'\n\nexport default { plugins: [bun()] }\n`,
    )
    await write('.gitignore', 'node_modules\ndist\n')
    await write(
      'package.json',
      '{ "name": "demo", "private": true, "workspaces": ["packages/*"] }\n',
    )
    const uses = { '@demo/ui': 'workspace:*' }
    await write(
      'bun.lock',
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          '': { name: 'demo' },
          'packages/ui': { name: '@demo/ui', version: '1.0.0' },
          'packages/web': { name: '@demo/web', version: '1.0.0', dependencies: uses },
          'packages/admin': { name: '@demo/admin', version: '1.0.0', dependencies: uses },
        },
        packages: {
          '@demo/ui': ['@demo/ui@workspace:packages/ui'],
          '@demo/web': ['@demo/web@workspace:packages/web'],
          '@demo/admin': ['@demo/admin@workspace:packages/admin'],
        },
      }),
    )
    for (const name of ['ui', 'web', 'admin']) {
      await mkdir(path.join(ws, `packages/${name}/src`), { recursive: true })
      await write(
        `packages/${name}/package.json`,
        JSON.stringify({
          name: `@demo/${name}`,
          version: '1.0.0',
          ...(name === 'ui' ? {} : { dependencies: uses }),
        }),
      )
      await write(`packages/${name}/src/${name === 'ui' ? 'index' : 'main'}.ts`, '1\n')
      await write(
        `packages/${name}/vx.config.mjs`,
        name === 'ui'
          ? config(
              'ui',
              `${build(false, 'sleep 0.3 && mkdir -p dist && cp src/index.ts dist/index.js')}
    test: { exec: { command: "echo 'expected 1 to be 2' && exit 1" } },`,
            )
          : app(name, true),
      )
    }
    await write('packages/ui/README.md', '# ui\n')
    expect(sh('git', 'init', '-q', '-b', 'main')).toBe(0)
    expect(vxSync('lock')).toBe(0)
    expect(sh('git', 'add', '-A')).toBe(0)
    expect(sh('git', 'commit', '-qm', 'one')).toBe(0)
  })

  afterAll(async () => {
    if (ws !== '') await rm(ws, { recursive: true, force: true })
  })

  it('tasks: without ^build web races ui; with it ui builds first', async () => {
    const page = guide('tasks.mdx')
    await write('packages/web/vx.config.mjs', app('web', false))
    expect(vxSync('lock')).toBe(0)
    const race = await phone('run', 'build', '--filter', '@demo/web', '--filter', '@demo/ui')
    expect(sh('git', 'checkout', '-q', '--', '.')).toBe(0)
    expect(vxSync('lock')).toBe(0)
    expect(vxSync('cache', 'clean')).toBe(0)
    expect(sh('rm', '-rf', 'packages/ui/dist')).toBe(0)
    expect(race.code).toBe(1)
    holds(block(page, '<TabItem label="Without ^build">'), race.out)
    const ordered = await phone('run', 'build', '--filter', '@demo/web')
    expect(ordered.code).toBe(0)
    holds(block(page, '<TabItem label="With ^build">'), ordered.out)
  })

  it('running-tasks: a filter brings what its tasks need', async () => {
    const page = guide('running-tasks.mdx')
    // History has timed both builds; an edit to each makes them misses.
    expect(vxSync('run', 'build', '--all')).toBe(0)
    await write('packages/ui/src/index.ts', '3\n')
    await write('packages/web/src/main.ts', '3\n')
    const r = await phone('run', 'build', '--filter', '@demo/web', '--dry')
    expect(sh('git', 'checkout', '-q', '--', '.')).toBe(0)
    expect(r.code).toBe(0)
    holds(block(page, '<Deeper level="patterns" title="Run one project\'s tasks">'), r.out)
  })

  it('running-tasks: three edits, three plans', async () => {
    const page = guide('running-tasks.mdx')
    expect(vxSync('run', 'build', '--all')).toBe(0)
    for (const [tab, file] of [
      ['Edit ui/src', 'packages/ui/src/index.ts'],
      ['Edit web/src', 'packages/web/src/main.ts'],
      ['Edit ui/README.md', 'packages/ui/README.md'],
    ] as const) {
      expect(sh('git', 'checkout', '-qb', 'edit')).toBe(0)
      await write(file, '2\n')
      expect(sh('git', 'commit', '-qam', 'edit')).toBe(0)
      const r = await phone('run', 'build', '--affected', '--dry')
      expect(sh('git', 'checkout', '-q', 'main')).toBe(0)
      expect(sh('git', 'branch', '-qD', 'edit')).toBe(0)
      expect(r.code).toBe(0)
      holds(block(page, `<TabItem label="${tab}">`), r.out)
    }
  })

  it('running-tasks: the rest runs, then --fail-fast aborts it', async () => {
    const page = guide('running-tasks.mdx')
    const rest = await phone('run', 'test', '--all')
    expect(rest.code).toBe(1)
    holds(printed(page, 'vx run test --all'), rest.out)
    const fast = await phone('run', 'test', '--all', '--fail-fast')
    expect(fast.code).toBe(1)
    holds(printed(page, 'vx run test --all --fail-fast'), fast.out)
  })

  it('running-tasks: --timeout fails the task', async () => {
    const page = guide('running-tasks.mdx')
    const r = await phone('run', '@demo/web#e2e', '--timeout', '3s')
    expect(r.code).toBe(1)
    holds(printed(page, 'vx run @demo/web#e2e --timeout 3s'), r.out)
  })
})
