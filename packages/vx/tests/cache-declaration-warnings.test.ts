// A cache block whose globs match NOTHING is the quiet stale hit: an input
// set that resolves to no files keeps the key still while the source moves,
// and an output set that resolves to no files saves an artifact a later hit
// "restores". Both are said once, on the miss, on the run's status line.

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { lock, run } from './helpers/orchestrator.js'
import { run as runLocked } from '../src/orchestrator/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

let root: string

async function gitInit(dir: string): Promise<void> {
  await Bun.spawn(['git', 'init', '-q'], { cwd: dir }).exited
}

function logger(lines: string[]) {
  return {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: (line: string) => {
      lines.push(line)
    },
  }
}

/** `relock: false` runs on the lock as it stands, as a run does. */
async function runTask(task: string, relock = true): Promise<string[]> {
  const lines: string[] = []
  const summary = await (relock ? run : runLocked)({
    cwd: root,
    tasks: [task],
    projects: ['app'],
    log: logger(lines),
    handleSignals: false,
  })
  expect(summary.ok).toBe(true)
  return lines.filter((l) => l.includes('matched no files'))
}

describe('cache declarations that match nothing', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-decl-warn-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'src', 'index.js'), 'export {}\n')
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: {
        // Both globs against directories that do not exist.
        lost: { exec: { command: 'true' },
          inputs: { files: ['lib/**'] }, outputs: { files: ['build/**'] }, cache: true },
        // A lockfile plugin appends the literal package.json to every task's
        // inputs: it matched, and hid that the source glob matched nothing.
        typo: { exec: { command: 'true' },
          inputs: { files: ['scr/**', 'package.json'] }, outputs: { files: [] }, cache: true },
        // The control: matching inputs, matching outputs.
        found: { exec: { command: 'mkdir -p dist && echo x > dist/a.js' },
          inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true },
        // Only empty directories: the artifact holds them and a hit makes them.
        dirsonly: { exec: { command: 'mkdir -p gen/a/b' },
          inputs: { files: ['src/**'] }, outputs: { files: ['gen/**'] }, cache: true },
        // A deliberate cached no-op: empty outputs say nothing.
        noop: { exec: { command: 'true' },
          inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true },
        // Root-anchored outputs that match nothing. The warning counts
        // BOTH output arrays on each side — declared and resolved — and
        // every fixture above declares only \`files\`, so a task whose
        // whole output declaration is root-anchored went unwarned.
        wslost: { exec: { command: 'true' },
          inputs: { files: ['src/**'] },
          outputs: { files: [], workspaceFiles: ['nowhere/**'] },
          cache: true },
        // The other side of the sum: \`files\` matches nothing but the
        // root-anchored glob DOES match, so the outputs are not empty and
        // there is nothing to warn about. Not \`build/**\`: the lock refuses
        // two tasks declaring one output.
        // Its only input is a link to a directory: the glob reads through it.
        linked: { exec: { command: 'true' },
          inputs: { files: ['vendor/**'] }, outputs: { files: [] }, cache: true },
        // turbo()/nx() add the literal tsconfig.tsbuildinfo to an incremental
        // tsc task: it always matched, and hid that \`tsc --outDir out\` left
        // the wildcard glob empty, so a hit restored only the literal file.
        partial: { exec: { command: 'echo x > partial.info' },
          inputs: { files: ['src/**'] }, outputs: { files: ['emit/**', 'partial.info'] }, cache: true },
        wspartial: { exec: { command: 'echo x > stamp.info' },
          inputs: { files: ['src/**'] },
          outputs: { files: ['stamp.info'], workspaceFiles: ['wsgone/**'] }, cache: true },
        partialok: { exec: { command: 'mkdir -p made && echo x > made/a.js && echo x > made.info' },
          inputs: { files: ['src/**'] }, outputs: { files: ['made/**', 'made.info'] }, cache: true },
        wsfound: { exec: { command: 'mkdir -p ../../shared && echo x > ../../shared/a.js' },
          inputs: { files: ['src/**'] },
          outputs: { files: ['out/**'], workspaceFiles: ['shared/**'] },
          cache: true },
      } }\n`,
    )
    await gitInit(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('the footer counts the warnings on its warn row, and says them no second time', async () => {
    const lines: string[] = []
    await run({
      cwd: root,
      tasks: ['lost'],
      projects: ['app'],
      log: logger(lines),
      handleSignals: false,
    })
    const all = lines.flatMap((l) => l.split('\n'))
    expect(all.find((l) => l.startsWith('  warn'))).toBe('  warn      2 warnings above')
    expect(all.filter((l) => l.includes('matched no files'))).toHaveLength(2)
  })

  it('an input glob and an output glob that match nothing are each named once, on the miss only', async () => {
    const first = await runTask('lost')
    expect(first).toEqual([
      "[vx] app#lost: inputs matched no files (lib/**) — the key will not change when this project's source does",
      '[vx] app#lost: outputs matched no files (build/**) — an empty artifact is saved; a later hit restores nothing',
    ])
    // The hit says nothing: the warning belongs to the run that saved.
    expect(await runTask('lost')).toEqual([])
  })

  // The warning said a hit restores nothing, yet the hit made the directories.
  it('outputs that matched only empty directories are not named', async () => {
    expect(await runTask('dirsonly')).toEqual([])
    await rm(path.join(root, 'packages/app/gen'), { recursive: true })
    expect(await runTask('dirsonly')).toEqual([])
    expect(existsSync(path.join(root, 'packages/app/gen/a/b'))).toBe(true)
  })

  // `vendor -> ../../lib` was listed by the link's name, which `vendor/**`
  // does not match: the warning said the key would not move, yet it did.
  it('a glob that reaches its files only through a linked directory is not named', async () => {
    await mkdir(path.join(root, 'lib'))
    await writeFile(path.join(root, 'lib', 'x.js'), 'x\n')
    await symlink('../../lib', path.join(root, 'packages', 'app', 'vendor'))
    expect(await runTask('linked')).toEqual([])
  })

  it('a wildcard glob that matches nothing is named though a literal input matched', async () => {
    expect(await runTask('typo')).toEqual([
      "[vx] app#typo: inputs matched no files (scr/**) — the key will not change when this project's source does",
    ])
  })

  it('a wildcard output glob that matches nothing is named though a literal output matched', async () => {
    expect(await runTask('partial')).toEqual([
      '[vx] app#partial: outputs matched no files (emit/**) — a later hit restores only the literal files (partial.info)',
    ])
    expect(await runTask('partial')).toEqual([])
    expect((await runTask('wspartial')).filter((l) => l.includes('outputs'))).toEqual([
      '[vx] app#wspartial: outputs matched no files (wsgone/**) — a later hit restores only the literal files (stamp.info)',
    ])
    expect(await runTask('partialok')).toEqual([])
  })

  // A literal output read through a linked parent is nx#37661 (2026-11).
  it.each(['dist/**', 'dist/creds.txt', 'dist/', 'dist'])(
    'an output directory linked out of the project refuses the task by name (M-61, X-88): %s',
    async (output) => {
      // Every file under a `dist` that links out is outside the project. The
      // save once dropped them and stored an empty entry under a warning; the
      // task is refused instead, and nothing is saved. Canonical root: the
      // refusal names real paths.
      root = realpathSync(root)
      const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-decl-out-'))
      try {
        await writeFile(path.join(outside, 'creds.txt'), 'not yours\n')
        await writeFile(
          path.join(root, 'packages', 'app', 'vx.config.mjs'),
          `export default { tasks: { linked: { exec: { command: 'ln -sfn ${outside} dist' },
          inputs: { files: ['src/**'] }, outputs: { files: [${JSON.stringify(output)}] }, cache: true } } }\n`,
        )
        const lines: string[] = []
        const summary = await run({
          cwd: root,
          tasks: ['linked'],
          projects: ['app'],
          log: {
            ...logger(lines),
            taskStderr: (_node: unknown, line: string) => {
              lines.push(line.trimEnd())
            },
          },
          handleSignals: false,
        })
        expect(summary.ok).toBe(false)
        const app = path.join(root, 'packages', 'app')
        expect(lines.filter((l) => l.includes('symbolic link'))).toEqual([
          `[vx] app#linked: ${path.join(app, 'dist')} is a symbolic link to ${realpathSync(outside)}, outside ${app} — vx never cleans, saves or restores declared outputs through a link that leaves the project. Remove the link and re-run, or stop declaring outputs under it.`,
        ])
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    },
  )

  it('and a workspaceFiles directory linked out of the workspace (M-65)', async () => {
    // The root-anchored side dropped every file under a linked-out
    // directory and saved an empty entry under a warning, while the project
    // side refused the task: it is refused the same way now.
    root = realpathSync(root)
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-decl-wsout-'))
    try {
      await writeFile(path.join(outside, 'creds.txt'), 'not yours\n')
      await writeFile(
        path.join(root, 'packages', 'app', 'vx.config.mjs'),
        `export default { tasks: { linked: { exec: { command: 'ln -sfn ${outside} ../../shared' },
          inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['shared/**'] }, cache: true } } }\n`,
      )
      const lines: string[] = []
      const summary = await run({
        cwd: root,
        tasks: ['linked'],
        projects: ['app'],
        log: {
          ...logger(lines),
          taskStderr: (_node: unknown, line: string) => {
            lines.push(line.trimEnd())
          },
        },
        handleSignals: false,
      })
      expect(summary.ok).toBe(false)
      expect(lines.filter((l) => l.includes('symbolic link') || l.includes('matched no'))).toEqual([
        `[vx] app#linked: ${path.join(root, 'shared')} is a symbolic link to ${realpathSync(outside)}, outside ${root} — vx never cleans, saves or restores declared outputs through a link that leaves the workspace. Remove the link and re-run, or stop declaring outputs under it.`,
      ])
      expect(await Bun.file(path.join(outside, 'creds.txt')).text()).toBe('not yours\n')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('a hit with no rows is up-to-date while its globs still match nothing, and wipes a stray', async () => {
    // The warned entry holds no rows. Before item 589 its every hit
    // extracted the empty artifact and reported a restore; now the hit is
    // a no-op when the globs match nothing — and still a clean when a
    // stray sits under them, which strict ownership requires.
    const outcomes = async (): Promise<Record<string, boolean | undefined>> => {
      const summary = await run({
        cwd: root,
        tasks: ['lost'],
        projects: ['app'],
        log: logger([]),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      return Object.fromEntries(summary.outcomes.map((o) => [o.node.taskName, o.restored]))
    }
    await outcomes()
    expect(await outcomes()).toEqual({ lost: false })
    const stray = path.join(root, 'packages', 'app', 'build', 'stray.js')
    await mkdir(path.dirname(stray), { recursive: true })
    await writeFile(stray, 'x')
    expect(await outcomes()).toEqual({ lost: true })
    expect(await Bun.file(stray).exists()).toBe(false)
  })

  it('and the root-anchored twin: a stray under a workspaceFiles glob that saved nothing is wiped', async () => {
    // The project glob still matches nothing here; only the root-anchored
    // one sees the stray (C-24: the hit read the project side alone).
    const outcomes = async (): Promise<Record<string, boolean | undefined>> => {
      const summary = await run({
        cwd: root,
        tasks: ['wslost'],
        projects: ['app'],
        log: logger([]),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      return Object.fromEntries(summary.outcomes.map((o) => [o.node.taskName, o.restored]))
    }
    await outcomes()
    expect(await outcomes()).toEqual({ wslost: false })
    const stray = path.join(root, 'nowhere', 'stray.js')
    await mkdir(path.dirname(stray), { recursive: true })
    await writeFile(stray, 'x')
    expect(await outcomes()).toEqual({ wslost: true })
    expect(await Bun.file(stray).exists()).toBe(false)
  })

  it('the output warning blames the sandbox only when there IS one', async () => {
    // `app#lost` is not sandboxed, so the cause clause added for sandboxed
    // tasks with no write grant (item 444) must not appear here. The
    // clause's own rows live in `sandbox-grants.unsafe.test.ts`, which
    // needs a real sandbox; this is the half that runs everywhere.
    const lines = await runTask('lost')
    const out = lines.find((l) => l.includes('outputs'))
    expect(out).toBeDefined()
    expect(out).not.toContain('exec.sandbox.allow.write')
  })

  it('counts BOTH output arrays, declared and resolved', async () => {
    // Declared only as workspaceFiles, matching nothing: the warning names
    // the root-anchored glob. Reading only `outputs.files` on the declared
    // side leaves this task silent about an empty artifact.
    expect((await runTask('wslost')).filter((l) => l.includes('outputs'))).toEqual([
      '[vx] app#wslost: outputs matched no files (nowhere/**) — an empty artifact is saved; a later hit restores nothing',
    ])
    // And the resolved side: `files` matched nothing, but the root-anchored
    // glob did, so the artifact is NOT empty and nothing is said. Reading
    // only `outputFiles` here would warn about a task that saved outputs.
    expect((await runTask('wsfound')).filter((l) => l.includes('outputs'))).toEqual([])
  })

  it('a bracket glob naming a file that exists says to escape it', async () => {
    // `src/[id].txt` is a character class, so it matches `src/i.txt` or
    // `src/d.txt`, never the route-style file beside it: the key stops
    // following that file and an edit to it replays the old output. When
    // the pattern read literally names something on disk, the warning
    // gives the escaped spelling. `vx lock` refuses such a glob while the
    // path exists (lock-bracket-literal.test.ts), so here it is made after
    // the lock, as a run that trusts the lock meets it.
    const app = path.join(root, 'packages', 'app')
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: {
        route: { exec: { command: "mkdir -p 'out/[slug]' && echo x > 'out/[slug]/page.js'" },
          inputs: { files: ['src/[id].txt'] }, outputs: { files: ['out/[slug]/**'] }, cache: true },
        // A bracket glob naming nothing on disk keeps the plain warning.
        cls: { exec: { command: 'true' },
          inputs: { files: ['lib/[ab].txt'] }, outputs: { files: ['build/[ab]/**'] }, cache: true },
      } }\n`,
    )
    await lock(root)
    await writeFile(path.join(app, 'src', '[id].txt'), 'x\n')
    expect(await runTask('route', false)).toEqual([
      "[vx] app#route: inputs matched no files (src/[id].txt) — the key will not change when this project's source does — " +
        '[ starts a character class and src/[id].txt exists: write src/\\[id\\].txt to name it',
      '[vx] app#route: outputs matched no files (out/[slug]/**) — an empty artifact is saved; a later hit restores nothing — ' +
        '[ starts a character class and out/[slug] exists: write out/\\[slug\\]/** to name it',
    ])
    expect(await runTask('cls', false)).toEqual([
      "[vx] app#cls: inputs matched no files (lib/[ab].txt) — the key will not change when this project's source does",
      '[vx] app#cls: outputs matched no files (build/[ab]/**) — an empty artifact is saved; a later hit restores nothing',
    ])
  })

  it('matching globs and a deliberate empty output list say nothing (control)', async () => {
    expect(await runTask('found')).toEqual([])
    expect(await runTask('noop')).toEqual([])
  })
})
