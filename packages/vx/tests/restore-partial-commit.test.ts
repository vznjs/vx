// A restore that fails after some of its renames landed leaves a mix of
// the new entry's files and the old ones. No later run may take that mix
// for either entry: the outputs carry one fixed mtime and one size per
// file in both entries (a `touch -d`, SOURCE_DATE_EPOCH), so only the
// per-file stamp (inode, ctime) a whole restore or save writes tells them
// apart (item 886).

import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 60_000
const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

// More files than one rename batch (64): the batch holding the blocked file
// fails, the ones after it never start.
const N = 100
const name = (i: number): string => `${String(i).padStart(3, '0')}.txt`

it(
  'a restore that failed after some renames is never taken as current',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-partial-commit-' })
    made.push(root)
    const write = `mkdir -p dist && v=$(cat src/in.txt) && for i in $(seq -w 0 ${N - 1}); do echo "$v" > dist/$i.txt; done && touch -d @1000000000 dist/*.txt`
    const dir = await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: ${JSON.stringify(write.replaceAll('seq -w 0', 'seq -f %03g 0'))} },
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**', '!dist/*/keep'] } },
            },
          },
        }
      `,
      files: { 'src/in.txt': 'A\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const cacheDir = path.join(root, '.cache')
    const run = () => vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    const dist = path.join(dir, 'dist')
    const contents = (): string[] =>
      readdirSync(dist)
        .sort()
        .map((f) => readFileSync(path.join(dist, f), 'utf8'))

    const a = await run()
    expect(`${a.code}\n${a.err}`).toStartWith('0\n')
    await writeFile(path.join(dir, 'src', 'in.txt'), 'B\n')
    const b = await run()
    expect(`${b.code}\n${b.err}`).toStartWith('0\n')

    // Back to A, with a directory where A's first file goes, holding a
    // file the outputs leave out: a hit takes an empty one, never this,
    // so the restore's rename onto it fails.
    await writeFile(path.join(dir, 'src', 'in.txt'), 'A\n')
    await rm(path.join(dist, name(0)))
    await mkdir(path.join(dist, name(0)))
    await writeFile(path.join(dist, name(0), 'keep'), '')
    const failed = await run()
    expect(failed.code).not.toBe(0)
    await rm(path.join(dist, name(0)), { recursive: true })
    await writeFile(path.join(dist, name(0)), 'A\n')
    Bun.spawnSync(['touch', '-d', '@1000000000', path.join(dist, name(0))])
    const mixed = contents()
    expect(mixed).toContain('A\n')
    expect(mixed).toContain('B\n')

    // Every path A holds is there with A's size, mode and mtime.
    const again = await run()
    expect(`${again.code}\n${again.err}`).toStartWith('0\n')
    expect(contents()).toEqual(Array.from({ length: N }, () => 'A\n'))
  },
  TIMEOUT,
)
