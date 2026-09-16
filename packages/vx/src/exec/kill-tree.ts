// Signal a task and everything it forked. Every task child is spawned
// `detached` — its own session and process group — so the group IS the
// task's tree: the shell, what the shell backgrounded (`server &`), a
// test runner's workers. Signalling the child alone left all of that
// alive: a timed-out `sh -c "x & y"` killed the shell and orphaned `x`,
// and a Ctrl-C did the same for every compound command (2026-09-16). A
// group signal reaches a member whose parent already died, too — the
// group outlives its leader — so the order of death does not matter.
// What still escapes is a daemon that calls setsid itself (the residual
// every non-cgroup runner shares); under a sandbox the pid namespace
// takes even that.

export type Child = ReturnType<typeof Bun.spawn>

export function killTree(child: Child, signal: 'SIGTERM' | 'SIGKILL'): void {
  // A pid of 0 would name OUR group (kill(0)): a child that never
  // spawned has nothing to kill.
  if (!(child.pid > 0)) return
  try {
    process.kill(-child.pid, signal)
  } catch (err) {
    // ESRCH: the whole group is gone. Anything else (a group that is not
    // ours to signal): the child itself, as before.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return
    child.kill(signal)
  }
}
