#!/usr/bin/env -S bun --no-env-file --no-install
// `bunx @vzn/vx-migrate` — the adoption tool's own entry. Core's error
// classes are honoured the way `vx` honours them: a UserError is one line
// on stderr, anything else is a crash worth a stack.
//
// Only what every core release exports is imported before the release
// check: `bun x` keeps the @vzn/vx already in its install directory beside
// a newer vx-migrate (a peer range it does not enforce), and a static
// import of the mapper crashed on a missing export there (Growth,
// 2026-10-16).

import path from 'node:path'
import * as core from '@vzn/vx'
import { isUserError, UserError, VERSION } from '@vzn/vx'
import { ownVersion } from './adopt.js'

try {
  const own = ownVersion()
  if (own !== null && VERSION !== '0.0.0' && VERSION !== own) {
    const core = Bun.resolveSync('@vzn/vx', import.meta.dir)
    const at = core.lastIndexOf(`${path.sep}node_modules${path.sep}`)
    const modules = at === -1 ? path.dirname(core) : core.slice(0, at + '/node_modules'.length)
    throw new UserError(
      `vx-migrate ${own} loaded @vzn/vx ${VERSION} from ${modules}; every @vzn package releases together — install @vzn/vx@${own} there, or delete that node_modules and run it again`,
    )
  }
  const { migrateCmd } = await import('./migrate.js')
  process.exitCode = await migrateCmd(process.argv.slice(2))
} catch (err) {
  if (isUserError(err)) {
    // `ui` by namespace: a core older than it has none, and its refusal
    // still reaches the reader.
    const ui = (core as Partial<typeof core>).ui
    if (ui === undefined) process.stderr.write(`vx-migrate: ${err.message}\n`)
    else ui.say('error', `vx-migrate: ${err.message}`)
    process.exitCode = 1
  } else {
    throw err
  }
}
