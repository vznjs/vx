/**
 * Every `.env`-shaped file under the probe's directory, name and bytes, in
 * a stable order. Git ignores them, so a glob over git's files keys none of
 * them; this is a superset of what a `.env` glob names, so an edit to one
 * misses and nothing else is lost (item 1032). node_modules and .git are
 * pruned.
 */
export const DOTENV_PROBE =
  'find . \\( -name node_modules -o -name .git \\) -prune -o -type f \\( -name \'.env*\' -o -name \'*.env\' \\) -print | LC_ALL=C sort | while IFS= read -r f; do echo "$f"; cat -- "$f"; echo; done'
