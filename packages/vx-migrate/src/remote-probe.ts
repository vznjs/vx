// `has([...])` over a wire whose existence call takes one key (Nx has
// none; a Turbo server may not offer the batch query): at most
// PROBE_CONCURRENCY requests fly at once, so a run's thousand keys open
// no thousand sockets.

const PROBE_CONCURRENCY = 8

/** The subset of `hashes` `one` answers true for, in order; a throw fails the whole answer. */
export async function heldEach(
  hashes: readonly string[],
  one: (hash: string) => Promise<boolean>,
): Promise<string[]> {
  const held: boolean[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < hashes.length) {
      const i = next++
      held[i] = await one(hashes[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, hashes.length) }, worker))
  return hashes.filter((_, i) => held[i] === true)
}
