// The quickstart's Run block is a sequence a reader types from the
// workspace root. `vx run build` and `vx run build --graph` refused there
// ("not inside a project") until the block said where to stand: each line
// here runs in the directory the block's `cd` lines leave it in.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const PAGE = path.resolve(import.meta.dir, '../../vx-docs/src/content/docs/quickstart.md')
const GIT = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

function runBlock(page: string): string[] {
  const at = page.indexOf('## Run')
  const block = /```bash\n([\s\S]*?)```/.exec(page.slice(at))
  expect(block).not.toBeNull()
  return block![1]!
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l !== '')
}

function sh(cwd: string, cmd: string[]): { code: number | null; out: string } {
  const r = Bun.spawnSync({
    cmd,
    cwd,
    env: { ...process.env, ...GIT },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

describe('the quickstart Run block', () => {
  it('every line succeeds where the block stands', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-quickstart-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'src', 'a.ts'), 'a\n')
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cp src/a.ts dist/' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
}
`,
    )
    // --affected needs a base: a parent commit with a change after it.
    for (const c of [
      ['git', 'init', '-q'],
      ['git', 'add', '-A'],
      ['git', 'commit', '-qm', 'one'],
    ])
      expect(sh(root, c).code).toBe(0)
    await writeFile(path.join(app, 'src', 'a.ts'), 'b\n')
    expect(sh(root, ['git', 'commit', '-qam', 'two']).code).toBe(0)

    const lines = runBlock(readFileSync(PAGE, 'utf8'))
    expect(lines.filter((l) => l.startsWith('vx run ')).length).toBeGreaterThanOrEqual(5)
    let cwd = root
    const results: [string, number | null][] = []
    for (const line of lines) {
      if (line.startsWith('cd ')) {
        cwd = path.join(cwd, line.slice(3))
        continue
      }
      expect(line.startsWith('vx ')).toBe(true)
      const r = sh(cwd, [process.execPath, BIN, ...line.slice(3).split(/\s+/)])
      results.push([line, r.code])
    }
    expect(results).toEqual(results.map(([l]) => [l, 0]))
  })
})
