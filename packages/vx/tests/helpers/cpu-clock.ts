// A complexity guard timed by the wall fails on a crowded CI worker: a run
// waiting for a core still counts. This process's CPU time does not: a
// planRun that took 0.5 s alone took 6.6 s of wall on a worker booked 3.7
// of 4 cores (PR #4169), and its CPU time stays what the work costs.

/** Starts a clock of this process's CPU time; the function reads it in ms. */
export function cpuClock(): () => number {
  const start = process.cpuUsage()
  return () => {
    const { user, system } = process.cpuUsage(start)
    return (user + system) / 1000
  }
}
