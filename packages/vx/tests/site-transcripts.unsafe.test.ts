// The site's terminal samples are pasted from real runs, and a sample
// drifts the day the output changes: the troubleshooting `vx why` block
// and the agents page's diff entry showed `a853d874…` where vx prints the
// whole blob id, and a previous run that never happened (2026-10-23). Each
// sample here is the output of the run the page describes, on one fixture.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { formatTaskBlock } from '../src/report/framed-output.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const SRC = path.resolve(import.meta.dir, '..', 'src')
const GUIDES = path.resolve(import.meta.dir, '../../vx-docs/src/content/docs/guides')
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  NO_COLOR: '1',
}
let root = ''

function vx(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root, env: ENV })
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

function git(...args: string[]): void {
  expect(Bun.spawnSync({ cmd: ['git', ...args], cwd: root, env: ENV }).exitCode).toBe(0)
}

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
      cache: { outputs: { files: ['dist/**'] } },
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
  it("troubleshooting's vx why block is the run it describes", () => {
    const page = readFileSync(path.join(GUIDES, 'troubleshooting.mdx'), 'utf8')
    const why = vx('why', '@demo/app#build')
    expect(why.code).toBe(0)
    expect(stable(sample(page, '$ vx why @demo/app#build'))).toBe(stable(why.stdout))
  })

  it("the agents page's diff entry is vx why --format json's", () => {
    const page = readFileSync(path.join(GUIDES, 'agents.mdx'), 'utf8')
    const line = /^\{"kind":"file".*\}$/m.exec(page)![0]
    const why = JSON.parse(vx('why', '@demo/app#build', '--format', 'json').stdout) as {
      diff: { entries: unknown[] }
    }
    expect(JSON.parse(line)).toEqual(why.diff.entries[0])
  })

  it("the agents page's refusal line is what --dry=json prints", () => {
    const page = readFileSync(path.join(GUIDES, 'agents.mdx'), 'utf8')
    const line = /^\{"ok":false.*\}$/m.exec(page)![0]
    const run = vx('run', 'biuld', '--all', '--dry=json')
    expect(run.code).toBe(1)
    expect(run.stdout.trim()).toBe(line)
  })

  it("troubleshooting's filter typo is what vx prints", () => {
    const page = readFileSync(path.join(GUIDES, 'troubleshooting.mdx'), 'utf8')
    const run = vx('run', 'build', '--filter', '@demo/ap')
    expect(run.code).toBe(1)
    expect(sample(page, '$ vx run build --filter @demo/ap')).toBe(run.stderr.trim())
  })
})

describe("configure's verdict table", () => {
  it('every row is a verdict vx why can print', async () => {
    const page = readFileSync(path.join(GUIDES, 'configure.mdx'), 'utf8')
    const at = page.indexOf('Every verdict')
    const table = page.slice(at, page.indexOf('</details>', at))
    const rows = [...table.matchAll(/^\| `+ ?(.+?) ?`+ \|/gm)].map((m) => m[1]!)
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
// frame renderer from the records the sandbox writes: `mkdir(<abs>) = a
// write no grant covers  [<abs>]` (sandbox-runtime's "declaring
// cache.outputs grants no write") and strace's `openat(<raw>) = -1 ENOENT
// [<abs>]`. The tabs left out the frame's lines and the write's path.
describe("the sandboxing guide's failures", () => {
  const command = 'mkdir -p dist && cat tsconfig.json src/a.ts > dist/out.js'
  const node = {
    id: '@demo/app#build',
    projectName: '@demo/app',
    taskName: 'build',
    config: { exec: { command } },
  } as unknown as TaskNode
  const block = (record: string, fix: Record<string, string[]>, stderr: string): string =>
    formatTaskBlock(
      node,
      {
        node,
        status: 'failed',
        exitCode: 1,
        durationMs: 12,
        sandboxViolations: 1,
        sandboxViolationLines: [record],
        sandboxFix: fix,
      } as TaskOutcome,
      { output: [{ text: `${stderr}\n`, err: true }] },
    ).trimEnd()
  const page = readFileSync(path.join(GUIDES, 'sandboxing.mdx'), 'utf8')
  const tab = (label: string): string =>
    sample(page.slice(page.indexOf(label)), '$ vx run build --all')

  it('are the frames vx draws', () => {
    expect(page).toContain(`command: '${command}'`)
    expect(tab('label="1. The write"')).toBe(
      block(
        'mkdir(/repo/packages/app/dist) = a write no grant covers  [/repo/packages/app/dist]',
        { write: ['dist/'] },
        "mkdir: cannot create directory 'dist': Read-only file system",
      ),
    )
    expect(tab('label="2. The read"')).toBe(
      block(
        'openat(tsconfig.json) = -1 ENOENT  [/repo/packages/app/tsconfig.json]',
        { read: ['tsconfig.json'], inputs: ['tsconfig.json'] },
        'cat: tsconfig.json: No such file or directory',
      ),
    )
  })

  it('the write record is the one the sandbox writes', () => {
    expect(readFileSync(path.join(SRC, 'exec', 'sandbox-violations.ts'), 'utf8')).toContain(
      'line: `${syscall}(${raw}) = a write no grant covers  [${abs}]`',
    )
  })
})

// The quickstart's two terminal lines, from the run its steps make: a root
// project, run twice, then a source edit.
describe("the quickstart's output", () => {
  it('the second run is up-to-date, and vx why names the edited file', async () => {
    const page = readFileSync(path.resolve(GUIDES, '..', 'quickstart.mdx'), 'utf8')
    // Each sits in a step, indented three spaces.
    const hit = /```text frame="terminal" title="second run"\n {3}(.*)\n/.exec(page)![1]!
    const verdict = /```text frame="terminal"\n {3}( +verdict .*)\n/.exec(page)![1]!
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-site-quickstart-'))
    try {
      await mkdir(path.join(dir, '.vx'))
      await mkdir(path.join(dir, 'src'))
      await writeFile(path.join(dir, '.vx/workspace.mjs'), 'export default { plugins: [] }\n')
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/index.ts dist/' },
      inputs: { files: ['src/**', 'tsconfig.json'] },
      cache: { outputs: { files: ['dist/**'] } },
    },
  },
}
`,
      )
      await writeFile(path.join(dir, 'src/index.ts'), '1\n')
      await writeFile(path.join(dir, 'tsconfig.json'), '{}\n')
      const at = (...cmd: string[]) =>
        Bun.spawnSync({ cmd, cwd: dir, env: ENV }).stdout.toString() as string
      at('git', 'init', '-q', '-b', 'main')
      at('git', 'add', '-A')
      at('git', 'commit', '-qm', 'one')
      const run = (...args: string[]) => at(process.execPath, BIN, ...args)
      run('lock')
      run('run', 'build')
      const ms = (t: string) => t.replace(/\(\d+ms\)/g, '(<ms>)')
      expect(ms(run('run', 'build')).split('\n')).toContain(ms(hit))
      await writeFile(path.join(dir, 'src/index.ts'), '2\n')
      run('run', 'build')
      expect(run('why', 'build').split('\n')).toContain(verdict)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
