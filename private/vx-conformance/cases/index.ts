import type { Case } from '../src/spec.ts'
import affected from './affected.ts'
import cache from './cache.ts'
import env from './env.ts'
import failure from './failure.ts'
import graph from './graph.ts'
import inputs from './inputs.ts'
import outputs from './outputs.ts'
import report from './report.ts'

/** Every case, in the report's order. */
export const CASES: Case[] = [
  ...graph,
  ...inputs,
  ...outputs,
  ...env,
  ...cache,
  ...failure,
  ...affected,
  ...report,
]
