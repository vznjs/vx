// Nx's per-task `.env` loading for the two bins that run Nx targets —
// `nx-exec` (an executor, in its own process) and `nx-env` (a shell line) —
// through Nx's own `loadAndExpandDotEnvFile` / `unloadDotEnvFile`
// (tasks-runner/task-env.ts), so the parsing, `${VAR}` expansion and
// precedence are the workspace's Nx version's, not a copy's.
//
// Which files: the mapper lists the ones that exist, in Nx's order
// (`getEnvPathsForTask`), relative to the task's working directory. What
// Nx does with them: the first file to define a name wins, and a name the
// environment already holds wins over every file — which under vx is the
// isolated task env, so the target's `env` (exec.env.define) stays on top
// as in Nx. Nx first UNLOADS the root files it loaded into its own process
// at start-up; nothing loaded them here, so there is nothing to unload.

'use strict'

const path = require('node:path')

/**
 * Loads `files` into `env`, then run-commands' `envFile`, which Nx loads
 * over the result the same way (a name already set wins) and whose
 * unreadable file fails the task.
 */
function loadTaskEnv(nx, env, files, envFile) {
  if (files.length === 0 && envFile === undefined) return
  const { loadAndExpandDotEnvFile, unloadDotEnvFile } = nx('nx/src/tasks-runner/task-env')
  if (files.length > 0) {
    loadAndExpandDotEnvFile(
      files.map((f) => path.resolve(f)),
      env,
    )
  }
  if (envFile !== undefined) {
    const file = path.resolve(envFile)
    unloadDotEnvFile(file, env)
    const result = loadAndExpandDotEnvFile(file, env)
    if (result && result.error) throw result.error
  }
}

module.exports = { loadTaskEnv }
