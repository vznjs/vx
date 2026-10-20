// The quickstart's "Run it twice" block is a sequence a reader types from
// the workspace root. `vx run build` refused there ("not inside a
// project") until the block said where to stand: each line here runs in
// the directory any `cd` line leaves it in.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const PAGE = path.resolve(import.meta.dir, '../../vx-docs/src/content/docs/quickstart.mdx')
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
  const at = page.indexOf('Run it twice')
  expect(at).toBeGreaterThan(-1)
  const block = /```sh\n([\s\S]*?)```/.exec(page.slice(at))
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
    // The workspace `vx init` writes outside Turbo and Nx: no plugin and a
    // root project, here given the page's build.
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default { plugins: [] }\n')
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'a.ts'), 'a\n')
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/a.ts dist/' },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
    },
  },
}
`,
    )
    // --affected needs a base: a branch with a change on it.
    for (const c of [
      ['git', 'init', '-q', '-b', 'main'],
      ['git', 'add', '-A'],
      ['git', 'commit', '-qm', 'one'],
    ])
      expect(sh(root, c).code).toBe(0)
    expect(sh(root, ['git', 'checkout', '-qb', 'feat']).code).toBe(0)
    await writeFile(path.join(root, 'src', 'a.ts'), 'b\n')
    expect(sh(root, ['git', 'commit', '-qam', 'two']).code).toBe(0)

    // The step before the block has the reader run `vx lock`.
    expect(sh(root, [process.execPath, BIN, 'lock']).code).toBe(0)
    const lines = runBlock(readFileSync(PAGE, 'utf8'))
    expect(lines.filter((l) => l.startsWith('vx run ')).length).toBeGreaterThanOrEqual(2)
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
