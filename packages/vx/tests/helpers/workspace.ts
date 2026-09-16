// The workspace fixture, defined ONCE. Forty test files carried a private
// copy of the same scaffold — mkdtemp, `pnpm-workspace.yaml`, a root
// package.json, the local workspace file, a quiet git repo — and the
// copies had started to disagree in load-bearing ways (one swallowed a
// git failure, two shared a mkdtemp prefix, one skipped the workspace
// file). A test whose deviation IS the test (a git shim on PATH, a
// workspace root inside a git subdirectory, a 6,000-package generator)
// keeps its own; the rest use this.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeLocalWorkspace } from './local-workspace.js'

export interface WorkspaceOptions {
  /** mkdtemp prefix; name the suite so a leaked directory says who left it. */
  prefix?: string
  /** Where mkdtemp creates it (default `os.tmpdir()`): a test that needs the fixture on a particular file system names it. */
  dir?: string
  /** The root package.json `name`. */
  rootName?: string
  /** Write `vx.workspace.mjs` (no plugins). Default true. */
  workspaceFile?: boolean
  /**
   * Git: `'init'` (default) inits a quiet repo with a test identity — vx
   * asks git for the input file set, nothing more; `'commit'` also stages
   * and commits everything written so far (a test that needs tracked-clean
   * files, i.e. blob-OID keys); `false` writes no repo.
   */
  git?: 'init' | 'commit' | false
}

/** A runner for git in `cwd` that throws on failure; signing is off. */
export function gitIn(cwd: string): (...args: string[]) => string {
  return (...args) => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
    return new TextDecoder().decode(p.stdout)
  }
}

/** `git init` with a test identity, so a later commit needs no flags. */
export function gitInit(cwd: string): void {
  const git = gitIn(cwd)
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
}

/** Init, stage everything, commit: every file written so far is tracked-clean. */
export function gitInitCommit(cwd: string, message = 'init'): void {
  gitInit(cwd)
  const git = gitIn(cwd)
  git('add', '-A')
  git('commit', '-q', '-m', message)
}

/** A pnpm-style workspace root with `packages/*`; returns the root. */
export async function makeWorkspace(opts: WorkspaceOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(opts.dir ?? os.tmpdir(), opts.prefix ?? 'vx-ws-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: opts.rootName ?? 'fixture-root', private: true }, null, 2),
  )
  if (opts.workspaceFile !== false) await writeLocalWorkspace(root)
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = opts.git ?? 'init'
  if (git === 'init') gitInit(root)
  else if (git === 'commit') gitInitCommit(root)
  return root
}

export interface ProjectSpec {
  /** `vx.config.mjs` source; omitted → a package with no config file. */
  config?: string
  deps?: Record<string, string>
  devDeps?: Record<string, string>
  /** Files relative to the project directory, written after the config. */
  files?: Record<string, string>
}

/**
 * `packages/<name>` with a package.json and, given one, a config; returns
 * the directory. A scoped name (`@scope/pkg`) lands in `packages/scope-pkg`.
 */
export async function addProject(
  root: string,
  name: string,
  spec: string | ProjectSpec = {},
): Promise<string> {
  const s: ProjectSpec = typeof spec === 'string' ? { config: spec } : spec
  const dir = path.join(root, 'packages', name.replace('@', '').replace('/', '-'))
  await mkdir(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: '0.0.0' }
  if (s.deps && Object.keys(s.deps).length > 0) pkg['dependencies'] = s.deps
  if (s.devDeps && Object.keys(s.devDeps).length > 0) pkg['devDependencies'] = s.devDeps
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  if (s.config !== undefined) await writeFile(path.join(dir, 'vx.config.mjs'), s.config)
  for (const [rel, content] of Object.entries(s.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}
