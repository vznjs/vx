import type { Case } from '../src/spec.ts'
import affectedGit from './affected-git.ts'
import affectedMore from './affected-more.ts'
import affected from './affected.ts'
import { cacheKeys } from './cache-keys.ts'
import cache from './cache.ts'
import configGraph from './config-graph.ts'
import envCacheMore from './env-cache-more.ts'
import envRuntime from './env-runtime.ts'
import env from './env.ts'
import failureMore from './failure-more.ts'
import failureStop from './failure-stop.ts'
import failureTimeout from './failure-timeout.ts'
import failure from './failure.ts'
import gitInputs from './git-inputs.ts'
import gitRootProject from './git-root-project.ts'
import graphMore from './graph-more.ts'
import graphOnly from './graph-only.ts'
import graphPattern from './graph-pattern.ts'
import graphSelect from './graph-select.ts'
import graphShape from './graph-shape.ts'
import graph from './graph.ts'
import inputsAMore from './inputs-a-more.ts'
import inputsBMore from './inputs-b-more.ts'
import inputsGlobs from './inputs-globs.ts'
import inputsRoot from './inputs-root.ts'
import inputsRuns from './inputs-runs.ts'
import inputs from './inputs.ts'
import lockfileDeps from './lockfile-deps.ts'
import outputsBMore from './outputs-b-more.ts'
import outputsAMore from './outputs-a-more.ts'
import { outputsLinks } from './outputs-links.ts'
import { outputsRestore } from './outputs-restore.ts'
import { outputsShared } from './outputs-shared.ts'
import outputs from './outputs.ts'
import persistentReady from './persistent-ready.ts'
import persistentServers from './persistent-servers.ts'
import report from './report.ts'
import runModes from './run-modes.ts'
import sandbox from './sandbox.ts'

/** Every case, in the results' order. */
export const CASES: Case[] = [
  ...graph,
  ...graphShape,
  ...graphSelect,
  ...graphOnly,
  ...graphPattern,
  ...graphMore,
  ...gitRootProject,
  ...configGraph,
  ...inputs,
  ...inputsGlobs,
  ...inputsRoot,
  ...inputsRuns,
  ...inputsBMore,
  ...gitInputs,
  ...inputsAMore,
  ...outputs,
  ...outputsRestore,
  ...outputsLinks,
  ...outputsShared,
  ...outputsBMore,
  ...outputsAMore,
  ...env,
  ...envRuntime,
  ...lockfileDeps,
  ...cache,
  ...cacheKeys,
  ...envCacheMore,
  ...failure,
  ...failureStop,
  ...failureTimeout,
  ...failureMore,
  ...persistentServers,
  ...persistentReady,
  ...affected,
  ...affectedGit,
  ...affectedMore,
  ...runModes,
  ...report,
  ...sandbox,
]
