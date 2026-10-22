// Stale-cache-hit regressions, continued from stale-hit.test.ts: split so
// neither file holds a test shard alone (2026-10-22). The same shape: the
// real CLI against a real git-backed fixture.

import { mkdir, mkdtemp, readFile, rm, writeFile, utimes, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

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
  it(
    'an input named with odd characters still re-keys on each edit, tracked or not',
    async () => {
      // Port of Turbo's globwalk test_weird_filenames, comma_patterns and
      // workspace_globbing_includes_dotfiles: a name git quotes or a glob
      // reads as syntax must still reach the key.
      await write(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
      await writeLocalWorkspace(root)
      const pkg = path.join(root, 'packages', 'lib')
      const names = [
        'a b\nc',
        '"q"',
        'back\\slash',
        'foo:bar',
        'a,b',
        '\u00e9',
        '.hidden/x',
        '[id]/p',
        '{a,b}/p',
      ]
      for (const n of names) await write(path.join(pkg, 'src', n), 'v1')
      await write(
        path.join(pkg, 'vx.config.mjs'),
        `export default { name: 'lib', tasks: { build: {
           exec: { command: 'mkdir -p dist && date +%N > dist/o' },
           inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
         } } }\n`,
      )
      git(root, 'init', '-q')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'init')
      const miss = (): boolean => /1↑/.test(vx(root, 'run', 'build', '--all'))
      const seen: string[] = []
      expect(miss()).toBe(true)
      for (const n of names) {
        await write(path.join(pkg, 'src', n), 'v2')
        if (!miss() || miss()) seen.push(`${n} tracked`)
        await write(path.join(pkg, 'src', `${n}.new`), 'v1')
        if (!miss()) seen.push(`${n} untracked added`)
        await write(path.join(pkg, 'src', `${n}.new`), 'v2')
        if (!miss() || miss()) seen.push(`${n} untracked edit`)
      }
      expect(seen).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'a content change that preserves mtime is not served from the file-hash memo',
    async () => {
      // The (mtime, size) memo in `file_hashes` spans runs, so any producer
      // that preserves mtime — `tar -x`, `unzip`, `cp -p`, `rsync --times`,
      // a SOURCE_DATE_EPOCH generator — could hand back the previous run's
      // digest for genuinely different bytes.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: { command: 'mkdir -p dist && cp src/in.txt dist/out.txt' },
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'src/in.txt'), 'AAA')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      // Left UNTRACKED on purpose: a tracked+clean file takes the git index
      // OID path instead, which never consults this memo.
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/cache/\n')

      vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('AAA')

      // Same byte length, mtime forced back to what the first run recorded.
      const before = await stat(path.join(root, 'src/in.txt'))
      await write(path.join(root, 'src/in.txt'), 'BBB')
      await utimes(path.join(root, 'src/in.txt'), before.atime, before.mtime)

      const out = vx(root, 'run', 'build')
      expect(await readFile(path.join(root, 'dist/out.txt'), 'utf8')).toBe('BBB')
      expect(out).not.toMatch(/up-to-date/)
    },
    TIMEOUT,
  )

  it(
    'a committed file under an output survives the clean before a run',
    async () => {
      // gen/b.ts is committed under codegen's `gen/**`: never an output
      // (owner, 2026-10-14: "never delete committed file"), so the clean
      // before codegen's run leaves it, and the consumer still reads it
      // after codegen stops writing it. Until then the clean deleted it.
      //
      // `inputs.tasks: []` decouples the consumer from the producer's
      // hash — a documented pattern (docs/schema.md).
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             codegen: {
               exec: { command: 'sh emit.sh' },
               inputs: { files: ['emit.sh'] }, cache: { outputs: { files: ['gen/**'] } },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               inputs: { files: ['gen/*.ts'], tasks: [] },
               cache: {
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(
        path.join(root, 'emit.sh'),
        'mkdir -p gen\nprintf a > gen/a.js\nprintf content-of-b > gen/b.ts\n',
      )
      await write(path.join(root, 'gen/a.js'), 'a')
      await write(path.join(root, 'gen/b.ts'), 'content-of-b')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/cache/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')

      // The producer stops emitting b.ts; the committed copy stays.
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf a > gen/a.js\n')

      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')
    },
    TIMEOUT,
  )

  it(
    'a submodule under an output survives the clean before a run and before a restore',
    async () => {
      // git lists a submodule as one gitlink path, never its files, so a
      // committed-file check by exact path cleaned gen/sub/x.txt.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             codegen: {
               exec: { command: 'mkdir -p gen && printf a > gen/a.js' },
               inputs: { files: [] }, cache: { outputs: { files: ['gen/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'gen/sub/x.txt'), 'pinned')
      await write(path.join(root, '.gitignore'), '.vx/cache/\n')
      const sub = path.join(root, 'gen/sub')
      for (const dir of [sub, root]) {
        git(dir, 'init', '-q')
        git(dir, 'config', 'user.email', 'test@vx.local')
        git(dir, 'config', 'user.name', 'vx test')
      }
      git(sub, 'add', '-A')
      git(sub, 'commit', '-q', '-m', 'sub')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'codegen')
      expect(await readFile(path.join(sub, 'x.txt'), 'utf8')).toBe('pinned')
      await rm(path.join(root, 'gen/a.js'))
      vx(root, 'run', 'codegen')
      expect(await readFile(path.join(root, 'gen/a.js'), 'utf8')).toBe('a')
      expect(await readFile(path.join(sub, 'x.txt'), 'utf8')).toBe('pinned')
    },
    TIMEOUT,
  )

  it(
    'a wiped output stops counting as a consumer input on the cache-miss path',
    async () => {
      // The producer removes the committed gen/b.ts (no clean deletes it,
      // 2026-10-14). It is tracked and clean at run start, so it carries an
      // index OID, and resolveFiles skips its existence probe for
      // OID-carrying paths. Unless the removal is seen, a file GONE FROM
      // DISK stays in the consumer's input set and its key never moves.
      //
      // `inputs.tasks: []` decouples the consumer from the producer's
      // hash — a documented pattern (docs/schema.md), and what makes the
      // defect observable rather than masked by the upstream cascade.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             codegen: {
               exec: { command: 'sh emit.sh' },
               inputs: { files: ['emit.sh'] }, cache: { outputs: { files: ['gen/**'] } },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               inputs: { files: ['gen/*.ts'], tasks: [] },
               cache: {
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(
        path.join(root, 'emit.sh'),
        'mkdir -p gen\nprintf a > gen/a.js\nprintf content-of-b > gen/b.ts\n',
      )
      await write(path.join(root, 'gen/a.js'), 'a')
      await write(path.join(root, 'gen/b.ts'), 'content-of-b')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/cache/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')

      // The producer stops emitting b.ts. The consumer's real input set is now
      // empty, so its output must become empty too.
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf a > gen/a.js\nrm -f gen/b.ts\n')

      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('')
    },
    TIMEOUT,
  )

  it(
    'a workspace output written mid-run reaches a consumer whose partition was read before it',
    async () => {
      // The ADDITION twin, on the miss path: `early` reads the workspace
      // partition first (codegen waits on it; it reads no output, which
      // `vx lock` refuses before the producer), codegen then writes gen/b.ts
      // at the root, and consume resolves `gen/*.ts` against a partition
      // enumerated before that write. Two lines in miss-save.ts keep it
      // honest — the root-anchored mark and the partition invalidation —
      // and they mask each other; with both gone, consume keys from an
      // EMPTY input set, and a later run whose real input set is empty
      // (emit.sh emits no .ts) hits run one's artifact and restores
      // content the inputs no longer hold.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             early: {
               exec: { command: 'true' },
               inputs: { files: [], workspaceFiles: ['package.json'] }, cache: { outputs: { files: [] } },
             },
             codegen: {
               dependsOn: ['early'],
               exec: { command: 'sh emit.sh' },
               inputs: { files: ['emit.sh'], tasks: [] },
               cache: {
                 outputs: { files: [], workspaceFiles: ['gen/**'] },
               },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               inputs: { files: [], workspaceFiles: ['gen/*.ts'], tasks: [] },
               cache: {
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf content-of-b > gen/b.ts\n')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/cache/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'consume', '--concurrency', '1')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-b')

      // The producer stops emitting any .ts: consume's real input set is
      // empty, so its output must be empty too — not run one's bytes.
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf a > gen/a.js\n')
      vx(root, 'run', 'consume', '--concurrency', '1')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('')
    },
    TIMEOUT,
  )

  it(
    'a committed file under an output survives the restore on a hit',
    async () => {
      // gen/old.ts is committed under codegen's `gen/**`: the hit's clean
      // leaves it and the restore writes the bytes the run left, so the
      // consumer reads it on the cold run and on the warm one.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             early: {
               exec: { command: 'true' },
               inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } },
             },
             codegen: {
               dependsOn: ['early'],
               exec: { command: 'sh emit.sh' },
               inputs: { files: ['emit.sh'], tasks: [] }, cache: { outputs: { files: ['gen/**'] } },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               inputs: { files: ['gen/*.ts'], tasks: [] },
               cache: {
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf b > gen/b.js\n')
      await write(path.join(root, 'gen/old.ts'), 'content-of-old')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/cache/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      // Cold: codegen keeps old.ts and emits b.js.
      await writeLocalWorkspace(root)
      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-old')

      // Warm: codegen hits and restores; old.ts stays, and consume hits.
      await rm(path.join(root, 'gen/b.js'))
      const out = vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'gen/old.ts'), 'utf8')).toBe('content-of-old')
      expect(await readFile(path.join(root, 'gen/b.js'), 'utf8')).toBe('b')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-old')
      expect(out).toMatch(/consume[^\n]*up-to-date/)
    },
    TIMEOUT,
  )

  it(
    'a committed file under a root-anchored output survives the restore on a hit',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             early: {
               exec: { command: 'true' },
               inputs: { files: [], workspaceFiles: ['package.json'] }, cache: { outputs: { files: [] } },
             },
             codegen: {
               dependsOn: ['early'],
               exec: { command: 'sh emit.sh' },
               inputs: { files: ['emit.sh'], tasks: [] },
               cache: {
                 outputs: { files: [], workspaceFiles: ['gen/**'] },
               },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt 2>/dev/null || : > out/all.txt' },
               inputs: { files: [], workspaceFiles: ['gen/*.ts'], tasks: [] },
               cache: {
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(path.join(root, 'emit.sh'), 'mkdir -p gen\nprintf b > gen/b.js\n')
      await write(path.join(root, 'gen/old.ts'), 'content-of-old')
      await write(path.join(root, '.gitignore'), 'out/\n.vx/cache/\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-old')

      await rm(path.join(root, 'gen/b.js'))
      const out = vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'gen/old.ts'), 'utf8')).toBe('content-of-old')
      expect(await readFile(path.join(root, 'gen/b.js'), 'utf8')).toBe('b')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('content-of-old')
      expect(out).toMatch(/consume[^\n]*up-to-date/)
    },
    TIMEOUT,
  )

  it(
    'a root-anchored file the hit RESTORES is recorded for a consumer that reads it',
    async () => {
      // The other half of the hit's workspace mark: what the artifact put
      // back, not what the clean took. `gen/new.ts` is untracked and gone at
      // run start, so the snapshot lacks it; codegen's hit restores it, and
      // only the mark sends consume back to git to see it (C-24: marking the
      // wiped paths alone passed the suite).
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeLocalWorkspace(root)
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             early: {
               exec: { command: 'true' },
               inputs: { files: [], workspaceFiles: ['package.json'] }, cache: { outputs: { files: [] } },
             },
             codegen: {
               dependsOn: ['early'],
               exec: { command: 'mkdir -p gen && printf N > gen/new.ts' },
               inputs: { files: ['package.json'], tasks: [] },
               cache: {
                 outputs: { files: [], workspaceFiles: ['gen/**'] },
               },
             },
             consume: {
               dependsOn: ['codegen'],
               exec: { command: 'mkdir -p out && cat gen/*.ts > out/all.txt && echo ran >> runs.log' },
               inputs: { files: [], workspaceFiles: ['gen/*.ts'], tasks: [] },
               cache: {
                 outputs: { files: ['out/**'] },
               },
             },
           },
         }`,
      )
      await write(path.join(root, '.gitignore'), 'out/\n.vx/cache/\nruns.log\n')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'initial')

      await writeLocalWorkspace(root)
      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'out/all.txt'), 'utf8')).toBe('N')
      await rm(path.join(root, 'gen'), { recursive: true })
      vx(root, 'run', 'consume')
      expect(await readFile(path.join(root, 'gen/new.ts'), 'utf8')).toBe('N')
      // consume's input set holds the restored file, as in the cold run: a hit.
      expect(await readFile(path.join(root, 'runs.log'), 'utf8')).toBe('ran\n')
    },
    TIMEOUT,
  )
})
