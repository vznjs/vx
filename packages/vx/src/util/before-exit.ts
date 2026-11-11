// Work a verb starts off its own path and the process finishes before it
// exits: bin.ts's exit would cut it, leaving a half-written temp dir.

const pending: (() => Promise<void>)[] = []

/** `work` runs (or is awaited) once the verb has answered, before the process exits. */
export function beforeExit(work: () => Promise<void>): void {
  pending.push(work)
}

/** Every `beforeExit` work, settled; one that queues more is waited for too. Never throws. */
export async function settleBeforeExit(): Promise<void> {
  while (pending.length > 0) {
    await Promise.allSettled(pending.splice(0).map((work) => work()))
  }
}
