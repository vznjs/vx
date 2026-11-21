// Every opt-in Turbo ships that changes what a run selects, keys or
// reports. `filterUsingTasks` costs Turbo its package-graph `--filter`
// walks; the cases score that as Turbo's, since vx selects both ways.
// Every turbo.json vx runs Turbo on (conformance, the site's bench) sets
// exactly these, so a score and a timing describe the same Turbo.
export const TURBO_FUTURE_FLAGS = {
  affectedUsingTaskInputs: true,
  filterUsingTasks: true,
  strictTaskEntrypointSelection: true,
  experimentalTaskCommand: true,
  githubActionsRemoteBaseRefFallback: true,
  experimentalObservability: true,
  watchUsingTaskInputs: true,
}
