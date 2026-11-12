// Which paths a clean filter can rewrite, as git's attributes say: the
// key's trust in an index OID (cache/git-inputs.ts `dropFilteredOids`) and
// `--affected`'s reading of a hashed path (workspace/affected.ts) ask alike.

/**
 * `--all`, not the converting attributes by name: named, git prints each of
 * them for every path, `unspecified` included, so the answer grew with the
 * listing (vueuse's `* text=auto eol=lf`: 1,583 files, 473 KB, ~5 ms of the
 * main thread to decode and split every run). `--all` prints only what a
 * rule sets: 160 KB there, and next to nothing where a rule names a few
 * files. Paths go on stdin, each ending in `\0`.
 */
export const CHECK_ATTR = ['check-attr', '--stdin', '-z', '--all']

/**
 * Parse `CHECK_ATTR` output — a flat stream of `<path>\0<attr>\0<value>\0`
 * triples — into the set of paths where a clean filter can rewrite bytes:
 * a converting attribute (`CONVERTS`) that is neither `unset` (`-text`),
 * which leaves the index blob byte-identical to the worktree file, nor
 * `unspecified`, which only a named query prints. `--all` also prints what
 * converts nothing (`diff`, `linguist-generated`). `lineEndings` false
 * leaves out the paths only `text` / `eol` / `crlf` name: a caller that
 * holds each blob to its file's size needs no more there (`LINE_ENDINGS`).
 */
export function parseCheckAttrOutput(out: string, lineEndings = true): Set<string> {
  const affected = new Set<string>()
  const fields = out.split('\0')
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const attr = fields[i + 1]!
    const value = fields[i + 2]
    if (
      (REWRITES.has(attr) || (lineEndings && LINE_ENDINGS.has(attr))) &&
      value !== 'unset' &&
      value !== 'unspecified'
    )
      affected.add(fields[i]!)
  }
  return affected
}

/**
 * The attributes whose conversion only removes a CR before an LF on the way
 * in and adds it on the way out, so a blob the size of its file is that
 * file's bytes. `crlf` is the legacy spelling git still reads as `text` or
 * `eol=lf`.
 */
const LINE_ENDINGS = new Set(['text', 'eol', 'crlf'])
/** The ones that can keep a size and change the bytes. */
const REWRITES = new Set(['ident', 'filter', 'working-tree-encoding'])
