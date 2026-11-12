// Stale-cache-hit regressions, continued from stale-hit-git.test.ts: split so
// neither file holds a test shard alone (that file ran 80 s, 2026-11-12).
// The same shape: the real CLI against a real git-backed fixture.

import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { affectedProjects } from '../src/workspace/index.js'
import { CHECK_ATTR, parseCheckAttrOutput } from '../src/util/index.js'
import {
  GitFilesCache,
  attributeFilesOutsideTree,
  autocrlfConverts,
  gitStatWeakened,
  populateGitFilesCache,
  runGitLsFiles,
} from '../src/cache/inputs.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    // Identity and signing on the HELPER, not on each row: every case here
    // commits, and a runner with no global git identity refuses to
    // (`empty ident name`). Eighteen call sites set it by hand and two new
    // ones forgot, which only showed up on CI — this box has a global
    // identity and the runner does not.
    cmd: [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=test@vx.local',
      '-c',
      'user.name=vx test',
      ...args,
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    const detail = [
      new TextDecoder().decode(p.stderr).trim(),
      new TextDecoder().decode(p.stdout).trim(),
    ]
      .filter((s) => s.length > 0)
      .join(' | ')
    throw new Error(`git ${args.join(' ')} exited ${p.exitCode}: ${detail}`)
  }
}

/** Run the real CLI and return its combined output. */
function vx(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-stale-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('stale cache hits', () => {
  // A project dir went to git as a pathspec: `:top` read as magic (`top`)
  // listed none of its files, and `*g` as a glob also listed `:top/src/log`,
  // so `:top`'s slice was not empty and its edited `src/f` left the key.
  it(
    'a scoped enumeration lists a project dir that reads as pathspec magic, and only its own files',
    async () => {
      for (const f of ['package.json', 'src/f', 'src/log'])
        await write(path.join(root, ':top', f), f)
      for (const f of ['package.json', 'src/f']) await write(path.join(root, '*g', f), f)
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      await write(path.join(root, ':top/src/new'), 'untracked')
      await write(path.join(root, ':top/src/f'), 'edited')
      const top = path.join(root, ':top')
      const g = path.join(root, '*g')
      const memo = new GitFilesCache()
      await populateGitFilesCache(root, [top, g], memo)
      const all = [new Bun.Glob('**')]
      expect([memo.snapshotFor(top, all), memo.snapshotFor(g, all)]).toEqual([
        ['package.json', 'src/f', 'src/log', 'src/new'],
        ['package.json', 'src/f'],
      ])
      expect(memo.oidsFor(top)?.has(path.join(top, 'src/f'))).toBe(false)
    },
    TIMEOUT,
  )

  // git cannot open a directory past PATH_MAX, warns, and exits 0: the
  // files under it were in no key, and an edit there was a stale hit.
  it(
    'a directory git could not open refuses the enumeration, by name',
    async () => {
      await write(path.join(root, 'p/package.json'), '{}')
      git(root, 'init', '-q')
      const seg = 'd'.repeat(200)
      const made = Bun.spawnSync({
        cmd: [
          'sh',
          '-c',
          `cd p && for i in $(seq 21); do mkdir ${seg} && cd ${seg}; done; echo x > f`,
        ],
        cwd: root,
      })
      expect(made.exitCode).toBe(0)
      const p = path.join(root, 'p')
      const enumerate = (dirs: string[]) => populateGitFilesCache(root, dirs, new GitFilesCache())
      for (const dirs of [[root], [p]]) {
        await expect(enumerate(dirs)).rejects.toThrow(
          /^git could not open the directory p\/d{38}…[d/]{40}, so no key would see the files under it\. Shorten the path, or ignore it in \.gitignore\.$/,
        )
      }
      expect(() => runGitLsFiles(p)).toThrow(/^git could not open the directory p\/d{38}…/)
      await write(path.join(root, '.gitignore'), `p/${seg}/\n`)
      await enumerate([p])
    },
    TIMEOUT,
  )

  // A directory removed between git's read of its parent and its own open
  // (a run lock's staging directory renamed in a TMPDIR inside the
  // workspace) warned `No such file or directory`, and the run was
  // refused as a path too long. Nothing is under a directory that is not
  // there; one still there that git could not open still refuses.
  it(
    'a directory gone before git opened it is no refusal; one still there is',
    async () => {
      await write(path.join(root, 'p/package.json'), '{}')
      await write(path.join(root, 'p/kept/f'), 'x')
      git(root, 'init', '-q')
      const bin = await mkdtemp(path.join(os.tmpdir(), 'vx-git-shim-'))
      const real = Bun.which('git')!
      const shim = (dir: string, reason: string) =>
        writeFile(
          path.join(bin, 'git'),
          `#!/bin/sh\nfor a; do case "$a" in ls-files|status) echo "warning: could not open directory '${dir}/': ${reason}" >&2;; esac; done\nexec ${real} "$@"\n`,
          { mode: 0o755 },
        )
      const saved = process.env['PATH']
      process.env['PATH'] = `${bin}:${saved}`
      try {
        const p = path.join(root, 'p')
        const enumerate = (dirs: string[]) => populateGitFilesCache(root, dirs, new GitFilesCache())
        await shim('p/gone', 'No such file or directory')
        for (const dirs of [[root], [p]]) await enumerate(dirs)
        expect(runGitLsFiles(p).files).toContain('kept/f')
        await shim('p/package.json/x', 'Not a directory')
        expect(runGitLsFiles(p).files).toContain('kept/f')
        // Gone when git opened it and made again since (a task re-creating
        // its own output directory under another task's walk): the reason
        // says it was not there, and it was refused as a path too long
        // (2026-11-10).
        await shim('p/kept', 'No such file or directory')
        for (const dirs of [[root], [p]]) await enumerate(dirs)
        expect(runGitLsFiles(p).files).toContain('kept/f')
        await shim('p/kept', 'Too many open files')
        await expect(enumerate([root])).rejects.toThrow(
          /^git could not open the directory p\/kept\//,
        )
        expect(() => runGitLsFiles(p)).toThrow(/^git could not open the directory p\/kept\//)
      } finally {
        process.env['PATH'] = saved
        await rm(bin, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'the index OIDs are kept under the default stat and dropped under a weakened one',
    async () => {
      await write(path.join(root, 'src/a.txt'), 'AAAA')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      // Pinned here: a machine's global config may weaken either (this
      // container's does both).
      git(root, 'config', 'core.trustctime', 'true')
      git(root, 'config', 'core.checkStat', 'default')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      const trusted = async (): Promise<boolean> => {
        const memo = new GitFilesCache()
        await populateGitFilesCache(root, [root], memo)
        return memo.oidsFor(root)?.has(path.join(root, 'src/a.txt')) === true
      }
      expect(await trusted()).toBe(true)
      git(root, 'config', 'core.checkStat', 'minimal')
      expect(await trusted()).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a repo with no attributes and no autocrlf never runs check-attr',
    async () => {
      // The whole point of the gate: the common case must pay NOTHING. If this
      // ever spawns check-attr, every warm run in every plain repo just got a
      // serial git round-trip it does not need.
      await write(path.join(root, 'pkg/src/a.ts'), 'export const a = 1')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      const origSpawn = Bun.spawn
      const seen: string[][] = []
      const bunMut = Bun as unknown as { spawn: typeof Bun.spawn }
      bunMut.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
        const opt = a[0] as { cmd?: readonly string[] } | undefined
        // Spawned by its absolute path (util/which.ts).
        if (opt && Array.isArray(opt.cmd) && path.basename(opt.cmd[0] ?? '') === 'git')
          seen.push([...opt.cmd])
        return origSpawn(...a)
      }) as typeof Bun.spawn
      try {
        const cache = new GitFilesCache()
        await populateGitFilesCache(root, [path.join(root, 'pkg')], cache)
      } finally {
        bunMut.spawn = origSpawn
      }
      expect(seen.some((cmd) => cmd.includes('check-attr'))).toBe(false)
      // The gate probe itself must stay in the concurrent batch, not serial.
      expect(seen.some((cmd) => cmd.at(-2) === 'var' && cmd.at(-1) === '-l')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a .gitattributes naming no converting attribute never runs check-attr',
    async () => {
      // `.vx/.gitattributes` marks the lock `linguist-generated`, which
      // converts nothing; any .gitattributes used to cost a check-attr per
      // run (21 ms). Control: a `text` line in the same file does run it.
      await write(path.join(root, 'pkg/src/a.ts'), 'export const a = 1')
      await write(path.join(root, 'pkg/.gitattributes'), 'projects.lock.json linguist-generated\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      const checkAttrRuns = async (): Promise<boolean> => {
        const origSpawn = Bun.spawn
        const seen: string[][] = []
        const bunMut = Bun as unknown as { spawn: typeof Bun.spawn }
        bunMut.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
          const opt = a[0] as { cmd?: readonly string[] } | undefined
          if (opt && Array.isArray(opt.cmd) && path.basename(opt.cmd[0] ?? '') === 'git')
            seen.push([...opt.cmd])
          return origSpawn(...a)
        }) as typeof Bun.spawn
        try {
          await populateGitFilesCache(root, [path.join(root, 'pkg')], new GitFilesCache())
        } finally {
          bunMut.spawn = origSpawn
        }
        return seen.some((cmd) => cmd.includes('check-attr'))
      }
      const generatedOnly = await checkAttrRuns()
      await write(path.join(root, 'pkg/.gitattributes'), '*.ts text eol=lf\n')
      git(root, 'commit', '-qam', 'text')
      expect([generatedOnly, await checkAttrRuns()]).toEqual([false, true])
    },
    TIMEOUT,
  )

  it(
    'a tracked .gitattributes starts check-attr before status has answered (U-3)',
    async () => {
      // check-attr waited for status, the one spawn that walks the tree, and
      // ran after it: ~8 ms of a warm run on this repo, whose root
      // `.gitattributes` sets a merge driver. The index listing alone proves
      // the gate will fire. Status is held here until check-attr starts or a
      // second passes, and only the first is the fix.
      await write(path.join(root, '.gitattributes'), '*.txt text\n')
      await write(path.join(root, 'pkg/src/a.txt'), 'a\n')
      await write(path.join(root, 'pkg/src/b.ts'), 'export const b = 1\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      const origSpawn = Bun.spawn
      const bunMut = Bun as unknown as { spawn: typeof Bun.spawn }
      let attrStarted!: () => void
      const attr = new Promise<'check-attr'>((r) => (attrStarted = () => r('check-attr')))
      let released: string | undefined
      bunMut.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
        const cmd = (a[0] as { cmd?: readonly string[] } | undefined)?.cmd ?? []
        const proc = origSpawn(...a)
        if (path.basename(cmd[0] ?? '') !== 'git') return proc
        if (cmd.includes('check-attr')) attrStarted()
        if (!cmd.includes('status')) return proc
        const gate = Promise.race([attr, Bun.sleep(1000).then(() => 'timeout')])
        return new Proxy(proc, {
          get(target, key) {
            if (key === 'exited') {
              return gate.then((by) => {
                released = by
                return target.exited
              })
            }
            const v = Reflect.get(target, key, target) as unknown
            return typeof v === 'function' ? (v as () => unknown).bind(target) : v
          },
        })
      }) as typeof Bun.spawn
      const cache = new GitFilesCache()
      try {
        await populateGitFilesCache(root, [path.join(root, 'pkg')], cache)
      } finally {
        bunMut.spawn = origSpawn
      }
      expect(released).toBe('check-attr')
      // And its answer still lands: the text file is hashed from disk, the
      // other keeps its index OID.
      const oids = cache.oidsFor(path.join(root, 'pkg'))
      expect(oids?.has(path.join(root, 'pkg/src/a.txt'))).toBe(false)
      expect(oids?.has(path.join(root, 'pkg/src/b.ts'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a workspace-anchored OUTPUT landing in the consumer project is not classified stable',
    async () => {
      // `outputs.workspaceFiles` is root-anchored and deliberately
      // boundary-IGNORING — it may write inside ANOTHER project's dir. So a
      // consumer in that project, reading the same path with an ordinary
      // PROJECT-RELATIVE `inputs.files`, has a preliminary key until the
      // producer runs.
      //
      // The stability gate missed exactly this pairing: `upstreamOutputProjects`
      // holds the PRODUCER's project (`gen`), never the consumer's (`app`), and
      // the workspace-reader clause does not fire because the consumer reads
      // project-relative. Classified stable, its key was derived UP FRONT from
      // the previous generation's bytes and reused verbatim by execute-task —
      // and the `anyWorkspaceOutputs` mitigation only disables the restore
      // tier, not probe reuse, which is the half that serves the stale bytes.
      await write(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
      )
      await writeLocalWorkspace(root)
      await write(path.join(root, 'pkgs/gen/package.json'), JSON.stringify({ name: 'gen' }))
      await write(
        path.join(root, 'pkgs/app/package.json'),
        JSON.stringify({ name: 'app', dependencies: { gen: '*' } }),
      )
      await write(
        path.join(root, 'pkgs/gen/vx.config.mjs'),
        [
          'export default { tasks: { codegen: {',
          '  exec: { command: "mkdir -p ../app/gen out && cat src/version.txt > ../app/gen/out.txt && cp src/version.txt out/marker.txt" },',
          '  inputs: { files: ["src/**"] },',
          '  outputs: { files: ["out/**"], workspaceFiles: ["pkgs/app/gen/**"] },',
          '  cache: true,',
          '} } }',
          '',
        ].join('\n'),
      )
      await write(
        path.join(root, 'pkgs/app/vx.config.mjs'),
        [
          'export default { tasks: { build: {',
          '  dependsOn: ["gen#codegen"],',
          '  exec: { command: "cat gen/out.txt" },',
          // `tasks: []` decouples the upstream key fold — the documented
          // content-invalidation pattern. Without it the upstream's own input
          // key cascades into this key and masks the defect, which is exactly
          // how the 2026-07-19 stale hit had to be reproduced too.
          '  inputs: { files: ["gen/**"], tasks: [] }, outputs: { files: ["dist/**"] }, cache: true,',
          '} } }',
          '',
        ].join('\n'),
      )
      // Seeded with a value no cycle uses, so every cycle's commit is real.
      await write(path.join(root, 'pkgs/gen/src/version.txt'), 'v0')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 't@vx.local')
      git(root, 'config', 'user.name', 'vx')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'initial')

      // Assert the invariant at EVERY cycle rather than at a fixed index. The
      // collision's position drifts between runs (observed at cycle 5, 6 and 9
      // across otherwise identical sequences), so a test that checks one
      // nominated cycle passes intermittently on the unfixed tree — measured
      // 1 failure in 5. The invariant itself never drifts: whatever the task
      // reports must equal what the producer actually left on disk.
      const cycle = async (version: string): Promise<void> => {
        await write(path.join(root, 'pkgs/gen/src/version.txt'), version)
        git(root, 'add', '-A')
        git(root, 'commit', '-qm', version)
        const out = vx(root, 'run', 'build', '--all', '--output-logs', 'full')
        const reported = out
          .split('\n')
          .map((l) => l.trim())
          .find((l) => /^v[ABC]$/.test(l))
        const disk = await readFile(path.join(root, 'pkgs/app/gen/out.txt'), 'utf8')
        expect({ version, reported }).toEqual({ version, reported: disk })
      }

      // Three distinct generations, cycled. The producer rewrites the
      // consumer's input every run, so the consumer must never replay an
      // older generation's output.
      for (const v of ['vA', 'vB', 'vC', 'vA', 'vB', 'vC', 'vA', 'vB', 'vC']) {
        await cycle(v)
      }
    },
    TIMEOUT,
  )

  // turborepo#1103: git printing a warning while the inputs were enumerated
  // changed the hash. vx reads only `-z` stdout and the exit code.
  it(
    'git warning on stderr during the attribute check leaves the key where a quiet git puts it',
    async () => {
      const keyWith = async (attributes: string): Promise<{ hash: string; warned: boolean }> => {
        const ws = await mkdtemp(path.join(root, 'ws-'))
        await write(path.join(ws, 'package.json'), '{"name":"r","private":true}')
        await writeLocalWorkspace(ws)
        await write(
          path.join(ws, 'vx.config.mjs'),
          `export default {
             tasks: {
               build: {
                 exec: { command: 'cat src/a.txt' },
                 inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
               },
             },
           }`,
        )
        await write(path.join(ws, '.gitattributes'), attributes)
        await write(path.join(ws, 'src/a.txt'), 'a\r\n')
        await write(path.join(ws, 'src/b.txt'), 'b\n')
        git(ws, 'init', '-q')
        git(ws, 'add', '-A')
        git(ws, 'commit', '-q', '-m', 'initial')
        // The index holds a.txt as LF, the tree as CRLF: the key is right
        // only if the attribute check ran to the end and untrusted the OID.
        await write(path.join(ws, 'src/a.txt'), 'a\r\n')
        const attr = Bun.spawnSync({
          cmd: ['git', 'check-attr', 'text', '--', 'src/a.txt'],
          cwd: ws,
          stderr: 'pipe',
        })
        const dry = JSON.parse(vx(ws, 'run', 'build', '--dry=json')) as {
          tasks: Array<{ hash: string }>
        }
        return { hash: dry.tasks[0]!.hash, warned: attr.stderr.toString().length > 0 }
      }
      // The same rule both times; the negated line is one git ignores
      // aloud, so it changes what git prints and nothing it decides.
      const quiet = await keyWith('*.txt text\n')
      const noisy = await keyWith('*.txt text\n!nothing text\n')
      expect(quiet.warned).toBe(false)
      expect(noisy.warned).toBe(true)
      expect(noisy.hash).toBe(quiet.hash)
    },
    TIMEOUT,
  )

  // nx#23106: the key held the input's content but not its name, so a
  // rename replayed the entry built under the old name.
  it(
    'renaming an input misses and back again restores only the outputs of that name',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && for f in src/*.ts; do cp "$f" "dist/$(basename "$f" .ts).js"; done' },
               inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
             },
           },
         }`,
      )
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
      await write(path.join(root, 'src/a.ts'), 'same bytes\n')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')
      const dist = async () => (await readdir(path.join(root, 'dist'))).sort()
      const renameTo = async (from: string, to: string) => {
        await rename(path.join(root, 'src', from), path.join(root, 'src', to))
      }
      const status = () => {
        const out = vx(root, 'run', 'build')
        return /up-to-date|restored/.test(out) ? 'hit' : 'miss'
      }

      expect(status()).toBe('miss')
      expect(await dist()).toEqual(['a.js'])
      await renameTo('a.ts', 'b.ts')
      expect(status()).toBe('miss')
      expect(await dist()).toEqual(['b.js'])
      await renameTo('b.ts', 'a.ts')
      expect(status()).toBe('hit')
      expect(await dist()).toEqual(['a.js'])
      await renameTo('a.ts', 'b.ts')
      expect(status()).toBe('hit')
      expect(await dist()).toEqual(['b.js'])
    },
    TIMEOUT,
  )
})

// turborepo#9345: a name holding a byte that is not UTF-8 (`x\xffy`) came
// back from git's `-z` output, and from `Bun.Glob`, decoded lossily as
// `x�y`, which names no file. An input by that name was never read
// (every edit a hit), an output never saved (every hit a tree without it).
// vx cannot open such a name, so it refuses it by name. macOS refuses to
// create one at all (APFS and HFS+ require UTF-8 names), so there is
// nothing to hold there.
describe.skipIf(process.platform === 'darwin')('a name that is not UTF-8', () => {
  const BAD = Buffer.from([0x78, 0xff, 0x79]) // x, 0xFF, y

  function vxExit(cwd: string, ...args: string[]): { code: number; out: string } {
    const p = Bun.spawnSync({
      cmd: ['bun', CLI, ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    return {
      code: p.exitCode,
      out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
    }
  }

  async function project(command: string): Promise<string> {
    await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
    await writeLocalWorkspace(root)
    await write(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { build: {
         exec: { command: ${JSON.stringify(command)} },
         inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
       } } }\n`,
    )
    await write(path.join(root, 'src', 'a'), 'v1')
    await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')
    return path.join(root, 'src')
  }
  const badIn = (dir: string): Buffer => Buffer.concat([Buffer.from(`${dir}/`), BAD])

  for (const tracked of [false, true]) {
    it(
      `${tracked ? 'a tracked' : 'an untracked'} input by that name is refused, not dropped`,
      async () => {
        const src = await project('mkdir -p dist && cat src/* > dist/all')
        await writeFile(badIn(src), 'bad1')
        git(root, 'init', '-q')
        if (tracked) {
          git(root, 'add', '-A')
          git(root, 'commit', '-q', '-m', 'init')
        }
        const first = vxExit(root, 'run', 'build')
        expect([first.code, first.out]).toEqual([1, expect.stringContaining('src/x�y')])
        expect(first.out).toContain('not valid UTF-8')
        // CONTROL: the same file under a UTF-8 name is an input like any other.
        await rm(badIn(src))
        await write(path.join(src, 'xy'), 'bad1')
        expect(vxExit(root, 'run', 'build').code).toBe(0)
        expect(await readFile(path.join(root, 'dist', 'all'), 'utf8')).toBe('v1bad1')
      },
      TIMEOUT,
    )
  }

  it(
    'such a name fails only the task that reads it; the rest hit and --affected selects its owner (vercel/turborepo#11106, vercel/turborepo#12826)',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","workspaces":["pkgs/*"]}')
      await writeLocalWorkspace(root)
      for (const p of ['a', 'b']) {
        await write(path.join(root, 'pkgs', p, 'package.json'), `{"name":"${p}"}`)
        await write(
          path.join(root, 'pkgs', p, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n`,
        )
        await write(path.join(root, 'pkgs', p, 'src', 'i'), '1')
      }
      await writeFile(badIn(path.join(root, 'pkgs', 'a', 'src')), 'bad1')
      // One outside every project, which no task reads.
      await write(path.join(root, 'docs', 'ok'), '1')
      await writeFile(badIn(path.join(root, 'docs')), 'doc1')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const first = vxExit(root, 'run', 'build', '--all')
      expect([first.code, first.out]).toEqual([1, expect.stringContaining('src/x\uFFFDy')])
      expect(first.out).toContain('not valid UTF-8')
      // The row's words, not their spacing: a run that sampled a task's CPU
      // adds columns between them (CI, PR #4867).
      const row = first.out.split('\n').find((l) => l.endsWith(' b#build'))
      expect(row?.trim().split(/ +/)).toEqual(expect.arrayContaining(['success', 'miss']))
      expect(vxExit(root, 'run', 'build', '--filter', 'b').out).toContain('local 1✓')
      await writeFile(badIn(path.join(root, 'pkgs', 'a', 'src')), 'bad2')
      await writeFile(badIn(path.join(root, 'docs')), 'doc2')
      git(root, 'commit', '-q', '-am', 'edit the odd names')
      const projects = ['a', 'b'].map((name) => ({
        name,
        dir: path.join(root, 'pkgs', name),
        packageJson: { name } as never,
        configPath: null,
      }))
      expect([
        ...(await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })),
      ]).toEqual(['a'])
    },
    TIMEOUT,
  )

  it(
    'one inside an embedded repository is refused too, not dropped',
    async () => {
      // The outer repo lists `src/vendor/` alone; vx asks its own git for
      // the files, and that listing carries the name too (A-33).
      const src = await project('mkdir -p dist && cat src/*/* > dist/all')
      const vendor = path.join(src, 'vendor')
      await write(path.join(vendor, 'ok'), 'o')
      await writeFile(badIn(vendor), 'bad1')
      git(vendor, 'init', '-q')
      git(vendor, 'add', '-A')
      git(vendor, 'commit', '-q', '-m', 'init')
      git(root, 'init', '-q')
      const first = vxExit(root, 'run', 'build')
      expect([first.code, first.out]).toEqual([1, expect.stringContaining('src/vendor/x�y')])
      expect(first.out).toContain('not valid UTF-8')
    },
    TIMEOUT,
  )

  it(
    'a workspaceFiles input by that name is refused too, not dropped',
    async () => {
      // The workspace half keeps its own copy of the refusal (A-31).
      await project('mkdir -p dist && cat shared/* > dist/all')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default { tasks: { build: {
           exec: { command: 'mkdir -p dist && cat shared/* > dist/all' },
           inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] }, outputs: { files: ['dist/**'] }, cache: true,
         } } }\n`,
      )
      await write(path.join(root, 'shared', 'ok'), 'o')
      await writeFile(badIn(path.join(root, 'shared')), 'bad1')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const first = vxExit(root, 'run', 'build')
      expect([first.code, first.out]).toEqual([1, expect.stringContaining('shared/x�y')])
      expect(first.out).toContain('not valid UTF-8')
      // CONTROL: the same file under a UTF-8 name is an input like any other.
      await rm(badIn(path.join(root, 'shared')))
      await write(path.join(root, 'shared', 'xy'), 'bad1')
      expect(vxExit(root, 'run', 'build').code).toBe(0)
      expect(await readFile(path.join(root, 'dist', 'all'), 'utf8')).toBe('obad1')
    },
    TIMEOUT,
  )

  // CONTROL past the gate: a name that really holds U+FFFD is valid UTF-8,
  // reads like any other, and must not be taken for a lossy one.
  it(
    'a name that holds U+FFFD as a character is an input like any other',
    async () => {
      const src = await project('mkdir -p dist && cat src/* > dist/all')
      await write(path.join(src, 'x\ufffdy'), 'fine1')
      git(root, 'init', '-q')
      expect(vxExit(root, 'run', 'build').code).toBe(0)
      expect(await readFile(path.join(root, 'dist', 'all'), 'utf8')).toBe('v1fine1')
      await write(path.join(src, 'x\ufffdy'), 'fine2')
      expect(vxExit(root, 'run', 'build').code).toBe(0)
      expect(await readFile(path.join(root, 'dist', 'all'), 'utf8')).toBe('v1fine2')
    },
    TIMEOUT,
  )

  it(
    'an output by that name fails the save by name, so no hit restores a tree without it',
    async () => {
      await project(`mkdir -p dist && printf a > dist/ok && printf b > "dist/$(printf 'x\\377y')"`)
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const first = vxExit(root, 'run', 'build')
      expect(first.out).toContain('dist/x�y')
      expect(first.out).toContain('not valid UTF-8')
      await rm(path.join(root, 'dist'), { recursive: true, force: true })
      const second = vxExit(root, 'run', 'build')
      expect(second.out).not.toContain('restored')
      expect(second.out).not.toMatch(/ \d+✓/)
    },
    TIMEOUT,
  )

  // The command exited 0: `failed (exit 1)` with `(0ms)` named an exit it
  // never returned and dropped the time it took; the next run's clean
  // refusal ran no command at all.
  it(
    'a save or clean refused by that name names the step, not an exit the command never returned',
    async () => {
      await project(`mkdir -p dist && printf b > "dist/$(printf 'x\\377y')" && sleep 0.3`)
      git(root, 'init', '-q')
      const first = vxExit(root, 'run', 'build')
      expect([first.code, first.out]).toEqual([1, expect.stringContaining('cannot save')])
      expect(first.out).toContain('failed (cache save failed)')
      expect(first.out).not.toContain('exit 1')
      expect(first.out).not.toContain('(0ms)')
      const last = vxExit(root, 'last')
      expect(last.out).toContain('cache save failed')
      expect(last.out).not.toContain('exit 1')
      const second = vxExit(root, 'run', 'build')
      expect([second.code, second.out]).toEqual([1, expect.stringContaining('cannot clear')])
      expect(second.out).toContain('failed (output clean failed)')
      expect(second.out).not.toContain('exit 1')
    },
    TIMEOUT,
  )

  // A hit saves nothing: one left by hand among the outputs is refused for
  // the clean, not as a file vx "cannot save".
  it(
    'one left among the outputs before a hit is refused for the clean',
    async () => {
      await project('mkdir -p dist && printf a > dist/ok')
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      expect(vxExit(root, 'run', 'build').code).toBe(0)
      await writeFile(badIn(path.join(root, 'dist')), 'stray')
      const second = vxExit(root, 'run', 'build')
      expect(second.out).toContain('dist/x�y')
      expect(second.out).toContain('not valid UTF-8')
      expect(second.out).toContain(
        'vx cannot clear a file by it before the task runs or a hit restores',
      )
      expect(second.out).not.toContain('cannot save')
    },
    TIMEOUT,
  )
})

describe('parseCheckAttrOutput', () => {
  const triples = (...t: string[][]): string => t.flat().join('\0') + '\0'

  it('drops only paths where a conversion-capable attribute is set', () => {
    expect(
      [
        ...parseCheckAttrOutput(
          triples(
            ['a.ts', 'text', 'auto'],
            ['a.ts', 'eol', 'unspecified'],
            ['a.ts', 'ident', 'unspecified'],
            ['b.png', 'text', 'unset'],
            ['b.png', 'eol', 'unspecified'],
            ['b.png', 'ident', 'unspecified'],
            ['c.sh', 'text', 'unspecified'],
            ['c.sh', 'eol', 'lf'],
            ['c.sh', 'ident', 'unspecified'],
            ['d.c', 'text', 'unspecified'],
            ['d.c', 'eol', 'unspecified'],
            ['d.c', 'ident', 'set'],
          ),
        ),
      ].sort(),
    ).toEqual(['a.ts', 'c.sh', 'd.c'])
  })

  it('keeps everything when nothing is specified, and tolerates empty input', () => {
    expect([
      ...parseCheckAttrOutput(
        triples(
          ['x', 'text', 'unspecified'],
          ['x', 'eol', 'unspecified'],
          ['x', 'ident', 'unspecified'],
        ),
      ),
    ]).toEqual([])
    expect([...parseCheckAttrOutput('')]).toEqual([])
  })

  it("reads git's own CHECK_ATTR answer: only what converts, the legacy crlf too", async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-attr-'))
    try {
      git(ws, 'init', '-q')
      await write(
        path.join(ws, '.gitattributes'),
        [
          '*.png binary',
          'gen.ts linguist-generated',
          'a.ts text eol=lf',
          'legacy.txt crlf',
          'input.txt crlf=input',
          'off.txt -crlf',
          'plain.c -text',
          '',
        ].join('\n'),
      )
      const files = [
        'x.png',
        'gen.ts',
        'a.ts',
        'legacy.txt',
        'input.txt',
        'off.txt',
        'plain.c',
        'none.md',
      ]
      const out = Bun.spawnSync({
        cmd: ['git', ...CHECK_ATTR],
        cwd: ws,
        stdin: new TextEncoder().encode(files.map((f) => `${f}\0`).join('')),
      })
      expect(out.exitCode).toBe(0)
      expect([...parseCheckAttrOutput(out.stdout.toString())].sort()).toEqual([
        'a.ts',
        'input.txt',
        'legacy.txt',
      ])
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe('autocrlfConverts', () => {
  it('is true only for the values that actually convert', () => {
    expect(autocrlfConverts('core.autocrlf=true')).toBe(true)
    expect(autocrlfConverts('core.autocrlf=input')).toBe(true)
    expect(autocrlfConverts('core.autocrlf=false')).toBe(false)
    expect(autocrlfConverts('')).toBe(false)
    // Other core.* keys in the same output must not be mistaken for it.
    expect(autocrlfConverts('core.eol=lf\ncore.attributesfile=/x')).toBe(false)
    expect(autocrlfConverts('core.eol=lf\ncore.autocrlf=TRUE')).toBe(true)
    // The last value wins, as it does in git.
    expect(autocrlfConverts('core.autocrlf=true\ncore.autocrlf=false')).toBe(false)
  })

  // Git reads `yes`, `on`, a nonzero integer and a bare key as true; only
  // `true` was taken, so `autocrlf = 1` read as no conversion.
  it('takes every spelling git reads as true', () => {
    for (const v of ['yes', 'on', '1', '2k', 'On']) {
      expect(autocrlfConverts(`core.autocrlf=${v}`)).toBe(true)
    }
    expect(autocrlfConverts('core.autocrlf=false\ncore.autocrlf')).toBe(true)
  })
})

describe('gitStatWeakened', () => {
  it('is true for a ctime git does not trust or a minimal stat, and only then', () => {
    // Git reads an empty value and any zero integer (`00`, `-0`, `0k`) as
    // false too: `trustctime =` kept index OIDs trusted, and a same-size
    // rewrite with its mtime kept replayed the old output.
    for (const v of ['false', 'no', 'off', '0', 'FALSE', '', '00', '-0', '0k', ' 0 ']) {
      expect(gitStatWeakened(`core.trustctime=${v}`)).toBe(true)
    }
    // A bare key is true, and the last value wins.
    expect(gitStatWeakened('core.trustctime=false\ncore.trustctime')).toBe(false)
    expect(gitStatWeakened('core.checkstat=minimal')).toBe(true)
    for (const vars of [
      '',
      'core.trustctime=true',
      'core.checkstat=default',
      'core.trustctime=false\ncore.trustctime=true',
    ]) {
      expect(gitStatWeakened(vars)).toBe(false)
    }
  })
})

// The files the gate stats, from `git var -l`. A git from 2.42 names them;
// an older one does not, and the documented lookup stands in.
describe('attributeFilesOutsideTree', () => {
  const env = { HOME: '/h' }
  it('takes both files from a git that names them, and nothing else', () => {
    const listing = [
      'core.attributesfile=/ignored',
      'GIT_ATTR_SYSTEM=/sys/gitattributes',
      'GIT_ATTR_GLOBAL=/h/.config/git/attributes',
      'GIT_CONFIG_GLOBAL=/h/.gitconfig',
    ].join('\n')
    expect(attributeFilesOutsideTree(listing, env)).toEqual([
      '/h/.config/git/attributes',
      '/sys/gitattributes',
    ])
    // Under GIT_ATTR_NOSYSTEM git leaves the system line out; so does this.
    expect(
      attributeFilesOutsideTree('GIT_ATTR_GLOBAL=/g\nGIT_CONFIG_GLOBAL=/h/.gitconfig', env),
    ).toEqual(['/g'])
  })

  it('mirrors the global lookup for a git that does not name it', () => {
    const global = (listing: string, e: Record<string, string>) =>
      attributeFilesOutsideTree(listing, { ...e, GIT_ATTR_NOSYSTEM: '1' })
    expect(global('core.attributesfile=~/attrs', env)).toEqual(['/h/attrs'])
    expect(global('core.attributesfile=/abs', { ...env, XDG_CONFIG_HOME: '/x' })).toEqual(['/abs'])
    expect(global('', { ...env, XDG_CONFIG_HOME: '/x' })).toEqual(['/x/git/attributes'])
    // An EMPTY XDG_CONFIG_HOME is unset to git.
    expect(global('', { ...env, XDG_CONFIG_HOME: '' })).toEqual(['/h/.config/git/attributes'])
    expect(global('', env)).toEqual(['/h/.config/git/attributes'])
  })

  it('adds the system file where the build put it, unless GIT_ATTR_NOSYSTEM', () => {
    const files = attributeFilesOutsideTree('', env)
    expect(files[0]).toBe('/h/.config/git/attributes')
    expect(files[1]).toBe('/etc/gitattributes')
    expect(files[2]).toMatch(/\/etc\/gitattributes$/)
    expect(files).toHaveLength(3)
  })
})
