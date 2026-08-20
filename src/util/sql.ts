/**
 * Escape a user-supplied string for use INSIDE a `LIKE` / `ILIKE` pattern.
 *
 * `%` and `_` are pattern metacharacters, so a term interpolated raw stops
 * meaning what the user typed: searching a workspace for `web_app` also
 * matched `webXapp`, and a bare `%` matched every row — a confident wrong
 * answer on the surface a dev uses to FIND things. Underscores are ordinary
 * in package names and tag values, so this is routine, not exotic.
 *
 * The escape character is a backslash, which callers MUST declare with
 * `ESCAPE '\'`: Postgres defaults to backslash but SQLite has no default at
 * all, so an undeclared `\%` there matches a literal backslash followed by
 * anything — the bug this function exists to remove, relocated.
 *
 * Escapes only; the caller still adds its own surrounding wildcards.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}
