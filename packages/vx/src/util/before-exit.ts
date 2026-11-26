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

// A run stranded by a hook that never settles: the loop drains with the
// verb still pending, and bin.ts ends the process from `beforeExit`. What
// the run owes on every exit (its plugins' teardown) is paid there, and
// the hook is named. Item 921 said only "a plugin hook?".
const pendingHooks = new Set<readonly [plugin: string, hook: string]>()
const owed = new Set<() => Promise<void>>()

/** Marks `plugin`'s `hook` as awaited; the returned call marks it settled. */
export function hookStarted(plugin: string, hook: string): () => void {
  const entry = [plugin, hook] as const
  pendingHooks.add(entry)
  return () => void pendingHooks.delete(entry)
}

/**
 * Each hook still awaited, once: `plugin 'p' never settled its h hook`, or
 * `its command 'v'` for a plugin verb.
 */
export function unsettledHooks(): string[] {
  return [
    ...new Set(
      [...pendingHooks].map(
        ([p, h]) => `plugin '${p}' never settled its ${h.startsWith('command ') ? h : `${h} hook`}`,
      ),
    ),
  ]
}

/**
 * The stage hooks still awaited, each once (`plugin 'p' (key)`), for a stop:
 * a task's `execute` and a remote cache call are its work in flight, bounded
 * on their own, so a stop mid-task names none of them.
 */
export function awaitedStageHooks(): string[] {
  const out = new Set<string>()
  for (const [p, h] of pendingHooks)
    if (h !== 'execute' && !h.startsWith('cache ') && !h.startsWith('command '))
      out.add(`plugin '${p}' (${h})`)
  return [...out]
}

/** `work` runs if the process is stranded before the returned call withdraws it. */
export function owedIfStranded(work: () => Promise<void>): () => void {
  owed.add(work)
  return () => void owed.delete(work)
}

/** Every owed work, settled; never throws. */
export async function settleStranded(): Promise<void> {
  const works = [...owed]
  owed.clear()
  await Promise.allSettled(works.map((work) => work()))
}
