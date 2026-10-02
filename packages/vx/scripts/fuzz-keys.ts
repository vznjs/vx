// A differential fuzzer for stale hits. It builds a two-project workspace
// whose tasks print what they read (each input file's name, mode bit, link
// target or bytes; a config import; a cached producer's output; a
// `workspaceFiles` input; the upstream's output), then applies random
// edits (content, same-size rewrites with the mtime put back, chmod,
// symlinks, renames, `git add`/commit/stash/pop/checkout/reset/`add -N`,
// index flags, `.gitignore`, `.gitattributes`, `core.autocrlf`, output
// tampering) and runs `vx run build --all` after each. Every output must
// then be what the current inputs produce: a mismatch is a hit that
// replayed bytes its key no longer describes. It found A-59, A-60 and A-61.
//
//   bun scripts/fuzz-keys.ts <dir> [steps=300] [seed=1] [--policies]
//
// `<dir>` is deleted and rebuilt. A seed replays exactly. `--policies`
// runs each step under a random `--force` / `--no-cache` / `--cache=…`.
// Git runs with no global or system config. A failure prints the step, the
// op and both outputs, and exits 2; a vx failure exits 1.
import { execSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const policies = process.argv.includes('--policies')
const root = path.resolve(args[0] ?? '')
if (args[0] === undefined) {
  console.error('usage: bun scripts/fuzz-keys.ts <dir> [steps] [seed] [--policies]')
  process.exit(64)
}
const steps = Number(args[1] ?? 300)
let seed = Number(args[2] ?? 1)
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!
const VX = path.join(import.meta.dir, '..', 'src', 'bin.ts')
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const sh = (c: string): string => execSync(c, { cwd: root, env, stdio: 'pipe' }).toString()
const at = (...p: string[]): string => path.join(root, ...p)
const byBytes = (x: string, y: string): number => Buffer.compare(Buffer.from(x), Buffer.from(y))

// Each `src` file git lists (tracked or untracked, not ignored) that is on
// disk: `F <name> <x|-> <bytes>` or `L <name> <target>`.
const LIST = `mkdir -p dist src; : > dist/out.txt; (git ls-files -co --exclude-standard -- src | while IFS= read -r g; do [ -e "$g" ] || [ -L "$g" ] && echo "./\${g#src/}"; done | LC_ALL=C sort -u) | while IFS= read -r f; do p="src/$f"; if [ -L "$p" ]; then echo "L $f $(readlink "$p")" >> dist/out.txt; else if [ -x "$p" ]; then x=x; else x=-; fi; echo "F $f $x $(cat "$p")" >> dist/out.txt; fi; done`
const SHARED = `(cd ../.. && git ls-files -co --exclude-standard -- shared | LC_ALL=C sort -u | while IFS= read -r g; do [ -f "$g" ] && echo "S $g $(cat "$g")"; done; true) >> dist/out.txt`

rmSync(root, { recursive: true, force: true })
for (const p of ['a', 'b']) mkdirSync(at('packages', p, 'src'), { recursive: true })
mkdirSync(at('shared'))
writeFileSync(at('package.json'), '{"name":"root","private":true,"workspaces":["packages/*"]}')
// `conf.mjs` is ignored so a stash conflict never writes markers into it.
writeFileSync(at('.gitignore'), '.vx/\ndist/\nconf.mjs\n')
writeFileSync(at('conf.mjs'), "export const SUFFIX = 'v1'\n")
writeFileSync(at('shared/s1'), 'x')
writeFileSync(at('packages/a/package.json'), '{"name":"a"}')
writeFileSync(at('packages/a/gen.sh'), LIST)
writeFileSync(at('packages/a/seed'), 's1')
writeFileSync(
  at('packages/a/vx.config.mjs'),
  `import { SUFFIX } from '../../conf.mjs'
export default {
  tasks: {
    gen: {
      exec: { command: 'mkdir -p gen && cp seed gen/g' },
      cache: { inputs: { files: ['seed'] }, outputs: { files: ['gen/**'] } },
    },
    build: {
      dependsOn: ['gen'],
      exec: { command: 'sh gen.sh && echo ' + SUFFIX + ' >> dist/out.txt && cat gen/g >> dist/out.txt' },
      cache: { inputs: { files: ['src/**', 'gen.sh', 'gen/**'], tasks: [] }, outputs: { files: ['dist/**'] } },
    },
  },
}
`,
)
writeFileSync(at('packages/b/package.json'), '{"name":"b","dependencies":{"a":"workspace:*"}}')
writeFileSync(at('packages/b/gen.sh'), `${LIST}; cat ../a/dist/out.txt >> dist/out.txt; ${SHARED}`)
writeFileSync(
  at('packages/b/vx.config.mjs'),
  `export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'sh gen.sh' },
      cache: {
        inputs: { files: ['src/**', 'gen.sh'], workspaceFiles: ['shared/**'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
}
`,
)
for (const p of ['a', 'b']) writeFileSync(at('packages', p, 'src/f1'), 'init')
sh(
  'git init -q && git config user.email f@f && git config user.name f && git config commit.gpgsign false',
)
sh('git add -A && git commit -qm init')

/** git's view of `dir` (tracked or untracked, not ignored), deduplicated, on disk. */
function listed(dir: string): Set<string> {
  const out = execSync(`git ls-files -co --exclude-standard -z -- ${dir}`, { cwd: root, env })
  return new Set(out.toString().split('\0').filter(Boolean))
}

function srcListing(p: string): string {
  const src = at('packages', p, 'src')
  if (!existsSync(src)) return ''
  const known = listed(`packages/${p}/src`)
  const files: string[] = []
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (known.has(`packages/${p}/src/${r}`)) files.push(r)
    }
  }
  walk('')
  let out = ''
  for (const f of files.map((r) => `./${r}`).sort(byBytes)) {
    const abs = path.join(src, f)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) out += `L ${f} ${readlinkSync(abs)}\n`
    else {
      const bytes = readFileSync(abs, 'utf8').replace(/\n+$/, '')
      out += `F ${f} ${(st.mode & 0o100) !== 0 ? 'x' : '-'} ${bytes}\n`
    }
  }
  return out
}

function expected(): { a: string; b: string } {
  const suffix = /'(.*)'/.exec(readFileSync(at('conf.mjs'), 'utf8'))![1]
  const a = `${srcListing('a')}${suffix}\n${readFileSync(at('packages/a/seed'), 'utf8')}`
  const shared = [...listed('shared')]
    .filter((g) => existsSync(at(g)) && lstatSync(at(g)).isFile())
    .sort(byBytes)
    .map((g) => `S ${g} ${readFileSync(at(g), 'utf8').replace(/\n+$/, '')}\n`)
  return { a, b: srcListing('b') + a + shared.join('') }
}

/** Rewrite `file` with other bytes of the same length and put its times back. */
function forge(file: string, other: (now: string) => string): void {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return
  const st = lstatSync(file)
  writeFileSync(file, other(readFileSync(file, 'utf8')))
  utimesSync(file, st.atime, st.mtime)
}

const names = ['f1', 'f2', 'f3', 'sub/f4']
const src = (p: string, f: string): string => at('packages', p, 'src', f)
const ops: Array<[string, (p: string) => void]> = [
  [
    'write',
    (p) => {
      const f = src(p, pick(names))
      mkdirSync(path.dirname(f), { recursive: true })
      writeFileSync(f, pick(['aa', 'bb', 'cc', 'ddd']))
    },
  ],
  ['forge', (p) => forge(src(p, pick(names)), (c) => (c === 'aa' ? 'bb' : 'a'.repeat(c.length)))],
  ['delete', (p) => rmSync(src(p, pick(names)), { force: true })],
  [
    'chmod',
    (p) => {
      const f = src(p, pick(names))
      if (existsSync(f) && !lstatSync(f).isSymbolicLink()) chmodSync(f, pick([0o644, 0o755]))
    },
  ],
  [
    'symlink',
    (p) => {
      const f = src(p, pick(['f2', 'f3']))
      rmSync(f, { force: true })
      symlinkSync(pick(['f1', 'nope', 'sub/f4']), f)
    },
  ],
  [
    'rename',
    (p) => {
      const [from, to] = [src(p, pick(names)), src(p, pick(names))]
      if (from === to || !existsSync(from)) return
      mkdirSync(path.dirname(to), { recursive: true })
      rmSync(to, { force: true })
      renameSync(from, to)
    },
  ],
  [
    'crlf',
    (p) => {
      const f = src(p, pick(names))
      if (existsSync(f) && !lstatSync(f).isSymbolicLink())
        writeFileSync(f, pick(['aa\r\n', 'aa\n', 'b\r\nb']))
    },
  ],
  ['git-add', () => sh('git add -A')],
  ['git-commit', () => sh('git add -A && git commit -qm x --allow-empty')],
  ['git-stash', () => sh('git stash -q -u || true')],
  ['git-stash-pop', () => sh('git stash pop -q || true')],
  ['git-checkout', () => sh('git checkout -q -- . || true')],
  ['git-ita', (p) => sh(`git add -N packages/${p}/src || true`)],
  ['git-reset', () => sh('git reset -q || true')],
  [
    'index-flag',
    (p) =>
      sh(
        `git update-index --${pick(['assume-unchanged', 'no-assume-unchanged', 'skip-worktree', 'no-skip-worktree', 'chmod=+x', 'chmod=-x'])} packages/${p}/src/${pick(names)} 2>/dev/null || true`,
      ),
  ],
  [
    'ignore',
    (p) => writeFileSync(at('packages', p, '.gitignore'), pick(['', 'src/f3\n', 'src/sub/\n'])),
  ],
  [
    'attrs',
    (p) =>
      writeFileSync(
        at('packages', p, '.gitattributes'),
        pick(['', '* text eol=crlf\n', '* text=auto\n', 'src/f1 -text\n']),
      ),
  ],
  ['autocrlf', () => sh(`git config core.autocrlf ${pick(['true', 'false', 'input'])}`)],
  ['shared-write', () => writeFileSync(at('shared', pick(['s1', 's2'])), pick(['x', 'y', 'zz']))],
  [
    'shared-forge',
    () => forge(at('shared', pick(['s1', 's2'])), (c) => (c === 'x' ? 'y' : 'x'.repeat(c.length))),
  ],
  ['shared-rm', () => rmSync(at('shared', pick(['s1', 's2'])), { force: true })],
  ['seed', () => writeFileSync(at('packages/a/seed'), pick(['s1', 's2', 's33']))],
  [
    'seed-forge',
    () => forge(at('packages/a/seed'), (c) => (c === 's1' ? 's2' : 's'.repeat(c.length))),
  ],
  [
    'gen-forge',
    () => forge(at('packages/a/gen/g'), (c) => (c === 's1' ? 's2' : 's'.repeat(c.length))),
  ],
  ['gen-rm', () => rmSync(at('packages/a/gen'), { recursive: true, force: true })],
  [
    'conf',
    () => writeFileSync(at('conf.mjs'), `export const SUFFIX = '${pick(['v1', 'v2', 'v33'])}'\n`),
  ],
  [
    'conf-forge',
    () =>
      forge(at('conf.mjs'), (c) =>
        c.replace(
          /'(v\w+)'/,
          (_, v: string) => `'${{ v1: 'v2', v2: 'v1', v33: 'v44' }[v] ?? 'v33'}'`,
        ),
      ),
  ],
  [
    'out-forge',
    (p) =>
      forge(at('packages', p, 'dist/out.txt'), (c) =>
        c.endsWith('1') ? `${c.slice(0, -1)}2` : `${c.slice(0, -1)}1`,
      ),
  ],
  [
    'out-stray',
    (p) => {
      mkdirSync(at('packages', p, 'dist/x'), { recursive: true })
      writeFileSync(at('packages', p, 'dist', pick(['s1', 'x/s2'])), 'stray')
    },
  ],
  [
    'out-rm',
    (p) =>
      rmSync(at('packages', p, pick(['dist', 'dist/out.txt'])), { recursive: true, force: true }),
  ],
  [
    'out-chmod',
    (p) => {
      const f = at('packages', p, 'dist/out.txt')
      if (existsSync(f)) chmodSync(f, pick([0o600, 0o755, 0o644]))
    },
  ],
]

const POLICIES = [[], [], [], ['--force'], ['--no-cache'], ['--cache=local:r'], ['--cache=local:w']]
for (let i = 0; i < steps; i++) {
  const [name, op] = pick(ops)
  const p = pick(['a', 'b'])
  try {
    op(p)
  } catch {
    // An op on a path a stash or a dangling link took away does nothing.
  }
  const flags = policies ? pick(POLICIES) : []
  const r = spawnSync(process.execPath, [VX, 'run', 'build', '--all', ...flags], { cwd: root, env })
  const out = `${r.stdout.toString()}${r.stderr.toString()}`
  if (r.status !== 0) {
    console.log(`step ${i} ${name}@${p} ${flags.join(' ')}: vx exited ${r.status}\n${out}`)
    process.exit(1)
  }
  const want = expected()
  for (const proj of ['a', 'b'] as const) {
    const got = readFileSync(at('packages', proj, 'dist/out.txt'), 'utf8')
    if (got !== want[proj]) {
      console.log(`STALE at step ${i} after ${name}@${p} ${flags.join(' ')} in ${proj}`)
      console.log(`--- expected\n${want[proj]}--- got\n${got}\n${out}`)
      process.exit(2)
    }
  }
  if (i % 50 === 0) console.log(`step ${i} ok`)
}
console.log(`${steps} steps, seed ${args[2] ?? 1}: no stale hit`)
