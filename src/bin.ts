#!/usr/bin/env bun
import path from 'node:path'
import { resolveCommand } from 'package-manager-detector/commands'
import { run } from './cli.js'
import { UserError } from './util/errors.js'
import { detectPackageManager } from './workspace/package-manager.ts'

const DEP_FIELDS = ['dependencies', 'devDependencies'] as const
type PkgJson = Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>

/**
 * Walk up from `cwd` looking for a `package.json` that declares
 * `@vzn/vx` as a `dependencies` or `devDependencies` entry. Returns
 * that package.json's directory, or `null` if none found before the
 * filesystem root. `peerDependencies` doesn't count — it signals
 * "the host should provide this," not "I have a local install".
 */
async function findProjectDeclaringVx(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd)
  while (true) {
    const pkgPath = path.join(dir, 'package.json')
    const file = Bun.file(pkgPath)
    if (await file.exists()) {
      try {
        const pkg = (await file.json()) as PkgJson
        for (const field of DEP_FIELDS) {
          const deps = pkg[field]
          if (deps && '@vzn/vx' in deps) return dir
        }
      } catch {
        // Malformed package.json — ignore, keep walking.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * If a local `@vzn/vx` is declared in the project's package.json,
 * delegate to it via the detected package manager's `execute-local`
 * command (`bun x vx`, `pnpm exec vx`, `npm exec -- vx`, …). The PM
 * handles bin resolution per its own layout — npm-hoisted,
 * pnpm-isolated, yarn-PnP, Bun — without us having to guess where
 * the bin shim lives. `VX_NESTED=1` prevents infinite recursion when
 * the local vx re-enters this code path.
 *
 * Returns the delegated exit code, or `null` if we did not delegate
 * (run normally).
 */
async function tryDelegateToLocal(argv: string[]): Promise<number | null> {
  if (process.env['VX_NESTED'] === '1') return null

  const pkgDir = await findProjectDeclaringVx(process.cwd())
  if (!pkgDir) return null

  const pm = await detectPackageManager(pkgDir)
  if (!pm) return null

  const resolved = resolveCommand(pm.agent, 'execute-local', ['vx', ...argv])
  if (!resolved) return null

  const proc = Bun.spawnSync({
    cmd: [resolved.command, ...resolved.args],
    cwd: process.cwd(),
    env: { ...process.env, VX_NESTED: '1' },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return proc.exitCode ?? 1
}

async function main(): Promise<never> {
  const argv = process.argv.slice(2)

  const delegatedCode = await tryDelegateToLocal(argv)
  if (delegatedCode !== null) process.exit(delegatedCode)

  try {
    process.exit(await run(argv))
  } catch (err) {
    // UserError (workspace not found, cycle, config invalid, ...) —
    // print the message only; the stack is noise the user can't act
    // on. Everything else gets the full stack so internal bugs are
    // debuggable.
    if (err instanceof UserError) {
      process.stderr.write(`vx: ${err.message}\n`)
    } else {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
      process.stderr.write(`vx: ${message}\n`)
    }
    process.exit(1)
  }
}

await main()
