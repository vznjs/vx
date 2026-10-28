// The `output` capability: a plugin may take the terminal for a run. Sibling
// to telemetry-host.ts. With no plugin declaring the hook nothing here runs,
// and core's renderer is the run's, byte for byte.

import { terminalSubscriber, type RunEventSubscriber } from '../report/index.js'
import type { Logger } from '../report/index.js'
import { settleWithin, teardownTimeoutMs, thrownMessage } from '../util/index.js'
import type { OutputContext, VxPlugin } from './plugin.js'

const REQUIRED = ['status', 'taskStdout', 'taskStderr', 'taskComplete'] as const
const OPTIONAL = [
  'warn',
  'runStart',
  'taskStart',
  'runEnd',
  'stepStart',
  'stepEnd',
  'runStop',
  'runDone',
] as const

/** Reject anything that is not Logger-shaped, naming what is missing. */
function checkLogger(value: unknown): Logger {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`output must be a Logger object, got ${value === null ? 'null' : typeof value}`)
  }
  const o = value as Record<string, unknown>
  const missing = REQUIRED.filter((k) => typeof o[k] !== 'function')
  if (missing.length > 0) throw new Error(`output Logger has no ${missing.join(', ')}`)
  const wrong = OPTIONAL.filter((k) => o[k] !== undefined && typeof o[k] !== 'function')
  if (wrong.length > 0)
    throw new Error(
      `output Logger's ${wrong.join(', ')} must be ${wrong.length === 1 ? 'a function' : 'functions'}`,
    )
  return value as Logger
}

/**
 * The first plugin, in declaration order, whose `output` returns a Logger.
 * A hook that throws or returns something else is warned about and passed
 * over: a renderer must never fail a run.
 */
export async function claimOutput(
  plugins: readonly VxPlugin[],
  ctx: OutputContext,
): Promise<{ logger: Logger; owner: string } | undefined> {
  for (const plugin of plugins) {
    if (plugin.output === undefined) continue
    try {
      // Bounded as the telemetry hook is: one that never settled held the
      // run before its first task, for good.
      let logger: Logger | undefined
      const ms = teardownTimeoutMs()
      const arrived = await settleWithin(
        Promise.resolve(plugin.output(ctx)).then((l) => {
          logger = l
        }),
        ms,
      )
      if (!arrived) throw new Error(`did not answer within ${ms} ms`)
      if (logger !== undefined) return { logger: checkLogger(logger), owner: plugin.name }
    } catch (err) {
      ctx.warn(`[vx] plugin '${plugin.name}' output: ${thrownMessage(err)}; vx renders the run`)
    }
  }
  return undefined
}

/**
 * The bus subscriber for a plugin's Logger. The first throw hands that
 * event and every later one to `fallback` (core's renderer), after one
 * status line naming the plugin.
 */
export function guardedOutput(
  claimed: { logger: Logger; owner: string },
  fallback: RunEventSubscriber,
): RunEventSubscriber {
  const render = terminalSubscriber(claimed.logger)
  let failed = false
  return (event) => {
    if (failed) return fallback(event)
    try {
      render(event)
    } catch (err) {
      failed = true
      fallback({
        kind: 'run:status',
        warn: true,
        line: `[vx] plugin '${claimed.owner}' output failed: ${thrownMessage(err)}; vx renders the rest of the run`,
      })
      fallback(event)
    }
  }
}
