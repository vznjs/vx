import type { Case } from '../src/spec.ts'
import affectedGit from './affected-git.ts'
import affectedMore from './affected-more.ts'
import affectedTasks from './affected-tasks.ts'
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
import moonTests from './moon-tests.ts'
import nixFunctional from './nix-functional.ts'
import nixSandbox from './nix-sandbox.ts'
import nixShell from './nix-shell.ts'
import outputsBMore from './outputs-b-more.ts'
import outputsAMore from './outputs-a-more.ts'
import { outputsLinks } from './outputs-links.ts'
import { outputsRestore } from './outputs-restore.ts'
import { outputsShared } from './outputs-shared.ts'
import outputs from './outputs.ts'
import persistentReady from './persistent-ready.ts'
import persistentServers from './persistent-servers.ts'
import hardeningFixes from './hardening-fixes.ts'
import recentFixes from './recent-fixes.ts'
import report from './report.ts'
import runGuards from './run-guards.ts'
import runModes from './run-modes.ts'
import sandbox from './sandbox.ts'
import viteTaskE2eA from './vite-task-e2e-a.ts'
import viteTaskE2eB from './vite-task-e2e-b.ts'
import vitePlanA from './vite-task-plan-a.ts'
import vitePlanB from './vite-task-plan-b.ts'
import rivalShell from './rival-shell.ts'
import rivalTurbo from './rival-turbo.ts'
import rivalKeys from './rival-keys.ts'
import rivalShapes from './rival-shapes.ts'
import rivalConfig from './rival-config.ts'
import rivalGlobs from './rival-globs.ts'
import rivalModes from './rival-modes.ts'
import rivalReport from './rival-report.ts'
import rivalDiscovery from './rival-discovery.ts'
import minedSandbox from './mined-sandbox.ts'
import minedReport from './mined-report.ts'
import minedConfig from './mined-config.ts'
import minedPipeline from './mined-pipeline.ts'
import minedWatch from './mined-watch.ts'
import minedAffected from './mined-affected.ts'
import minedSelect from './mined-select.ts'
import minedEnv from './mined-env.ts'
import minedInputs from './mined-inputs.ts'
import minedLifecycle from './mined-lifecycle.ts'
import minedVitenix from './mined-vitenix.ts'
import minedMoon2 from './mined-moon2.ts'
import minedIssues from './mined-issues.ts'
import minedTurboRs from './mined-turbo-rs.ts'
import minedNxE2e from './mined-nx-e2e.ts'
import minedNxFixes from './mined-nx-fixes.ts'
import minedViteCrates from './mined-vite-crates.ts'
import minedNixFunc2 from './mined-nix-func2.ts'
import minedIssues2 from './mined-issues2.ts'
import minedMoonVt from './mined-moon-vt.ts'
import watch from './watch.ts'

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
  ...vitePlanB,
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
  ...affectedTasks,
  ...runModes,
  ...runGuards,
  ...report,
  ...sandbox,
  ...watch,
  ...viteTaskE2eA,
  ...viteTaskE2eB,
  ...vitePlanA,
  ...nixFunctional,
  ...nixSandbox,
  ...nixShell,
  ...moonTests,
  ...recentFixes,
  ...hardeningFixes,
  ...rivalShell,
  ...rivalTurbo,
  ...rivalKeys,
  ...rivalShapes,
  ...rivalConfig,
  ...rivalGlobs,
  ...rivalModes,
  ...rivalReport,
  ...rivalDiscovery,
  ...minedSandbox,
  ...minedReport,
  ...minedConfig,
  ...minedPipeline,
  ...minedWatch,
  ...minedAffected,
  ...minedSelect,
  ...minedEnv,
  ...minedInputs,
  ...minedLifecycle,
  ...minedVitenix,
  ...minedMoon2,
  ...minedIssues,
  ...minedTurboRs,
  ...minedNxE2e,
  ...minedNxFixes,
  ...minedViteCrates,
  ...minedNixFunc2,
  ...minedIssues2,
  ...minedMoonVt,
]
