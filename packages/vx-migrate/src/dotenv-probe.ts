import { shellQuote } from './nx-command.js'

/**
 * Every `.env`-shaped file under the probe's directory, name and bytes, in
 * a stable order. Git ignores them, so a glob over git's files keys none of
 * them; this is a superset of what a `.env` glob names, so an edit to one
 * misses and nothing else is lost (item 1032). node_modules and .git are
 * pruned.
 */
export const DOTENV_PROBE =
  'find . \\( -name node_modules -o -name .git \\) -prune -o -type f \\( -name \'.env*\' -o -name \'*.env\' \\) -print | LC_ALL=C sort | while IFS= read -r f; do echo "$f"; cat -- "$f"; echo; done'

/**
 * The same for a package whose `.env` globs all sit at its root (`.env*`,
 * create-turbo's default): the files named `.env…` or `…env` there, by the
 * shell's own globbing. `DOTENV_PROBE` is three processes and walks the
 * package; this is one shell, 1.2 ms against 3.3 (kitchen-sink's warm run
 * spent ~45 ms of ~145 in probes). `LC_ALL=C` keeps the glob order, and so
 * the key, the same on every machine.
 */
export const DOTENV_PROBE_TOP =
  'LC_ALL=C; export LC_ALL; for f in .env* .*.env *.env; do [ -f "$f" ] && { printf \'%s\\n\' "$f"; cat -- "$f"; echo; }; done; :'

/**
 * The named root-relative files, name and bytes, run at the workspace root:
 * the inputs a turbo.json names by path that git ignores
 * (`config.local.json`), which Turbo hashes and a glob over git's files
 * keys nothing of. Core trims a probe's output, so each file ends on a `.`:
 * a trailing newline added to the last one is still an edit.
 */
export function ignoredFilesProbe(rels: readonly string[]): string {
  return `for f in ${rels.map(shellQuote).join(' ')}; do [ -f "$f" ] && { printf '%s\\n' "$f"; cat -- "$f"; echo .; }; done; :`
}
