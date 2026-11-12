import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SandboxViolation } from '../src/exec/index.js'
import { perRunWriteHint, sandboxFix } from '../src/orchestrator/sandbox-fix.js'
import { CREDENTIAL_STORES } from '../src/orchestrator/sandbox-request.js'
import { anyTaskGlob } from '../src/util/index.js'
import { validateProjectConfig } from '../src/workspace/config-schema.js'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-fix-')))
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src', 'i.js'), '')
  writeFileSync(path.join(dir, 'tsconfig.json'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const v = (
  line: string,
  ignorable: SandboxViolation['ignorable'],
  target: string,
  extra: Partial<SandboxViolation> = {},
): SandboxViolation => ({
  line,
  timestamp: new Date(),
  target,
  ...(target.startsWith('/') ? { path: target } : {}),
  ...(ignorable !== undefined ? { ignorable } : {}),
  ...extra,
})

describe('sandboxFix', () => {
  it('turns each denial into the grant that allows it', () => {
    const at = (p: string) => path.join(dir, p)
    const fix = sandboxFix(
      [
        // Linux openat: the host has the file, so it was a hidden read.
        v('openat(src/i.js) = -1 ENOENT', ['read', 'write'], at('src/i.js')),
        v('openat(tsconfig.json) = -1 ENOENT', ['read', 'write'], at('tsconfig.json')),
        // The host lacks it: a create, granted as its top directory.
        v('openat(dist/a/o.js) = -1 ENOENT', ['read', 'write'], at('dist/a/o.js')),
        v('mkdir(out) = -1 EROFS', ['write'], at('out')),
        v('deny(1) file-write-create', ['write'], at('log.txt')),
        v('deny network-outbound example.com:443 (x)', ['network'], 'example.com:443'),
        v('deny(1) sysctl-read kern.x', ['systemInfo'], 'kern.x'),
        v('deny(1) file-read-data', ['read'], path.join(os.homedir(), '.npmrc')),
        v('deny(1) file-read-data', ['read'], '/etc/hosts'),
        // vx's own note is no denial.
        v('cwd unreadable', ['read'], at('src/i.js'), { hint: true }),
        v('deny(1) mach-lookup x', undefined, 'x'),
      ],
      dir,
      dir,
    )
    expect(fix).toEqual({
      read: ['/etc/hosts', 'src/i.js', 'tsconfig.json'],
      write: ['dist/', 'log.txt', 'out/'],
      network: ['example.com'],
      systemInfo: ['kern.x'],
      withheld: ['~/.npmrc'],
    })
  })

  // The proxy refuses a host on `deny.network` whatever `allow.network`
  // says: the fix named `network: ['example.com']`, already allowed.
  it('suggests no network grant for a host the deny list or its own shape refuses', () => {
    const net = (host: string, reason: string) =>
      v(`deny network-outbound ${host}:443 (${reason})`, ['network'], `${host}:443`)
    expect(
      sandboxFix(
        [
          net('example.com', 'host is on the deny list'),
          net('bad host', 'malformed host'),
          net('npmjs.org', 'host is not on the allow list'),
        ],
        dir,
        dir,
      ),
    ).toEqual({ network: ['npmjs.org'] })
  })

  it('grants a write under a read input as the file alone', () => {
    const write = (p: string) => v('deny(1) file-write-create', ['write'], path.join(dir, p))
    const denials = [write('src/gen.js'), write('dist/a.js'), write('lib/x.js')]
    expect(
      sandboxFix(denials, dir, dir, undefined, { files: ['src/**', '!dist/**'] })?.write,
    ).toEqual(['dist/', 'lib/', 'src/gen.js'])
    expect(sandboxFix(denials, dir, dir, undefined, { files: ['./**/*.ts'] })?.write).toEqual([
      'dist/a.js',
      'lib/x.js',
      'src/gen.js',
    ])
  })

  it('names the reads of the project no input glob matches, for a cached task', () => {
    const read = (p: string) => v('deny(1) file-read-data', ['read'], p)
    const denials = [
      read(path.join(dir, 'src/i.js')),
      read(path.join(dir, 'src/gen/x.js')),
      read(path.join(dir, 'tsconfig.json')),
      read('/etc/hosts'),
      read(path.join(os.homedir(), '.cache/x')),
      v('deny(1) file-write-create', ['write'], path.join(dir, 'out.txt')),
    ]
    expect(
      sandboxFix(denials, dir, dir, undefined, { files: ['./src/**', '!src/gen/**'] })?.inputs,
    ).toEqual(['src/gen/x.js', 'tsconfig.json'])
    // CONTROL: every read keyed, and a task with no cache, name none.
    expect(sandboxFix(denials, dir, dir, undefined, { files: ['**'] })?.inputs).toBeUndefined()
    expect(sandboxFix(denials, dir, dir)?.inputs).toBeUndefined()
  })

  // A read elsewhere in the workspace was granted by its absolute path,
  // which holds on no other machine, and never named for the key: the fix
  // applied as given turned an edit there into a stale hit.
  it('spells a workspace read from the project, and names it for inputs.workspaceFiles', () => {
    const project = path.join(dir, 'packages', 'b')
    const at = (p: string) => path.join(dir, p)
    const read = (p: string) => v('deny(1) file-read-data', ['read'], at(p))
    const denials = [
      read('packages/a/src/index.js'),
      read('package.json'),
      read('packages/b/src/x.js'),
      v('deny(1) file-read-data', ['read'], '/etc/hosts'),
      v('deny(1) file-write-create', ['write'], at('packages/a/dist/o.js')),
    ]
    const inputs = { files: ['src/**'], workspaceFiles: ['package.json'] }
    expect(sandboxFix(denials, project, dir, undefined, inputs)).toEqual({
      read: ['../../package.json', '../a/src/index.js', '/etc/hosts', 'src/x.js'],
      // Outside the project the top directory is `..`: the path alone.
      write: ['../a/dist/o.js'],
      workspaceFiles: ['packages/a/src/index.js'],
    })
    // CONTROL: a task with no cache has no key to name it for.
    expect(sandboxFix(denials, project, dir)?.workspaceFiles).toBeUndefined()
  })

  // A root task's `inputs.files` stops at a member project, and `vx lock`
  // refuses a glob into one: the read there is named for workspaceFiles.
  it('names a read in a nested project for inputs.workspaceFiles', () => {
    const at = (p: string) => path.join(dir, p)
    const read = (p: string) => v('deny(1) file-read-data', ['read'], at(p))
    const denials = [read('packages/a/tsconfig.json'), read('tsconfig.json')]
    const inputs = { files: ['src/**'] }
    expect(
      sandboxFix(denials, dir, dir, undefined, inputs, [], undefined, [at('packages/a')]),
    ).toEqual({
      read: ['packages/a/tsconfig.json', 'tsconfig.json'],
      inputs: ['tsconfig.json'],
      workspaceFiles: ['packages/a/tsconfig.json'],
    })
  })

  it('never turns a credential path into a grant', () => {
    const home = (p: string) => path.join(os.homedir(), p)
    const read = (p: string) => v('deny(1) file-read-data', ['read'], p)
    const fix = sandboxFix(
      [
        read(home('.ssh/id_ed25519')),
        read(home('.ssh')),
        read(home('.aws/credentials')),
        read(home('.gnupg/pubring.kbx')),
        read(home('.kube/config')),
        read(home('.config/gh/hosts.yml')),
        read(home('.docker/config.json')),
        read(home('.netrc')),
        read(home('.git-credentials')),
        read(home('.pypirc')),
        read(home('.config/gcloud/credentials.db')),
        read(path.join(dir, '.env')),
        v('deny(1) file-write-create', ['write'], path.join(dir, '.env.local')),
        // Near misses stay grants.
        read(home('.sshrc')),
        read(home('.config/ghx')),
        read(path.join(dir, '.envrc')),
        read(path.join(dir, 'env')),
      ],
      dir,
      dir,
    )
    expect(fix).toEqual({
      read: ['.envrc', 'env', '~/.config/ghx', '~/.sshrc'],
      withheld: [
        '.env',
        '.env.local',
        '~/.aws/credentials',
        '~/.config/gcloud/credentials.db',
        '~/.config/gh/hosts.yml',
        '~/.docker/config.json',
        '~/.git-credentials',
        '~/.gnupg/pubring.kbx',
        '~/.kube/config',
        '~/.netrc',
        '~/.pypirc',
        '~/.ssh',
        '~/.ssh/id_ed25519',
      ],
    })
  })

  // A hand copy of the stores here missed the ones the sandbox added later
  // (~/.azure, ~/.vault-token, ~/.pgpass, …): their denials came back as
  // grants an agent would apply.
  it('withholds every store the sandbox denies, and what lies in one', () => {
    const reads = CREDENTIAL_STORES.flatMap((s) => [s, `${s}/x`]).map((s) =>
      v('deny(1) file-read-data', ['read'], path.join(os.homedir(), s)),
    )
    expect(sandboxFix(reads, dir, dir)?.read).toBeUndefined()
  })

  // A task sees $XDG_CONFIG_HOME and $XDG_DATA_HOME, so a CLI reads its
  // login there, not under ~/.config or ~/.local/share.
  it('withholds a store where XDG moved it', () => {
    const saved = { c: process.env['XDG_CONFIG_HOME'], d: process.env['XDG_DATA_HOME'] }
    process.env['XDG_CONFIG_HOME'] = '/xdg/config'
    process.env['XDG_DATA_HOME'] = '/xdg/data'
    try {
      const read = (p: string) => v('deny(1) file-read-data', ['read'], p)
      expect(
        sandboxFix(
          [
            read('/xdg/config/gh/hosts.yml'),
            read('/xdg/data/com.vercel.cli/auth.json'),
            read('/xdg/config/ghx'),
          ],
          dir,
          dir,
        ),
      ).toEqual({
        read: ['/xdg/config/ghx'],
        withheld: ['/xdg/config/gh/hosts.yml', '/xdg/data/com.vercel.cli/auth.json'],
      })
    } finally {
      for (const [k, val] of [
        ['XDG_CONFIG_HOME', saved.c],
        ['XDG_DATA_HOME', saved.d],
      ] as const)
        if (val === undefined) delete process.env[k]
        else process.env[k] = val
    }
  })

  it('is undefined when nothing maps, and masks what it names', () => {
    expect(sandboxFix([v('x', undefined, 'x')], dir, dir)).toBeUndefined()
    const fix = sandboxFix(
      [v('deny(1) file-read-data', ['read'], path.join(dir, 'tok-SECRET'))],
      dir,
      dir,
      (t) => t.replaceAll('SECRET', '***'),
    )
    expect(fix).toEqual({ read: ['tok-***'] })
  })
  it('escapes a path the grant would read as a pattern, and names the directory of one no grant spells', () => {
    // Raw, `pages/[id].tsx` granted the class `pages/i.tsx` and keyed it:
    // applying the fix failed the run again on the same read, forever.
    const at = (p: string) => path.join(dir, p)
    mkdirSync(at('pages'))
    mkdirSync(at('odd'))
    for (const f of ['pages/[id].tsx', 'odd/a*b.txt', 'odd/c\\d.txt']) writeFileSync(at(f), '')
    const read = (p: string) => v(`deny(1) file-read-data ${p}`, ['read'], at(p))
    const fix = sandboxFix(
      [read('pages/[id].tsx'), read('odd/a*b.txt'), read('odd/c\\d.txt')],
      dir,
      dir,
      undefined,
      { files: ['src/**'] },
    )
    expect(fix).toEqual({
      // A literal `*` or a backslash: the sandbox grants no such path alone.
      read: ['odd/', 'pages/\\[id\\].tsx'],
      inputs: ['odd/a[*]b.txt', 'odd/c\\\\d.txt', 'pages/\\[id\\].tsx'],
    })
    expect(new Bun.Glob(fix!.read![1]!).match('pages/[id].tsx')).toBe(true)
    expect(new Bun.Glob(fix!.read![1]!).match('pages/i.tsx')).toBe(false)
    expect(new Bun.Glob(fix!.inputs![0]!).match('odd/a*b.txt')).toBe(true)
    expect(new Bun.Glob(fix!.inputs![1]!).match('odd/c\\d.txt')).toBe(true)
  })
  // Each entry named for `inputs` is applied as given: `!notes` was a
  // negation that keyed nothing, so an edit replayed the old bytes, and
  // `st\*r` was refused as a Windows separator.
  it('names each awkward file by a key entry the config accepts that matches it alone', () => {
    const names = ['!x', 'st*r', 'q?', '[b]', '{c}', 'a\\b', '#h', ' lead', 'trail ', 'a/!y']
    mkdirSync(path.join(dir, 'a'))
    for (const n of names) writeFileSync(path.join(dir, n), '')
    const all = [...names, 'x', 'stXr', 'qa', 'b', 'c', 'lead', 'trail', 'a/y']
    for (const n of names) {
      const fix = sandboxFix(
        [v(`deny(1) file-read-data ${n}`, ['read'], path.join(dir, n))],
        dir,
        dir,
        undefined,
        { files: ['src/**'] },
      )
      const [entry] = fix?.inputs ?? []
      expect(fix?.inputs).toHaveLength(1)
      const files = ['src/**', entry!]
      expect(() =>
        validateProjectConfig(
          {
            tasks: {
              t: { exec: { command: 'x' }, cache: true, inputs: { files }, outputs: { files: [] } },
            },
          } as never,
          path.join(dir, 'vx.config.ts'),
        ),
      ).not.toThrow()
      expect(all.filter((f) => new Bun.Glob(entry!).match(f))).toEqual([n])
      expect(all.filter(anyTaskGlob([entry!]))).toEqual([n])
    }
  })
  // `bun build --compile` stages a random `.<hex>-<n>.bun-build` in its
  // cwd: the fix granted that one name, and the next run used another.
  it('grants no per-run temp name, and names the ignore glob the docs give instead', () => {
    mkdirSync(path.join(dir, 'sub'))
    const temps = [
      '.822aa61db00eaa87-00000000.bun-build',
      'sub/.0123456789abcdef-00000001.bun-build',
    ]
    const denied = [
      ...temps.map((t) => v(`openat(${t}) = -1 EROFS`, ['write'], path.join(dir, t))),
      v('mkdir(out) = -1 EROFS', ['write'], path.join(dir, 'out')),
    ]
    expect(sandboxFix(denied, dir, dir)).toEqual({ write: ['out/'] })
    const hint = perRunWriteHint(denied, dir, dir)
    expect(hint?.hint).toBe(true)
    expect(hint?.line).toContain("ignore: { write: ['*.bun-build', 'sub/*.bun-build'] }")
    expect(perRunWriteHint(denied.slice(2), dir, dir)).toBeUndefined()
  })
  // vite bundles its config to `node_modules/.vite-temp/vite.config.ts.timestamp-<ms>-<hex>.mjs`,
  // a new name each run: the fix granted that one name, and the next run
  // failed on the next. Its directory is the grant.
  it('grants the directory of a file named for the time it was made', () => {
    const t = 'node_modules/.vite-temp/vite.config.ts.timestamp-1794447859277-f7b41ce9b866.mjs'
    const denied = [v(`openat(${t}) = -1 EROFS`, ['write'], path.join(dir, t))]
    const inputs = { files: ['src/**', 'tsconfig*.json'] }
    expect(sandboxFix(denied, dir, dir, undefined, inputs)).toEqual({
      write: ['node_modules/.vite-temp/'],
    })
  })

  // vite 5 bundles it beside the config, in the project itself: its
  // directory was `./`, the whole project writable, sources too. A glob over
  // the name's clock and what follows it covers every run's file.
  it('grants a file named for the time it was made in the project itself by a glob, never the project', () => {
    const t = 'vite.config.ts.timestamp-1794464558889-c9bf267daafa9.mjs'
    const denied = [v(`openat(${t}) = -1 EROFS`, ['write'], path.join(dir, t))]
    expect(sandboxFix(denied, dir, dir, undefined, { files: ['src/**'] })).toEqual({
      write: ['vite.config.ts.timestamp-*.mjs'],
    })
  })

  // A write in `node_modules` granted the whole of it: every installed
  // package writable, so a test could rewrite a dependency the next task
  // runs. The grant is the tool's own directory there.
  it('grants a tool its own directory in node_modules, never node_modules whole', () => {
    const write = (p: string) => v(`openat(${p}) = -1 EROFS`, ['write'], path.join(dir, p))
    const fix = (ps: string[], inputs?: { files: string[] }) =>
      sandboxFix(ps.map(write), dir, dir, undefined, inputs)?.write
    expect(fix(['node_modules/.vite/vitest/da39a3ee5e6b4b0d/results.json'])).toEqual([
      'node_modules/.vite/',
    ])
    expect(fix(['node_modules/.cache/storybook/dev-server/a.json'])).toEqual([
      'node_modules/.cache/storybook/',
    ])
    expect(
      fix(['node_modules/.prisma/client/index.js', 'node_modules/.prisma/client/a.d.ts']),
    ).toEqual(['node_modules/.prisma/'])
    // Two tools' directories stay two: their common one is node_modules.
    expect(
      fix(['node_modules/.vite/deps/a.js', 'node_modules/.cache/storybook/b.json'], {
        files: ['src/**'],
      }),
    ).toEqual(['node_modules/.cache/storybook/', 'node_modules/.vite/'])
    expect(fix(['packages/x/node_modules/@scope/pkg/gen.js'])).toEqual([
      'packages/x/node_modules/@scope/pkg/',
    ])
    expect(fix(['node_modules/.package-lock.json'])).toEqual(['node_modules/.package-lock.json'])
    // `mkdir -p` is refused at its first missing directory: no tool named yet.
    const mkdir = v(
      'mkdir(node_modules/.cache) = -1 EROFS',
      ['write'],
      path.join(dir, 'node_modules/.cache'),
    )
    expect(sandboxFix([mkdir], dir, dir)?.write).toEqual(['node_modules/.cache/'])
    // An input that reaches there still takes the file alone.
    expect(fix(['node_modules/.vite/deps/a.js'], { files: ['**/*.js'] })).toEqual([
      'node_modules/.vite/deps/a.js',
    ])
  })

  // graphql-codegen writes its declared output `src/generated/`: the grant
  // was `src/`, every source file writable.
  it('grants a write under a declared output that output’s directory', () => {
    const write = (p: string) => v(`openat(${p}) = -1 EROFS`, ['write'], path.join(dir, p))
    const outputs = { files: ['src/generated/**', 'out.txt'] }
    const fix = (files: string[]) =>
      sandboxFix(
        [write('src/generated/a/graphql.ts'), write('out.txt'), write('dist/x/y.js')],
        dir,
        dir,
        undefined,
        { files },
        [],
        outputs,
      )?.write
    expect(fix(['schema.graphql'])).toEqual(['dist/', 'out.txt', 'src/generated/'])
    expect(fix(['src/**', '!src/generated/**'])).toEqual(['dist/', 'out.txt', 'src/generated/'])
    // CONTROL: the inputs read it, so the task may not write there.
    expect(fix(['src/**'])).toEqual(['dist/', 'out.txt', 'src/generated/a/graphql.ts'])
    // Its first write is often the directory itself (`mkdir -p src/generated`).
    const mkdir = v('mkdir(src/generated) = -1 EROFS', ['write'], path.join(dir, 'src/generated'))
    expect(sandboxFix([mkdir], dir, dir, undefined, undefined, [], outputs)?.write).toEqual([
      'src/generated/',
    ])
  })

  // Prisma writes the client beside `@prisma/client` in the workspace's
  // install, here bun's store: its declared output's directory is the
  // store whole, the tool's own directory is narrower.
  it('grants a write in the workspace’s node_modules the tool’s directory there', () => {
    const project = path.join(dir, 'packages', 'db')
    const client = 'node_modules/.bun/@prisma+client@6/node_modules/.prisma/client'
    const denied = ['default.js', 'index.d.ts'].map((f) =>
      v('deny(1) file-write-create', ['write'], path.join(dir, client, f)),
    )
    const outputs = {
      files: [],
      workspaceFiles: [`node_modules/.bun/@prisma+client@*/node_modules/.prisma/client/**`],
    }
    expect(
      sandboxFix(denied, project, dir, undefined, { files: ['**'] }, [], outputs)?.write,
    ).toEqual(['../../node_modules/.bun/@prisma+client@6/node_modules/.prisma/'])
    // Elsewhere outside the project, the path alone, as before.
    const other = v('deny(1) file-write-create', ['write'], path.join(dir, 'packages/a/dist/o.js'))
    expect(sandboxFix([other], project, dir, undefined, undefined, [], outputs)?.write).toEqual([
      '../a/dist/o.js',
    ])
  })
})
