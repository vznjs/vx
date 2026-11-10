// A hit gives each output directory it makes the mode the miss left. It made
// every one with mkdir's default: a `chmod 700 dist/keys` came back 0755 on a
// fresh checkout or after `rm -rf dist`, and every user on the machine could
// read the 0644 files the directory had kept to its owner.

import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

/**
 * `rm -rf` of a tree the task left `dist/ro` 0555 in: the remove needs
 * write on each directory it empties, which only root has without it.
 */
function rmTree(dir: string): void {
  const open = (d: string): void => {
    const st = lstatSync(d, { throwIfNoEntry: false })
    if (st === undefined || !st.isDirectory()) return
    chmodSync(d, 0o700)
    for (const n of readdirSync(d)) open(path.join(d, n))
  }
  open(dir)
  rmSync(dir, { recursive: true, force: true })
}

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmTree(d)
})

const modes = (dir: string, names: string[]) =>
  names.map((n) => `${n} ${(statSync(path.join(dir, n)).mode & 0o777).toString(8)}`)

const NAMES = ['dist', 'dist/keys', 'dist/keys/id', 'dist/ro', 'dist/empty', 'dist/open']
const EXPECTED = [
  'dist 755',
  'dist/keys 700',
  'dist/keys/id 644',
  'dist/ro 555',
  'dist/empty 700',
  'dist/open 755',
]

// Under the store's 32 KiB inline limit the hit reads the archive; past it,
// the store keeps plain files and a hit into absent outputs copies them out.
for (const [form, extra] of [
  ['an inline archive', ''],
  ['a plain-file tree', ' && head -c 100000 /dev/zero > dist/open/big'],
] as const) {
  it.skipIf(process.platform === 'win32')(
    `a hit from ${form} restores the modes of the output directories it makes`,
    async () => {
      const before = process.umask(0o022)
      try {
        const root = await makeWorkspace({ prefix: 'vx-dir-mode-' })
        made.push(root)
        const app = await addProject(root, 'app', {
          config: `export default { tasks: { build: {
            exec: { command: 'mkdir -p dist/keys dist/ro dist/empty dist/open && echo k > dist/keys/id && echo r > dist/ro/f && echo o > dist/open/f${extra} && chmod 700 dist/keys dist/empty && chmod 555 dist/ro' },
            inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
          } } }`,
          files: { 'src/a.txt': 'a\n', '.gitignore': 'dist/\n' },
        })
        const git = gitIn(root)
        git('add', '-A')
        git('commit', '-q', '-m', 'init')
        const cacheDir = path.join(root, '.cache')
        const build = () => vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
        const cold = await build()
        expect(`${cold.code}\n${cold.err}`).toStartWith('0\n')
        expect(modes(app, NAMES)).toEqual(EXPECTED)

        rmTree(path.join(app, 'dist'))
        const fresh = await build()
        expect(`${fresh.code}\n${fresh.err}`).toStartWith('0\n')
        expect(fresh.out + fresh.err).toContain('local 1↓')
        expect(modes(app, NAMES)).toEqual(EXPECTED)

        // A restore into a tree that is partly there makes only what is missing.
        rmTree(path.join(app, 'dist/keys'))
        writeFileSync(path.join(app, 'dist/open/f'), 'changed\n')
        const partial = await build()
        expect(`${partial.code}\n${partial.err}`).toStartWith('0\n')
        expect(partial.out + partial.err).toContain('local 1↓')
        expect(modes(app, NAMES)).toEqual(EXPECTED)

        // A hit that replaces a file in a directory the task left 0555 gives
        // it owner write for the rename, then its mode back: only root could
        // replace it otherwise, and every later hit there failed EACCES.
        writeFileSync(path.join(app, 'dist/ro/f'), 'edited\n')
        const ro = await build()
        expect(`${ro.code}\n${ro.err}`).toStartWith('0\n')
        expect(ro.out + ro.err).toContain('local 1↓')
        expect(readFileSync(path.join(app, 'dist/ro/f'), 'utf8')).toBe('r\n')
        expect(modes(app, NAMES)).toEqual(EXPECTED)

        // Every file gone but `dist/ro` left standing 0555: the tree's
        // copy-out writes into it, and as the extractor's rename does, it
        // opens the directory for the write and gives its mode back.
        for (const d of ['dist/keys', 'dist/empty', 'dist/open']) rmTree(path.join(app, d))
        chmodSync(path.join(app, 'dist/ro'), 0o755)
        rmSync(path.join(app, 'dist/ro/f'))
        chmodSync(path.join(app, 'dist/ro'), 0o555)
        const into = await build()
        expect(`${into.code}\n${into.err}`).toStartWith('0\n')
        expect(into.out + into.err).toContain('local 1↓')
        expect(readFileSync(path.join(app, 'dist/ro/f'), 'utf8')).toBe('r\n')
        expect(modes(app, NAMES)).toEqual(EXPECTED)

        // The tree it leaves is current: the next hit restores nothing.
        const again = await build()
        expect(`${again.code}\n${again.err}`).toStartWith('0\n')
        expect(again.out + again.err).toContain('local 1✓')
      } finally {
        process.umask(before)
      }
    },
    60_000,
  )
}

// A hit onto a directory that stands gives it the recorded mode too: a
// branch switch A (700) → B (755) → A kept B's 0755, and the keys A's task
// kept to their owner were readable by every user.
it.skipIf(process.platform === 'win32')(
  'a hit gives a standing output directory its recorded mode',
  async () => {
    const before = process.umask(0o022)
    try {
      const root = await makeWorkspace({ prefix: 'vx-dir-mode-switch-' })
      made.push(root)
      const app = await addProject(root, 'app', {
        config: `export default { tasks: { build: {
          exec: { command: 'mkdir -p dist/keys && echo k > dist/keys/id && chmod $(cat src/mode) dist/keys' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        } } }`,
        files: { 'src/mode': '700\n', '.gitignore': 'dist/\n' },
      })
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      const cacheDir = path.join(root, '.cache')
      const build = () => vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      const keys = path.join(app, 'dist/keys')
      const mode = () => (statSync(keys).mode & 0o777).toString(8)
      for (const m of ['700', '755']) {
        writeFileSync(path.join(app, 'src/mode'), `${m}\n`)
        const miss = await build()
        expect(`${miss.code}\n${miss.err}`).toStartWith('0\n')
        expect(mode()).toBe(m)
      }
      writeFileSync(path.join(app, 'src/mode'), '700\n')
      const hit = await build()
      expect(`${hit.code}\n${hit.err}`).toStartWith('0\n')
      expect(hit.out + hit.err).toContain('local 1↓')
      expect(mode()).toBe('700')

      // A mode changed by hand, the files untouched, makes the tree stale;
      // the new mtime only sends the hit past the directory snapshot.
      chmodSync(keys, 0o755)
      utimesSync(keys, new Date(), new Date(Date.now() + 5000))
      const chmodded = await build()
      expect(`${chmodded.code}\n${chmodded.err}`).toStartWith('0\n')
      expect(chmodded.out + chmodded.err).toContain('local 1↓')
      expect(mode()).toBe('700')

      const again = await build()
      expect(`${again.code}\n${again.err}`).toStartWith('0\n')
      expect(again.out + again.err).toContain('local 1✓')
    } finally {
      process.umask(before)
    }
  },
  60_000,
)

// The save records only a mode narrower than 0755, so a directory the miss
// left 0755 carried none, and a hit kept whatever stood there: B's 0555 or
// 0700 after a switch B → A, or a hand's chmod, which the hit even called
// current (`local 1✓`) and restored nothing.
it.skipIf(process.platform === 'win32')(
  'a hit gives a standing output directory 0755 where the entry records no mode',
  async () => {
    const before = process.umask(0o022)
    try {
      const root = await makeWorkspace({ prefix: 'vx-dir-mode-wide-' })
      made.push(root)
      const app = await addProject(root, 'app', {
        config: `export default { tasks: { build: {
          exec: { command: 'mkdir -p dist/s && echo a > dist/s/f && chmod $(cat src/mode) dist/s' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
        } } }`,
        files: { 'src/mode': '755\n', '.gitignore': 'dist/\n' },
      })
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      const cacheDir = path.join(root, '.cache')
      const build = () => vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      const sub = path.join(app, 'dist/s')
      const mode = (dir = sub) => (statSync(dir).mode & 0o777).toString(8)
      for (const m of ['700', '555', '755']) {
        writeFileSync(path.join(app, 'src/mode'), `${m}\n`)
        const miss = await build()
        expect(`${miss.code}\n${miss.err}`).toStartWith('0\n')
        expect(mode()).toBe(m)
      }
      for (const m of ['700', '555']) {
        writeFileSync(path.join(app, 'src/mode'), `${m}\n`)
        const narrow = await build()
        expect(`${narrow.code}\n${narrow.err}`).toStartWith('0\n')
        expect(mode()).toBe(m)
        writeFileSync(path.join(app, 'src/mode'), '755\n')
        const hit = await build()
        expect(`${hit.code}\n${hit.err}`).toStartWith('0\n')
        expect(hit.out + hit.err).toContain('local 1↓')
        expect(mode()).toBe('755')
      }

      // A hand's chmod, the files and the directory's mtime untouched, and
      // of the output root as well as a directory below it.
      for (const [dir, m] of [
        [sub, 0o700],
        [sub, 0o555],
        [path.join(app, 'dist'), 0o700],
      ] as const) {
        chmodSync(dir, m)
        const chmodded = await build()
        expect(`${chmodded.code}\n${chmodded.err}`).toStartWith('0\n')
        expect(chmodded.out + chmodded.err).toContain('local 1↓')
        expect(mode(dir)).toBe('755')
        const again = await build()
        expect(`${again.code}\n${again.err}`).toStartWith('0\n')
        expect(again.out + again.err).toContain('local 1✓')
      }
    } finally {
      process.umask(before)
    }
  },
  60_000,
)
