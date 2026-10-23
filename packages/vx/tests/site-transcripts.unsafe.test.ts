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

/** The fenced block holding `marker`, its `$ ` line dropped, dedented. */
function sample(page: string, marker: string): string {
  const at = page.indexOf(marker)
  expect(at).toBeGreaterThan(-1)
  const open = page.lastIndexOf('```', at)
  const body = /```[^\n]*\n([\s\S]*?)\n\s*```/.exec(page.slice(open))![1]!
  const lines = body.split('\n')
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length))
  return lines
    .map((l) => l.slice(indent))
    .filter((l) => !l.startsWith('$ '))
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
