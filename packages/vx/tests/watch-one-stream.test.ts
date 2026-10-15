// On macOS every recursive watch is an FSEvents stream, and each new one
// went live slower than the last: on a macos-latest runner the median
// stream took 1.7 s to prove delivery at 1000 projects and 27 s at 3000,
// so 751 of 3000 missed the 2 s proof and fell back to polling, a full
// core at idle (org/devex/watchers-2026-10-14.md). One stream at the
// workspace root went live in 8 ms and delivered an edit in the last
// project in 60 ms. So on macOS `vx watch` opens one recursive stream,
// whatever the project count, and hands each event to the projects it
// lies in. Linux keeps its per-directory inotify tree (watch-tree-linux).
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { NOT_CI, until } from './helpers/watch-loop.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const LOCKED_BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const PROJECTS = 12

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

describe('vx watch on macOS', () => {
  let root = ''
  let spyDir = ''
  let proc: ReturnType<typeof Bun.spawn> | undefined
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-watch-stream-' })
    for (let i = 0; i < PROJECTS; i++) {
      const dir = await addProject(root, `p${i}`, CONFIG)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'a.txt'), `${i}\n`)
    }
    spyDir = mkdtempSync(path.join(os.tmpdir(), 'vx-watch-spy-'))
  })
  afterEach(async () => {
    proc?.kill('SIGTERM')
    await proc?.exited
    proc = undefined
    await rm(root, { recursive: true, force: true })
    rmSync(spyDir, { recursive: true, force: true })
  })

  it('opens one recursive stream at the root, and an edit still names its project', async () => {
    const log = path.join(spyDir, 'recursive.log')
    const spy = path.join(spyDir, 'spy.ts')
    writeFileSync(
      spy,
      `import fs from 'node:fs'
const watch = fs.watch
;(fs as any).watch = function (dir: string, opts: any, ...rest: any[]) {
  if (typeof opts === 'object' && opts?.recursive) require('node:fs').appendFileSync(${JSON.stringify(log)}, dir + '\\n')
  return (watch as any).call(fs, dir, opts, ...rest)
}
`,
    )
    appendFileSync(log, '')
    proc = Bun.spawn([process.execPath, '--preload', spy, LOCKED_BIN, 'watch', 'build', '--all'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...NOT_CI, VX_RUN_KILL_GRACE: '200ms' },
    })
    let out = ''
    let err = ''
    void (async () => {
      for await (const c of proc!.stdout as ReadableStream<Uint8Array>)
        out += new TextDecoder().decode(c)
    })()
    void (async () => {
      for await (const c of proc!.stderr as ReadableStream<Uint8Array>)
        err += new TextDecoder().decode(c)
    })()
    await until(() => out.includes('watching'), `"watching"\n${out}\n${err}`, 30_000)
    const streams = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect(streams).toEqual(process.platform === 'darwin' ? [realpathSync(root)] : [])
    expect(err).not.toContain('polling')
    await writeFile(path.join(root, 'packages', 'p7', 'src', 'a.txt'), 'edited\n')
    await until(() => out.includes('changed p7 src/a.txt'), `the edit\n${out}\n${err}`, 15_000)
  }, 60_000)
})
