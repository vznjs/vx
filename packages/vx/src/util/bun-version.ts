/**
 * The runtime floor. `package.json`'s `engines` states it, but `engines` is
 * advice an install may print and a run never reads: `bun src/bin.ts` on an
 * older Bun starts fine and then answers WRONGLY, which is the failure class
 * this repo treats as the worst one.
 *
 * Measured on Bun 1.3.11 (2026-09-19, STATUS item 366): a 2 MiB `--format
 * json` answer reached a pipe as 219 KB — `bin.ts` ends stdout in a callback
 * precisely to prevent that, and the fix does not hold below the floor; the
 * runner read no `peakRssBytes` at all, so `vx last` and `vx why` reported
 * nothing a task used; and a config syntax error arrived as a `BuildMessage`
 * the loader's classifier does not know, surfacing as an internal error
 * instead of the UserError naming file, line and column. Ten of that
 * container's twenty-three failures were this, and every one of them is a
 * green exit over a wrong answer.
 *
 * `@vzn/vx-reapi` REFUSES an old Bun at its wire, because its failure mode is
 * a hang and a hang leaves the user nothing to read. Core warns instead: most
 * of it works below the floor (23 of ~2,000 tests failed on 1.3.11), so
 * refusing would be heavier than the measurement supports. What the
 * measurement supports is that a green exit can hide a truncated answer, and
 * that is what the warning says.
 */
export const MIN_BUN = [1, 4, 0] as const

/** True when `version` is older than {@link MIN_BUN}. */
export function isUnsupportedBun(version: string): boolean {
  const [maj = 0, min = 0, patch = 0] = version.split('.').map((p) => Number.parseInt(p, 10) || 0)
  const [reqMaj, reqMin, reqPatch] = MIN_BUN
  if (maj !== reqMaj) return maj < reqMaj
  if (min !== reqMin) return min < reqMin
  return patch < reqPatch
}

/** The warning a CLI entry prints once, before the verb runs. */
export function unsupportedBunMessage(version: string): string {
  return (
    `vx needs Bun >= ${MIN_BUN.join('.')} (running ${version}). ` +
    `An older Bun does not fail — it answers wrongly: a large \`--format json\` ` +
    `answer is truncated mid-write, no task reports what it used, and a config ` +
    `syntax error surfaces as an internal error. Upgrade with \`bun upgrade\`.`
  )
}
